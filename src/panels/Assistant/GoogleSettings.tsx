// Duck's Google settings (the "google auth" tab):
// - Drive and Sheets: the Desktop OAuth client id from the user's own Google Cloud
//   project, and connecting it in the browser (drive.readonly + drive.file; the
//   tokens stay in Credential Manager). Duck reads sheets with it and drafts copies
//   (the morning routine's invoice).
// - Speech: whether the Google key for Chirp voices is stored, and this month's use.
//   The key itself is only ever stored with `cmdkey`; which voice Duck uses is in the
//   voice tab.

import { useEffect, useState } from "react";
import { googleConnect, googleDisconnect, googleStatus, type GoogleStatus } from "../../ipc/assistant";
import { ttsStatus, type TtsStatus } from "../../ipc/tts";
import type { DuckSettings } from "../../assistant/settings";
import { googleErrorText } from "../../assistant/google";
import { setDuckSettings } from "./duckState";

export default function GoogleSettings({ settings }: { settings: DuckSettings }) {
  const saved = settings.google.clientId ?? "";
  const [clientId, setClientId] = useState(saved);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setClientId(saved), [saved]);
  useEffect(() => {
    void googleStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
    void ttsStatus()
      .then(setTts)
      .catch(() => setTts(null));
  }, []);

  const saveClientId = () => {
    const id = clientId.trim();
    if (id !== saved) setDuckSettings({ google: { clientId: id || null } });
  };

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      setStatus(await googleConnect(clientId.trim()));
    } catch (e) {
      setError(googleErrorText(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      setStatus(await googleDisconnect());
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <div style={heading}>Drive and Sheets</div>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>OAuth client id</span>
        <input
          value={clientId}
          placeholder="…apps.googleusercontent.com"
          onChange={(e) => setClientId(e.target.value)}
          onBlur={saveClientId}
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
      </label>
      <div style={{ ...row, alignItems: "center" }}>
        {status?.connected ? (
          <>
            <span>Connected</span>
            <button type="button" onClick={() => void disconnect()} style={button}>
              disconnect
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => void connect()} disabled={connecting || !saved} style={button}>
              {connecting ? "waiting for the browser…" : "connect Google"}
            </button>
            <span style={hint}>(read your Drive; change only files Duck makes)</span>
          </>
        )}
      </div>
      {status && !status.secretStored && (
        <div style={hint}>
          If the client has a secret, store it first in your own terminal:{" "}
          <code>cmdkey /generic:{status.secretTarget} /user:duck /pass:&lt;secret&gt;</code>
        </div>
      )}
      <div style={hint}>
        Duck reads your sheets with it (the invoice, when it's due) and makes drafts as copies in a Drive folder
        &quot;Duck drafts&quot;. The original is never changed.
      </div>
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}

      <div style={heading}>Speech (Chirp voices)</div>
      <div style={hint}>
        {tts === null ? (
          "…"
        ) : tts.chirpKey ? (
          `The Google key is stored: ${tts.chirpCharsThisMonth.toLocaleString()} of 1,000,000 free characters used this month.`
        ) : (
          <>
            No Google key is stored. Store one in your own terminal:{" "}
            <code>cmdkey /generic:duck/google-tts-key /user:duck /pass:&lt;key&gt;</code>
          </>
        )}
      </div>
    </>
  );
}

const input: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
  padding: "1px 4px",
};

const button: React.CSSProperties = { ...input, cursor: "pointer", padding: "1px 8px" };

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  lineHeight: 1.45,
};

const heading: React.CSSProperties = { color: "var(--wb-textDim2)", marginTop: 4 };

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };
