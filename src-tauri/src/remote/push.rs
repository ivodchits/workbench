//! Web Push to the phone (step R6): a needs-you reaches a paired phone with the
//! page closed and the screen locked.
//!
//! - **Keys.** A VAPID key pair (P-256) is made on first use and kept in `meta`
//!   (`push_vapid_private`, the scalar as base64url). The phone subscribes with its
//!   public half, and every push is signed with it (an ES256 JWT, RFC 8292).
//! - **Subscriptions.** One per paired device (`push_subscriptions`), made from the
//!   phone after it is allowed; dropped when the device is unpaired, and when the
//!   push service says the subscription is gone (404 / 410). A device can mute its
//!   pushes without unsubscribing.
//! - **Sending.** The desktop's notification engine calls `remote_push_send` on the
//!   transitions that raise an OS toast (needs-you, escalation). The payload is
//!   encrypted for each device (RFC 8291, `aes128gcm`) and POSTed to its push
//!   service on a short-lived thread, so nothing waits on the network.
//!
//! A reminder's push (step H4) has Done and Snooze buttons; they come back to
//! `POST /api/reminders/action` with the push's one-use token.
//!
//! Only paired, approved devices are served or pushed to. The phone can only
//! subscribe from a secure page — over Funnel (R3) — which is a browser rule.

use std::net::SocketAddr;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use tauri::{AppHandle, Manager};

use super::server::{authed, bearer, client_addr};
use super::RemoteState;
use crate::db::Db;

const VAPID_KEY: &str = "push_vapid_private";
/// Who to contact about our pushes, as push services ask (RFC 8292 `sub`).
const VAPID_SUBJECT: &str = "mailto:workbench@localhost";
/// How long a push service may hold a message for a phone that is offline.
const TTL_SECS: u64 = 60 * 60;
/// One record holds the whole payload: notifications are small.
const RECORD_SIZE: u32 = 4096;

// --- RFC 8291 -------------------------------------------------------------------

/// Encrypt `payload` for a subscription (RFC 8291 `aes128gcm`): the whole request
/// body, header included. `ua_public` is the browser's key (65 bytes, uncompressed),
/// `auth` its 16-byte secret; `as_secret` and `salt` are fresh per message (passed
/// in so the RFC's test vector can check this).
pub fn encrypt(
    ua_public: &[u8],
    auth: &[u8],
    payload: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "bad subscription key")?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());

    // The key from the ECDH secret and the subscription's auth secret.
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "hkdf")?;

    // The content key and nonce from that and the salt.
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| "hkdf")?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| "hkdf")?;

    // One record: the payload, then the last-record delimiter.
    let mut plain = payload.to_vec();
    plain.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| "aes")?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &[] })
        .map_err(|_| "aes")?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

// --- VAPID (RFC 8292) -----------------------------------------------------------

/// This install's VAPID key, made and stored on first use.
fn vapid_key(app: &AppHandle) -> Result<SigningKey, String> {
    let db = app.state::<Db>();
    if let Some(stored) = db.meta_get(VAPID_KEY).ok().flatten() {
        let bytes = B64.decode(stored.trim()).map_err(|e| e.to_string())?;
        return SigningKey::from_slice(&bytes).map_err(|e| e.to_string());
    }
    let key = SigningKey::random(&mut OsRng);
    db.meta_set(VAPID_KEY, &B64.encode(key.to_bytes())).map_err(|e| e.to_string())?;
    Ok(key)
}

fn public_key_b64(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_encoded_point(false).as_bytes())
}

/// `scheme://host[:port]` of an endpoint: the audience its push service checks.
fn origin_of(endpoint: &str) -> Option<&str> {
    let after = endpoint.find("://")? + 3;
    let end = endpoint[after..].find('/').map_or(endpoint.len(), |i| after + i);
    Some(&endpoint[..end])
}

/// The `Authorization` header for a push to `endpoint`.
fn vapid_header(key: &SigningKey, endpoint: &str, now: u64) -> Result<String, String> {
    let aud = origin_of(endpoint).ok_or("bad endpoint")?;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(
        json!({ "aud": aud, "exp": now + 12 * 60 * 60, "sub": VAPID_SUBJECT }).to_string(),
    );
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    let jwt = format!("{signing_input}.{}", B64.encode(signature.to_bytes()));
    Ok(format!("vapid t={jwt}, k={}", public_key_b64(key)))
}

// --- subscriptions ---------------------------------------------------------------

struct Subscription {
    device_id: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

fn subscriptions(app: &AppHandle) -> Vec<Subscription> {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let Ok(mut stmt) =
        conn.prepare("SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions WHERE muted = 0")
    else {
        return Vec::new();
    };
    stmt.query_map([], |r| {
        Ok(Subscription { device_id: r.get(0)?, endpoint: r.get(1)?, p256dh: r.get(2)?, auth: r.get(3)? })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

fn forget(app: &AppHandle, device_id: &str) {
    let db = app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let _ = conn.execute("DELETE FROM push_subscriptions WHERE device_id = ?1", [device_id]);
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Encrypt and POST one push. A subscription the service no longer knows is dropped.
fn deliver(app: &AppHandle, key: &SigningKey, sub: &Subscription, payload: &[u8]) {
    let result = (|| -> Result<(), String> {
        let ua = B64.decode(sub.p256dh.trim_end_matches('=')).map_err(|e| e.to_string())?;
        let auth = B64.decode(sub.auth.trim_end_matches('=')).map_err(|e| e.to_string())?;
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let body = encrypt(&ua, &auth, payload, &SecretKey::random(&mut OsRng), &salt)?;
        let authorization = vapid_header(key, &sub.endpoint, now())?;
        match ureq::post(&sub.endpoint)
            .header("Authorization", &authorization)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", &TTL_SECS.to_string())
            .header("Urgency", "high")
            .send(&body[..])
        {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(404 | 410)) => {
                forget(app, &sub.device_id);
                Err("the push service dropped this subscription".into())
            }
            Err(e) => Err(e.to_string()),
        }
    })();
    if let Err(e) = result {
        eprintln!("[remote] push to {}: {e}", sub.device_id);
    }
}

/// Push `payload` to every subscribed, unmuted device that may still use the app.
pub fn send_all(app: &AppHandle, payload: serde_json::Value) {
    let Some(state) = app.try_state::<Arc<RemoteState>>() else { return };
    let allowed: Vec<String> = {
        let inner = state.inner.lock().unwrap();
        inner.devices.iter().filter(|d| d.approved).map(|d| d.id.clone()).collect()
    };
    let subs: Vec<Subscription> =
        subscriptions(app).into_iter().filter(|s| allowed.contains(&s.device_id)).collect();
    if subs.is_empty() {
        return;
    }
    let key = match vapid_key(app) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[remote] push key: {e}");
            return;
        }
    };
    let app = app.clone();
    let body = payload.to_string().into_bytes();
    std::thread::spawn(move || {
        for sub in &subs {
            deliver(&app, &key, sub, &body);
        }
    });
}

/// Send a push for an instance (the notification engine, on needs-you and
/// escalation). `tag` groups a card's pushes so a newer one replaces the older.
#[tauri::command]
pub fn remote_push_send(app: AppHandle, instance_id: String, title: String, body: String) {
    send_all(&app, json!({ "title": title, "body": body, "instanceId": instance_id, "tag": instance_id }));
}

/// How many devices would get a push (the desktop menu's line).
#[tauri::command]
pub fn remote_push_count(app: AppHandle) -> usize {
    subscriptions(&app).len()
}

// --- the phone's endpoints ------------------------------------------------------

#[allow(clippy::result_large_err)] // a refusal is built once per refused request
fn device(state: &Arc<RemoteState>, peer: SocketAddr, headers: &HeaderMap) -> Result<String, Response> {
    authed(state, bearer(headers).as_deref(), &client_addr(peer, headers))
}

/// `GET /api/push` — the key to subscribe with, and this device's state.
pub(super) async fn status(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let id = match device(&state, peer, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let key = match vapid_key(&state.app) {
        Ok(k) => k,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let row: Option<(String, bool)> = {
        let db = state.app.state::<Db>();
        let conn = db.conn.lock().expect("db lock poisoned");
        conn.query_row(
            "SELECT endpoint, muted FROM push_subscriptions WHERE device_id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .ok()
    };
    Json(json!({
        "publicKey": public_key_b64(&key),
        "subscribed": row.is_some(),
        "endpoint": row.as_ref().map(|r| r.0.clone()),
        "muted": row.is_some_and(|r| r.1),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
pub(super) struct SubscribeReq {
    endpoint: String,
    keys: Keys,
}

/// `POST /api/push/subscribe` — the browser's `PushSubscription`, as JSON.
pub(super) async fn subscribe(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<SubscribeReq>,
) -> Response {
    let id = match device(&state, peer, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };
    // Push services are public HTTPS; refusing anything else keeps a client from
    // pointing our requests somewhere on this machine or network.
    let ok_keys = B64.decode(req.keys.p256dh.trim_end_matches('=')).is_ok_and(|k| k.len() == 65)
        && B64.decode(req.keys.auth.trim_end_matches('=')).is_ok_and(|k| k.len() == 16);
    if !req.endpoint.starts_with("https://") || req.endpoint.len() > 2048 || !ok_keys {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "not a push subscription" }))).into_response();
    }
    let db = state.app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let saved = conn.execute(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, muted, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)
         ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint,
           p256dh = excluded.p256dh, auth = excluded.auth",
        (&id, &req.endpoint, &req.keys.p256dh, &req.keys.auth, now() as i64),
    );
    match saved {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `POST /api/push/unsubscribe`.
pub(super) async fn unsubscribe(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    match device(&state, peer, &headers) {
        Ok(id) => {
            forget(&state.app, &id);
            StatusCode::OK.into_response()
        }
        Err(r) => r,
    }
}

#[derive(Deserialize)]
pub(super) struct MuteReq {
    muted: bool,
}

/// `POST /api/push/mute {muted}` — keep the subscription, send nothing (or again).
pub(super) async fn mute(
    State(state): State<Arc<RemoteState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<MuteReq>,
) -> Response {
    let id = match device(&state, peer, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let db = state.app.state::<Db>();
    let conn = db.conn.lock().expect("db lock poisoned");
    let _ = conn.execute(
        "UPDATE push_subscriptions SET muted = ?1 WHERE device_id = ?2",
        (req.muted as i64, &id),
    );
    StatusCode::OK.into_response()
}

#[derive(Deserialize)]
pub(super) struct ReminderActionReq {
    token: String,
    action: String,
}

/// `POST /api/reminders/action {token, action}` — a reminder push's Done or Snooze
/// (step H4), from the service worker, which can't sign in. The push's one-use
/// token stands in for the device: it opens nothing but that reminder's two buttons.
pub(super) async fn reminder_action(State(state): State<Arc<RemoteState>>, Json(req): Json<ReminderActionReq>) -> Response {
    match crate::assistant::reminders::act(&state.app, &req.token, &req.action) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::GONE, Json(json!({ "error": e }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s).unwrap()
    }

    /// RFC 8291 appendix A: the worked example, byte for byte.
    #[test]
    fn encrypts_the_rfc_example() {
        let as_secret = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt(&ua_public, &auth, b"When I grow up, I want to be a watermelon", &as_secret, &salt).unwrap();
        assert_eq!(
            B64.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn signs_a_vapid_header_for_the_endpoint_origin() {
        let key = SigningKey::random(&mut OsRng);
        let h = vapid_header(&key, "https://fcm.googleapis.com/fcm/send/abc", 1_000).unwrap();
        let (t, k) = h.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, public_key_b64(&key));
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&b64(parts[1])).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_000 + 12 * 3600);
        // The signature checks out against the public key.
        use p256::ecdsa::signature::Verifier;
        let sig = Signature::from_slice(&b64(parts[2])).unwrap();
        key.verifying_key().verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).unwrap();
    }

    #[test]
    fn finds_an_endpoint_origin() {
        assert_eq!(origin_of("https://a.example:8443/x/y"), Some("https://a.example:8443"));
        assert_eq!(origin_of("https://a.example"), Some("https://a.example"));
        assert_eq!(origin_of("nope"), None);
    }
}
