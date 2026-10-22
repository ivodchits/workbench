// Spoken replies in Duck's settings (step V2): which replies are spoken, the
// engine and voices, the speaking rate, Chirp as a fallback, and the download of
// the voices and their runtime (nothing ships with the app). The prefs live in
// `replySpeech.ts`, which hands them to the backend.

import { useCallback, useEffect, useState } from "react";
import { onTtsDownload, ttsPrepare, ttsStatus, type TtsStatus } from "../../ipc/tts";
import type { DownloadProgress } from "../../ipc/voice";
import { refreshReady, setSpeechPrefs, speakText, useSpeechState, type SpeechPrefs } from "./replySpeech";

const SPEAK: { value: SpeechPrefs["speak"]; label: string }[] = [
  { value: "off", label: "never" },
  { value: "voice", label: "when you spoke" },
  { value: "always", label: "always" },
];

/** Kokoro v1.0's voices worth offering (American and British English). */
const EN_VOICES = ["af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir", "bf_emma", "bm_george"];
/** Silero v5's Russian speakers. */
const RU_VOICES = ["kseniya", "xenia", "baya", "aidar", "eugene"];

const SAMPLE_EN = "Two sessions need you. The backend one is waiting for your approval.";
const SAMPLE_RU = "Две сессии ждут тебя. Бэкенд просит подтверждения.";

const mb = (n: number) => `${Math.round(n / 1_000_000).toLocaleString()} MB`;

export default function SpeechSettings() {
  const { prefs, ready, error: speechError } = useSpeechState();
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void ttsStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
    void refreshReady();
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const off = onTtsDownload((p) => {
      setProgress(p.finished && !p.error ? null : p);
      if (p.finished) refresh();
    });
    return () => void off.then((f) => f());
  }, [refresh]);

  const download = () => {
    setError(null);
    void ttsPrepare()
      .then(refresh)
      .catch((e: unknown) => setError(String(e)));
  };

  const local = prefs.engine === "local";
  const localReady = !!status && status.installed && status.missingBytes === 0;
  const preparing = status?.preparing || (progress !== null && !progress.finished);
  return (
    <>
      <div style={{ fontWeight: 600, marginTop: 10 }}>Spoken replies</div>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Speak Duck's replies</span>
        <select
          value={prefs.speak}
          onChange={(e) => setSpeechPrefs({ speak: e.target.value as SpeechPrefs["speak"] })}
          style={select}
        >
          {SPEAK.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Voice</span>
        <select
          value={prefs.engine}
          onChange={(e) => setSpeechPrefs({ engine: e.target.value as SpeechPrefs["engine"] })}
          style={select}
        >
          <option value="local">on this PC (Kokoro, Silero for Russian)</option>
          <option value="chirp">Google Chirp 3 HD (online)</option>
        </select>
      </label>
      {local && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label style={{ ...row, alignItems: "center" }}>
            <span>English</span>
            <select value={prefs.voiceEn} onChange={(e) => setSpeechPrefs({ voiceEn: e.target.value })} style={select}>
              {EN_VOICES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label style={{ ...row, alignItems: "center" }}>
            <span>Russian</span>
            <select value={prefs.voiceRu} onChange={(e) => setSpeechPrefs({ voiceRu: e.target.value })} style={select}>
              {RU_VOICES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Rate</span>
        <input
          type="range"
          min={0.8}
          max={1.3}
          step={0.05}
          value={prefs.rate}
          onChange={(e) => setSpeechPrefs({ rate: Number(e.target.value) })}
          style={{ flex: 1, minWidth: 0 }}
        />
        <span style={{ ...hint, width: 36 }}>{prefs.rate.toFixed(2)}×</span>
      </label>
      {local && (
        <label style={row} title={status?.chirpKey ? undefined : "Store a key first: cmdkey /generic:duck/google-tts-key /user:duck /pass:<key>"}>
          <input
            type="checkbox"
            checked={prefs.chirpFallback}
            disabled={!status?.chirpKey}
            onChange={(e) => setSpeechPrefs({ chirpFallback: e.target.checked })}
          />
          <span>
            Use Chirp when the voice on this PC fails
            <span style={hint}> (needs the Google key in the keychain)</span>
          </span>
        </label>
      )}
      <div style={{ ...hint, paddingLeft: 2 }}>
        {status === null
          ? "…"
          : local
            ? localReady
              ? `Ready${status.running ? ", running" : ""}. ${prefs.speak === "off" ? "It stops 5 minutes after the last use." : "It stays loaded while replies are spoken (a few hundred MB; more once Russian is used)."}`
              : `Needs a ${mb(status.missingBytes)} download of the voices${status.installed ? "" : ", and uv installs their runtime (about 1 GB, once)"}.`
            : status.chirpKey
              ? `Chirp: ${status.chirpCharsThisMonth.toLocaleString()} of 1,000,000 free characters used this month.`
              : "No Google key is stored: see the google auth tab."}
      </div>
      {local && status && !localReady && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={download} disabled={preparing} style={button}>
            {preparing ? "setting up…" : "download"}
          </button>
          {progress && !progress.finished && (
            <span style={hint}>
              {progress.total > 0 && progress.done < progress.total
                ? `${Math.floor((progress.done / progress.total) * 100)}% · ${progress.file}`
                : progress.file}
            </span>
          )}
        </div>
      )}
      {progress?.error && <div style={{ color: "var(--wb-needs)" }}>Setting up failed: {progress.error}</div>}
      {ready && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => speakText(SAMPLE_EN)} style={button}>
            try English
          </button>
          <button onClick={() => speakText(SAMPLE_RU)} style={button}>
            try Russian
          </button>
        </div>
      )}
      {speechError && <div style={{ color: "var(--wb-needs)" }}>The voice failed: {speechError}</div>}
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
    </>
  );
}

const select: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
};

const button: React.CSSProperties = { ...select, cursor: "pointer", padding: "1px 8px" };

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  cursor: "pointer",
  lineHeight: 1.45,
};

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };
