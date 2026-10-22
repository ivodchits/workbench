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
  /** A press starts and the next press stops; off, it's held. */
  toggle: boolean;
  /** What the key does (step V4): conversation mode on and off, or one dictation. */
  press: Press;
  patience: Patience;
  echo: EchoPref;
  /** Conversation mode turns itself off after this many quiet minutes. */
  autoOffMin: number;
  /** A soft cue when a turn goes to Duck. */
  cue: boolean;
  /** Save the phone's conversation runs for measuring its echo (V7). */
  recordPhone: boolean;
}

export type Press = "conversation" | "dictation";
/** How long a pause must be to end a turn: commands / chat / thinking aloud. */
export type Patience = "quick" | "patient" | "thinking";
/** Duck's own voice in the mic: by the output (headphones as they are, speakers
 *  through echo cancellation), echo cancellation always, or never listening while
 *  Duck speaks. */
export type EchoPref = "auto" | "full" | "half";

export type VoicePhase = "listening" | "transcribing" | "idle" | "error";

export const voiceConfigure = (config: VoiceConfig): Promise<void> => invoke("voice_configure", { config });
/** The drawer's mic button: down while held. */
export const voicePtt = (down: boolean): Promise<void> => invoke("voice_ptt", { down });
/** Toggle mode's mic button: start, or stop and send. */
export const voiceToggle = (): Promise<void> => invoke("voice_toggle");
export const voiceDevices = (): Promise<string[]> => invoke("voice_devices");

export function onVoiceState(cb: (s: { state: VoicePhase; message: string | null }) => void): Promise<UnlistenFn> {
  return listen<{ state: VoicePhase; message: string | null }>("voice-state", (e) => cb(e.payload));
}

export function onVoiceTranscript(cb: (t: Transcript) => void): Promise<UnlistenFn> {
  return listen<Transcript>("voice-transcript", (e) => cb(e.payload));
}

// ── conversation mode (step V4) ──

export type ConversationPhase = "preparing" | "listening" | "hearing" | "grace" | "deaf" | "off" | "error";

export interface ConversationState {
  /** Which run (a newer one replaces an older one's late events). */
  run: number;
  state: ConversationPhase;
  /** "wait" holds the turn open. */
  held: boolean;
  /** You can talk over Duck now. */
  duplex: boolean;
  message: string | null;
  /** The echo canceller is running (speakers). */
  cancelling: boolean;
  /** The echo it has removed while Duck talked, dB, on `output`. */
  suppression: number | null;
  output: string | null;
}

export interface VoiceTurn {
  run: number;
  id: number;
  text: string;
  /** `provisional`: start on it; `withdrawn`: you went on, drop it; `final`: it stands. */
  phase: "provisional" | "withdrawn" | "final";
}

export const voiceConversation = (on: boolean): Promise<void> => invoke("voice_conversation", { on });
export const voiceConversationOn = (): Promise<boolean> => invoke("voice_conversation_on");

export function onConversationState(cb: (s: ConversationState) => void): Promise<UnlistenFn> {
  return listen<ConversationState>("conversation-state", (e) => cb(e.payload));
}

export function onVoiceTurn(cb: (t: VoiceTurn) => void): Promise<UnlistenFn> {
  return listen<VoiceTurn>("voice-turn", (e) => cb(e.payload));
}

/** The microphone's loudness, 0..1, every 100 ms while conversation mode listens. */
export function onConversationLevel(cb: (level: number) => void): Promise<UnlistenFn> {
  return listen<number>("conversation-level", (e) => cb(e.payload));
}
