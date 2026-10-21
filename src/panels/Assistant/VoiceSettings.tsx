// Voice in Duck's settings (step V1): the push-to-talk key, the microphone, where
// speech to text runs, its download, whether a transcript goes to Duck at once, and
// a check on a WAV file. The model downloads on first use; nothing ships with the
// app. The prefs live in `voiceState.ts`, which hands them to the backend.
//
// Step V4: what the key does (conversation mode, or one message), how patient
// conversation mode is with pauses, talking over Duck, its auto-off, the chime,
// and the reply window after an announcement.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  onVoiceDownload,
  voiceDevices,
  voicePrepare,
  voiceStatus,
  voiceTranscribeWav,
  type DownloadProgress,
  type EchoPref,
  type GpuPref,
  type Patience,
  type Transcript,
  type VoiceStatus,
} from "../../ipc/voice";
import { setVoicePrefs, useVoiceState } from "./voiceState";

const GPU_CHOICES: { value: GpuPref; label: string }[] = [
  { value: "never", label: "CPU only (fastest here)" },
  { value: "ac_only", label: "GPU on AC power" },
  { value: "always", label: "GPU always" },
];

const mb = (n: number) => `${Math.round(n / 1_000_000).toLocaleString()} MB`;

export default function VoiceSettings() {
  const { prefs, keyProblem } = useVoiceState();
  const gpu = prefs.gpu;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [devices, setDevices] = useState<string[]>([]);
  const [hotkey, setHotkey] = useState(prefs.hotkey ?? "");
  const [test, setTest] = useState<{ result: Transcript | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void voiceStatus(gpu)
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, [gpu]);

  useEffect(refresh, [refresh]);
  useEffect(() => setHotkey(prefs.hotkey ?? ""), [prefs.hotkey]);
  useEffect(() => {
    void voiceDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  useEffect(() => {
    const off = onVoiceDownload((p) => {
      setProgress(p.finished && !p.error ? null : p);
      if (p.finished) refresh();
    });
    return () => void off.then((f) => f());
  }, [refresh]);

  const download = () => {
    setError(null);
    void voicePrepare(gpu)
      .then(refresh)
      .catch((e: unknown) => setError(String(e)));
  };

  const tryWav = async () => {
    const file = await open({ filters: [{ name: "16 kHz WAV", extensions: ["wav"] }] });
    if (typeof file !== "string") return;
    setTest({ result: null, error: null });
    try {
      setTest({ result: await voiceTranscribeWav(file, gpu), error: null });
    } catch (e) {
      setTest({ result: null, error: String(e) });
    }
    refresh();
  };

  const downloading = status?.downloading || (progress !== null && !progress.finished);
  return (
    <>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Push-to-talk key</span>
        <input
          value={hotkey}
          placeholder="none"
          title='Press it anywhere to talk to Duck (or hold it, below), e.g. "Ctrl+Alt+Space" or "F13" (a desk button set to send F13)'
          onChange={(e) => setHotkey(e.target.value)}
          onBlur={() => {
            const k = hotkey.trim() || null;
            if (k !== prefs.hotkey) setVoicePrefs({ hotkey: k });
          }}
          style={{ ...select, flex: 1, minWidth: 0, padding: "1px 4px" }}
        />
      </label>
      {keyProblem && <div style={{ color: "var(--wb-needs)" }}>{keyProblem}</div>}
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>The key and the mic button</span>
        <select
          value={prefs.press === "conversation" ? "conversation" : prefs.toggle ? "toggle" : "hold"}
          onChange={(e) => {
            const v = e.target.value;
            setVoicePrefs(v === "conversation" ? { press: "conversation" } : { press: "dictation", toggle: v === "toggle" });
          }}
          style={{ ...select, flex: 1, minWidth: 0 }}
        >
          <option value="conversation">conversation mode on and off</option>
          <option value="toggle">one message: press to start, press again to send</option>
          <option value="hold">one message: hold to talk, let go to send</option>
        </select>
      </label>
      {prefs.press === "conversation" && (
        <div style={{ ...hint, paddingLeft: 2 }}>
          In conversation mode you just talk: Duck answers when you finish, then listens again. Say
          &quot;wait&quot; to hold your turn open, &quot;that&apos;s it&quot; to send it now, &quot;stop&quot; to cut Duck
          off, and &quot;that&apos;s all for now&quot; to end.
        </div>
      )}
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Pauses</span>
        <select
          value={prefs.patience}
          onChange={(e) => setVoicePrefs({ patience: e.target.value as Patience })}
          style={{ ...select, flex: 1, minWidth: 0 }}
        >
          <option value="quick">quick: answer as soon as you stop (commands)</option>
          <option value="patient">patient: wait out short pauses (chat)</option>
          <option value="thinking">thinking aloud: wait out long pauses (rubber duck)</option>
        </select>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Talking over Duck</span>
        <select
          value={prefs.echo}
          onChange={(e) => setVoicePrefs({ echo: e.target.value as EchoPref })}
          style={{ ...select, flex: 1, minWidth: 0 }}
          title="On speakers the microphone hears Duck's own voice, so until echo cancellation comes, Duck doesn't listen while it speaks there."
        >
          <option value="auto">with headphones (by the output in use)</option>
          <option value="full">always (headphones only, really)</option>
          <option value="half">never: Duck doesn&apos;t listen while it speaks</option>
        </select>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Turn off after</span>
        <select
          value={prefs.autoOffMin}
          onChange={(e) => setVoicePrefs({ autoOffMin: Number(e.target.value) })}
          style={select}
        >
          {[2, 5, 10, 20, 60].map((m) => (
            <option key={m} value={m}>
              {m} minutes of quiet
            </option>
          ))}
        </select>
      </label>
      <label style={row}>
        <input type="checkbox" checked={prefs.cue} onChange={(e) => setVoicePrefs({ cue: e.target.checked })} />
        <span>A soft chime when your turn goes to Duck</span>
      </label>
      <label style={row}>
        <input
          type="checkbox"
          checked={prefs.replyWindow}
          onChange={(e) => setVoicePrefs({ replyWindow: e.target.checked })}
        />
        <span>
          Listen for a reply after Duck announces something
          <span style={hint}> (8 seconds; &quot;yes, read it&quot;)</span>
        </span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Microphone</span>
        <select
          value={prefs.device ?? ""}
          onChange={(e) => setVoicePrefs({ device: e.target.value || null })}
          style={{ ...select, flex: 1, minWidth: 0 }}
        >
          <option value="">the default input</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label style={row}>
        <input type="checkbox" checked={prefs.sendNow} onChange={(e) => setVoicePrefs({ sendNow: e.target.checked })} />
        <span>
          Send what you say to Duck at once
          <span style={hint}> (off: it lands in the box for an edit)</span>
        </span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Speech to text</span>
        <select value={gpu} onChange={(e) => setVoicePrefs({ gpu: e.target.value as GpuPref })} style={select}>
          {GPU_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <div style={{ ...hint, paddingLeft: 2 }}>
        {status === null
          ? "…"
          : status.missingBytes > 0
            ? `Needs a ${mb(status.missingBytes)} download (the model and its runtime).`
            : `Ready: ${status.providerLabel ?? "?"}${status.loaded ? ", loaded" : ""}.`}
        {status?.gpuProblem && ` The GPU couldn't be used (${status.gpuProblem}), so the CPU runs it.`}
      </div>
      {status && status.missingBytes > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={download} disabled={downloading} style={button}>
            {downloading ? "downloading…" : "download"}
          </button>
          {progress && !progress.finished && progress.total > 0 && (
            <span style={hint}>
              {Math.floor((progress.done / progress.total) * 100)}% · {progress.file}
            </span>
          )}
        </div>
      )}
      {progress?.error && <div style={{ color: "var(--wb-needs)" }}>The download failed: {progress.error}</div>}
      {status && status.missingBytes === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button onClick={() => void tryWav()} style={{ ...button, alignSelf: "flex-start" }}>
            transcribe a WAV file…
          </button>
          {test && (
            <div style={hint}>
              {test.error ? (
                <span style={{ color: "var(--wb-needs)" }}>{test.error}</span>
              ) : test.result ? (
                `"${test.result.text || "(no speech)"}" · ${test.result.ms} ms for ${(test.result.audioMs / 1000).toFixed(1)} s on the ${test.result.provider.toUpperCase()}${test.result.loadMs ? ` (+${test.result.loadMs} ms loading)` : ""}`
              ) : (
                "transcribing…"
              )}
            </div>
          )}
        </div>
      )}
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
