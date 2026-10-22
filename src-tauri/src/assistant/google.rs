//! Google access for the morning routine (phase 2): the user's own Desktop OAuth
//! client and one consent for two scopes. `drive.readonly` reads and exports the
//! invoice sheet; `drive.file` creates files and changes only the ones Duck made.
//! Together they can't write to the original sheet, so that guarantee is the
//! credential's, before any check in [`super::sheets`]. `drive` and `spreadsheets`
//! are never asked for.
//!
//! Sign-in is the installed-app flow: a one-shot listener on a loopback port is the
//! redirect URI, PKCE (S256) guards the code, and the user's browser does the
//! consent. The refresh token goes to Credential Manager ([`super::key`]); access
//! tokens are held in memory until a minute before they expire. A refresh Google
//! answers `invalid_grant` (access revoked, unused for months, or a "Testing" app's
//! 7 days up) forgets the token and fails with [`EXPIRED`], which the briefing
//! passes on.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{key, Assistant};

pub const SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
];
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
/// How long the browser has for the consent.
const CONSENT_WAIT: Duration = Duration::from_secs(300);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// What a call fails with once the refresh token is dead. The webview recognizes
/// the `google_expired:` prefix.
pub const EXPIRED: &str = "google_expired: Google access expired, reconnect in Duck's settings";

/// What a call fails with for a 404: a file that's gone, or that the account can't open.
pub const NOT_FOUND: &str = "Google can't find that file: check its id, and that the connected account can open it";

/// Tauri-managed: the access token in use.
#[derive(Default)]
pub struct GoogleAuth {
    access: Mutex<Option<Access>>,
}

struct Access {
    client_id: String,
    token: String,
    until: Instant,
}

impl GoogleAuth {
    fn keep(&self, client_id: &str, v: &Value) -> Option<String> {
        let token = v.get("access_token")?.as_str()?.to_string();
        let secs = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        *self.access.lock().unwrap() = Some(Access {
            client_id: client_id.to_string(),
            token: token.clone(),
            until: Instant::now() + Duration::from_secs(secs.saturating_sub(60)),
        });
        Some(token)
    }

    fn forget(&self) {
        *self.access.lock().unwrap() = None;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    connected: bool,
    /// Whether the client's secret is stored, and the credential it goes in.
    secret_stored: bool,
    secret_target: &'static str,
}

fn status() -> GoogleStatus {
    GoogleStatus {
        connected: key::google_token().is_some(),
        secret_stored: key::google_secret().is_some(),
        secret_target: key::GOOGLE_SECRET,
    }
}

/// Whether Google is connected. Never returns a token.
#[tauri::command]
pub fn assistant_google_status() -> GoogleStatus {
    status()
}

/// Sign in: open the consent in the browser, wait for its redirect to a loopback
/// port, trade the code for tokens, and keep the refresh token.
#[tauri::command]
pub async fn assistant_google_connect(
    app: AppHandle,
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
    client_id: String,
) -> Result<GoogleStatus, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("set the OAuth client id first".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("opening a loopback port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_b64(32);
    let state = random_b64(16);
    app.opener()
        .open_url(auth_url(&client_id, &redirect, &challenge(&verifier), &state), None::<&str>)
        .map_err(|e| format!("opening the browser: {e}"))?;
    let code = tokio::time::timeout(CONSENT_WAIT, wait_for_code(&listener, &state))
        .await
        .map_err(|_| "the browser didn't come back within 5 minutes".to_string())??;
    drop(listener);

    let secret = key::google_secret();
    let mut form = vec![
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect.as_str()),
    ];
    if let Some(s) = &secret {
        form.push(("client_secret", s));
    }
    let v = token_call(&ctx.client, &form).await.map_err(TokenFail::text)?;
    let granted = v.get("scope").and_then(Value::as_str).unwrap_or("");
    if let Some(missing) = missing_scope(granted) {
        return Err(format!(
            "Google didn't grant {missing}: connect again and leave both permissions ticked"
        ));
    }
    let refresh = v.get("refresh_token").and_then(Value::as_str).ok_or(
        "Google sent no refresh token: remove Duck at myaccount.google.com/permissions and connect again",
    )?;
    key::set_google_token(refresh)?;
    auth.keep(&client_id, &v);
    Ok(status())
}

/// Sign out: revoke the token at Google (best effort) and forget it here.
#[tauri::command]
pub async fn assistant_google_disconnect(
    ctx: State<'_, Arc<Assistant>>,
    auth: State<'_, GoogleAuth>,
) -> Result<GoogleStatus, String> {
    if let Some(t) = key::google_token() {
        let _ = ctx
            .client
            .post(REVOKE_URL)
            .timeout(CALL_TIMEOUT)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form_body(&[("token", &t)]))
            .send()
            .await;
    }
    auth.forget();
    key::clear_google_token()?;
    Ok(status())
}

/// An access token for `client_id`: the one in memory, else a fresh one from the
/// refresh token.
async fn access_token(client: &reqwest::Client, auth: &GoogleAuth, client_id: &str) -> Result<String, String> {
    if let Some(a) = auth.access.lock().unwrap().as_ref() {
        if a.client_id == client_id && a.until > Instant::now() {
            return Ok(a.token.clone());
        }
    }
    let refresh = key::google_token().ok_or("Google isn't connected (Duck's settings, morning)")?;
    let secret = key::google_secret();
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if let Some(s) = &secret {
        form.push(("client_secret", s));
    }
    match token_call(client, &form).await {
        Ok(v) => auth.keep(client_id, &v).ok_or_else(|| "Google's token reply had no access token".into()),
        Err(TokenFail::InvalidGrant) => {
            auth.forget();
            let _ = key::clear_google_token();
            Err(EXPIRED.into())
        }
        Err(e) => Err(e.text()),
    }
}

/// A request body and its content type.
pub type Body = (String, Vec<u8>);

/// Call a Google API URL with the access token; the reply's body. A 401 drops the
/// token in memory and tries once more with a fresh one. The scopes keep every
/// write to files Duck made.
pub async fn send(
    client: &reqwest::Client,
    auth: &GoogleAuth,
    client_id: &str,
    method: reqwest::Method,
    url: &str,
    body: Option<&Body>,
) -> Result<Vec<u8>, String> {
    for attempt in 0..2 {
        let token = access_token(client, auth, client_id).await?;
        let mut req = client.request(method.clone(), url).timeout(CALL_TIMEOUT).bearer_auth(&token);
        if let Some((kind, bytes)) = body {
            req = req.header("Content-Type", kind.as_str()).body(bytes.clone());
        }
        let resp = req
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "Google didn't answer in time".into() } else { format!("calling Google failed: {e}") })?;
        let status = resp.status();
        let body = resp.bytes().await.map_err(|e| format!("reading Google's reply failed: {e}"))?;
        if status.is_success() {
            return Ok(body.to_vec());
        }
        if status.as_u16() == 401 && attempt == 0 {
            auth.forget();
            continue;
        }
        return Err(api_error(status.as_u16(), &body));
    }
    Err("Google keeps refusing the token: reconnect in Duck's settings".into())
}

/// Google's error reply in a sentence.
fn api_error(status: u16, body: &[u8]) -> String {
    let msg = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string));
    match (status, msg) {
        (404, _) => NOT_FOUND.into(),
        (_, Some(m)) => format!("Google refused ({status}): {m}"),
        (_, None) => format!("Google answered {status}"),
    }
}

enum TokenFail {
    InvalidGrant,
    Other(String),
}

impl TokenFail {
    fn text(self) -> String {
        match self {
            TokenFail::InvalidGrant => EXPIRED.into(),
            TokenFail::Other(s) => s,
        }
    }
}

async fn token_call(client: &reqwest::Client, form: &[(&str, &str)]) -> Result<Value, TokenFail> {
    let resp = client
        .post(TOKEN_URL)
        .timeout(CALL_TIMEOUT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(form))
        .send()
        .await
        .map_err(|e| TokenFail::Other(format!("reaching Google failed: {e}")))?;
    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if ok {
        return Ok(v);
    }
    match v.get("error").and_then(Value::as_str) {
        Some("invalid_grant") => Err(TokenFail::InvalidGrant),
        Some("invalid_client") | Some("unauthorized_client") => Err(TokenFail::Other(format!(
            "Google rejected the OAuth client: check its id, and if it has a secret, store it with \
             cmdkey /generic:{} /user:duck /pass:<secret>",
            key::GOOGLE_SECRET
        ))),
        Some(e) => {
            let d = v.get("error_description").and_then(Value::as_str).unwrap_or("");
            Err(TokenFail::Other(format!("Google refused the sign-in: {e} {d}").trim().to_string()))
        }
        None => Err(TokenFail::Other("Google's token endpoint failed".into())),
    }
}

/// Answer the browser's requests until one carries the consent's outcome: the
/// code, or the error the user or Google gave.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        while n < buf.len() {
            match sock.read(&mut buf[n..]).await {
                Ok(0) | Err(_) => break,
                Ok(k) => n += k,
            }
            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..n]);
        let outcome = callback(head.lines().next().unwrap_or(""), state);
        let (code, page) = match &outcome {
            None => (404, "Not found."),
            Some(Ok(_)) => (200, "Duck is connected to Google. You can close this tab."),
            Some(Err(_)) => (200, "Duck wasn't connected to Google. You can close this tab."),
        };
        let reply = format!(
            "HTTP/1.1 {code} OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
             <!doctype html><meta charset=utf-8><title>Duck</title><p style=\"font:16px system-ui;margin:2em\">{page}</p>"
        );
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(r) = outcome {
            return r;
        }
    }
}

/// The outcome in a request line (`GET /?code=…&state=… HTTP/1.1`); `None` for a
/// request that isn't the redirect (a favicon, say).
fn callback(request_line: &str, state: &str) -> Option<Result<String, String>> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    let param = |name: &str| {
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| pct_decode(v))
    };
    if let Some(e) = param("error") {
        return Some(Err(if e == "access_denied" {
            "the Google sign-in was cancelled".into()
        } else {
            format!("Google refused the sign-in: {e}")
        }));
    }
    let code = param("code")?;
    if param("state").as_deref() != Some(state) {
        return Some(Err("the sign-in's reply didn't match its request: try again".into()));
    }
    Some(Ok(code))
}

fn missing_scope(granted: &str) -> Option<&'static str> {
    let got: Vec<&str> = granted.split_whitespace().collect();
    SCOPES.into_iter().find(|s| !got.contains(s))
}

fn auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    let scope = SCOPES.join(" ");
    format!(
        "{AUTH_URL}?{}",
        form_body(&[
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", &scope),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ])
    )
}

fn random_b64(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE's S256 challenge for `verifier`.
fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Percent-encode everything but RFC 3986's unreserved characters.
pub fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => match s
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()))
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(v) => {
                    out.push(v);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn form_body(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", pct(k), pct(v))).collect::<Vec<_>>().join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc_7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn encodes_and_decodes() {
        assert_eq!(form_body(&[("a b", "x/y&z"), ("s", "é")]), "a%20b=x%2Fy%26z&s=%C3%A9");
        assert_eq!(pct_decode("4%2F0Ab-x+y%zz%4"), "4/0Ab-x y%zz%4");
    }

    #[test]
    fn reads_the_redirect() {
        let ok = callback("GET /?state=s1&code=4%2Fabc&scope=x HTTP/1.1", "s1");
        assert_eq!(ok, Some(Ok("4/abc".into())));
        assert!(matches!(callback("GET /?code=c&state=other HTTP/1.1", "s1"), Some(Err(_))));
        assert_eq!(
            callback("GET /?error=access_denied&state=s1 HTTP/1.1", "s1"),
            Some(Err("the Google sign-in was cancelled".into()))
        );
        assert_eq!(callback("GET /favicon.ico HTTP/1.1", "s1"), None);
        assert_eq!(callback("", "s1"), None);
    }

    #[test]
    fn both_scopes_must_be_granted() {
        assert_eq!(missing_scope(&SCOPES.join(" ")), None);
        assert_eq!(missing_scope(SCOPES[1]), Some(SCOPES[0]));
        assert!(auth_url("id", "http://127.0.0.1:1", "c", "s").contains("access_type=offline"));
    }
}
