// Typed access to YouTube search (step H3, `src-tauri/src/assistant/youtube.rs`),
// which holds the YouTube Data API key and counts the day's quota.

import { invoke } from "@tauri-apps/api/core";

export interface YoutubeVideo {
  id: string;
  title: string;
  /** The channel; an artist's auto-generated one without " - Topic". */
  channel: string;
  /** Length in seconds; 0 for a live stream. */
  seconds: number;
  live: boolean;
}

/** Up to eight videos; `music` keeps to YouTube's Music category. Costs 101 of the
 *  10,000 free daily units. */
export const youtubeSearch = (query: string, kind: "music" | "video"): Promise<YoutubeVideo[]> =>
  invoke("assistant_youtube_search", { query, kind });
