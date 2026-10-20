// Voice in Duck's settings (step V1): where speech to text runs, its download, and
// a check on a WAV file. The model downloads on first use; nothing ships with the
// app. The GPU preference is kept in the `voice` pref.

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getPref, setPref } from "../../ipc/prefs";
import {
  onVoiceDownload,
  voicePrepare,
  voiceStatus,
  voiceTranscribeWav,
  type DownloadProgress,
  type GpuPref,
  type Transcript,
  type VoiceStatus,
} from "../../ipc/voice";

const GPU_CHOICES: { value: GpuPref; label: string }[] = [
  { value: "never", label: "CPU only (fastest here)" },
  { value: "ac_only", label: "GPU on AC power" },
  { value: "always", label: "GPU always" },
];

const mb = (n: number) => `${Math.round(n / 1_000_000).toLocaleString()} MB`;

export default function VoiceSettings() {
  const [gpu, setGpu] = useState<GpuPref | null>(null);
  /** The preference as the download listener reads it. */
  const gpuRef = useRef<GpuPref>("never");
  gpuRef.current = gpu ?? "never";
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [test, setTest] = useState<{ file: string; result: Transcript | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((pref: GpuPref) => {
    void voiceStatus(pref)
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    void getPref("voice", { gpu: "never" as GpuPref })
      .then((v) => {
        setGpu(v.gpu);
        refresh(v.gpu);
      })
      .catch(() => {
        setGpu("never");
        refresh("never");
      });
  }, [refresh]);

  useEffect(() => {
    const off = onVoiceDownload((p) => {
      setProgress(p.finished && !p.error ? null : p);
      if (p.finished) refresh(gpuRef.current);
    });
    return () => void off.then((f) => f());
  }, [refresh]);

  if (!gpu) return null;

  const choose = (value: GpuPref) => {
    setGpu(value);
    void setPref("voice", { gpu: value });
    refresh(value);
  };

  const download = () => {
    setError(null);
    void voicePrepare(gpu)
      .then(() => refresh(gpu))
      .catch((e: unknown) => setError(String(e)));
  };

  const tryWav = async () => {
    const file = await open({ filters: [{ name: "16 kHz WAV", extensions: ["wav"] }] });
    if (typeof file !== "string") return;
    setTest({ file, result: null, error: null });
    try {
      const result = await voiceTranscribeWav(file, gpu);
      setTest({ file, result, error: null });
    } catch (e) {
      setTest({ file, result: null, error: String(e) });
    }
    refresh(gpu);
  };

  const downloading = status?.downloading || (progress !== null && !progress.finished);
  return (
    <>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Speech to text</span>
        <select value={gpu} onChange={(e) => choose(e.target.value as GpuPref)} style={select}>
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
            <div style={{ ...hint, userSelect: "text" }}>
              {test.error
                ? <span style={{ color: "var(--wb-needs)" }}>{test.error}</span>
                : test.result
                  ? `"${test.result.text || "(no speech)"}" · ${test.result.ms} ms for ${(test.result.audioMs / 1000).toFixed(1)} s on the ${test.result.provider.toUpperCase()}${test.result.loadMs ? ` (+${test.result.loadMs} ms loading)` : ""}`
                  : "transcribing…"}
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
