// Typed access to the PC's own tools (step H2): Steam
// (`src-tauri/src/assistant/steam.rs`) and the media sessions (`media.rs`).

import { invoke } from "@tauri-apps/api/core";

export interface SteamGame {
  appid: number;
  name: string;
  /** On disk, bytes. */
  size: number;
  /** Unix seconds; 0 if never played. */
  lastPlayed: number;
  /** Fully installed (not downloading or waiting for an update). */
  ready: boolean;
}

export interface StoreHit {
  appid: number;
  name: string;
}

export interface MediaSession {
  app: string;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "changing" | "opened" | "closed";
  current: boolean;
}

export type MediaAction = "play" | "pause" | "toggle" | "next" | "previous";

export const steamLibrary = (): Promise<SteamGame[]> => invoke("assistant_steam_library");

export const steamStoreSearch = (term: string): Promise<StoreHit[]> => invoke("assistant_steam_store_search", { term });

export const steamActivity = (appid: number | null): Promise<Record<string, unknown>> =>
  invoke("assistant_steam_activity", { appid });

/** A web link, or Steam's run, install or store link for a game. */
export const pcOpen = (url: string): Promise<void> => invoke("assistant_pc_open", { url });

export const mediaNowPlaying = (): Promise<MediaSession[]> => invoke("assistant_media_now_playing");

export const mediaControl = (action: MediaAction): Promise<MediaSession> => invoke("assistant_media_control", { action });
