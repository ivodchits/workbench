// Typed access to voice input (step V1, `src-tauri/src/voice`): Parakeet speech to
// text on this PC, its downloads, and its lifetime. The GPU preference is the
// webview's (`voice` pref) and goes with each call.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** When the GPU may run the model. The CPU is the default: it measured faster. */
export type GpuPref = "always" | "ac_only" | "never";
export type VoiceProvider = "gpu" | "cpu";

export interface VoiceStatus {
  /** Where it would run now; null until something usable is downloaded. */
  provider: VoiceProvider | null;
  providerLabel: string | null;
  loaded: VoiceProvider | null;
  /** Still to download for this preference. */
  missingBytes: number;
  downloading: boolean;
  onAc: boolean;
  /** Why the GPU wasn't used the last time it was asked for. */
  gpuProblem: string | null;
  modelsDir: string;
}

export interface Transcript {
  text: string;
  provider: VoiceProvider;
  audioMs: number;
  speechMs: number;
  loadMs: number;
  ms: number;
  retried: boolean;
}

export interface DownloadProgress {
  done: number;
  total: number;
  file: string;
  /** The last event: finished, or failed with `error`. */
  finished: boolean;
  error: string | null;
}

export const voiceStatus = (pref: GpuPref): Promise<VoiceStatus> => invoke("voice_status", { pref });
/** Download what `pref` needs, in the background (progress: `onVoiceDownload`). */
export const voicePrepare = (pref: GpuPref): Promise<void> => invoke("voice_prepare", { pref });
export const voicePreload = (pref: GpuPref): Promise<VoiceProvider> => invoke("voice_preload", { pref });
export const voiceTranscribeWav = (path: string, pref: GpuPref): Promise<Transcript> =>
  invoke("voice_transcribe_wav", { path, pref });
export const voiceKeepWarm = (on: boolean): Promise<void> => invoke("voice_keep_warm", { on });
export const voiceUnload = (): Promise<void> => invoke("voice_unload");

export function onVoiceDownload(cb: (p: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>("voice-download", (e) => cb(e.payload));
}

// ── push-to-talk ──

/** What push-to-talk needs from the settings. */
export interface VoiceConfig {
  gpu: GpuPref;
  /** The microphone's name; null for the default input. */
  device: string | null;
  /** The push-to-talk key ("Ctrl+Alt+Space", "F13"); null for none. */
  hotkey: string | null;
}

export type VoicePhase = "listening" | "transcribing" | "idle" | "error";

export const voiceConfigure = (config: VoiceConfig): Promise<void> => invoke("voice_configure", { config });
/** The drawer's mic button: down while held. */
export const voicePtt = (down: boolean): Promise<void> => invoke("voice_ptt", { down });
export const voiceDevices = (): Promise<string[]> => invoke("voice_devices");

export function onVoiceState(cb: (s: { state: VoicePhase; message: string | null }) => void): Promise<UnlistenFn> {
  return listen<{ state: VoicePhase; message: string | null }>("voice-state", (e) => cb(e.payload));
}

export function onVoiceTranscript(cb: (t: Transcript) => void): Promise<UnlistenFn> {
  return listen<Transcript>("voice-transcript", (e) => cb(e.payload));
}
