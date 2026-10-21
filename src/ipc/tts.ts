// Typed access to spoken replies (step V2, `src-tauri/src/voice/tts.rs`): the
// sentence queue, its engines (Kokoro + Silero on this PC, or Google Chirp), and
// the runtime's download.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Lang } from "../assistant/speakable";
import type { DownloadProgress } from "./voice";

export type TtsEngine = "local" | "chirp";

export interface TtsConfig {
  engine: TtsEngine;
  /** Chirp speaks when the local engine fails. */
  chirpFallback: boolean;
  voiceEn: string;
  voiceRu: string;
  /** 1 is normal. */
  rate: number;
  /** Start the sidecar when the push-to-talk key goes down. */
  warmOnTalk: boolean;
}

export interface TtsStatus {
  installed: boolean;
  missingBytes: number;
  preparing: boolean;
  running: boolean;
  chirpKey: boolean;
  chirpCharsThisMonth: number;
  runtimeDir: string;
}

export type TtsPhase = "speaking" | "done" | "stopped" | "error";

export interface TtsStateEvent {
  utterance: number;
  state: TtsPhase;
  message: string | null;
  engine: TtsEngine | null;
}

export const ttsConfigure = (config: TtsConfig): Promise<void> => invoke("tts_configure", { config });
/** Queue a sentence of reply `utterance`. */
export const ttsSay = (utterance: number, text: string, lang: Lang): Promise<void> =>
  invoke("tts_say", { utterance, text, lang });
/** No more sentences of `utterance` are coming. */
export const ttsEnd = (utterance: number): Promise<void> => invoke("tts_end", { utterance });
export const ttsStop = (): Promise<void> => invoke("tts_stop");
export const ttsWarm = (ru: boolean): Promise<void> => invoke("tts_warm", { ru });
export const ttsStatus = (): Promise<TtsStatus> => invoke("tts_status");
/** Download the voices and install the runtime (progress: `onTtsDownload`). */
export const ttsPrepare = (): Promise<void> => invoke("tts_prepare");

export function onTtsState(cb: (e: TtsStateEvent) => void): Promise<UnlistenFn> {
  return listen<TtsStateEvent>("tts-state", (e) => cb(e.payload));
}

/** Loudness of what's playing, 0..1, every ~33 ms while audio plays. */
export function onTtsLevel(cb: (level: number) => void): Promise<UnlistenFn> {
  return listen<number>("tts-level", (e) => cb(e.payload));
}

export function onTtsDownload(cb: (p: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>("tts-download", (e) => cb(e.payload));
}
