// Where Duck's music and videos come from (step H3). A provider searches and
// plays; the tools (`tools/media.ts`) don't know which one it is. The first is
// YouTube Music (`youtube.ts`): no playback API, so playing is opening its link
// on the device. Spotify would be a second, playing through its own API on a
// Connect device, and would use `open` not at all.

import { words } from "../tools/pc";

export type Device = "pc" | "phone";

export type MediaKind = "music" | "video";

export interface MediaItem {
  /** The provider's id for it (a YouTube video id). */
  id: string;
  kind: MediaKind;
  title: string;
  /** The artist, or the video's channel. */
  artist: string;
  /** Length in seconds; 0 for a live stream or when unknown. */
  seconds: number;
  live?: boolean;
}

/** Open a link on a device, as `open_on_pc` / `open_on_phone` do. */
export type Opener = (device: Device, url: string) => Promise<void>;

export interface MusicProvider {
  /** The provider's name, for what the tools say ("YouTube Music"). */
  name: string;
  search(query: string, kind: MediaKind, signal: AbortSignal): Promise<MediaItem[]>;
  /** Start `item` on `device`. */
  play(item: MediaItem, device: Device, open: Opener): Promise<void>;
}

/** Words a request carries that no title does. */
const FILLER = new Set(["play", "put", "some", "song", "songs", "music", "track", "the", "a", "an", "by", "me", "please", "on", "pc", "phone", "video"]);

/** How much of what was asked `item` names, 0 to 1: the share of the query's words
 *  found in its title and artist ("lo-fi" finds "lofi"). */
export function coverage(query: string, item: MediaItem): number {
  const q = words(query).filter((w) => !FILLER.has(w));
  if (!q.length) return 1;
  const hay = words(`${item.title} ${item.artist}`).join("");
  return q.filter((w) => hay.includes(w)).length / q.length;
}

/** The item `query` means: the first, in the provider's order, that names enough of
 *  it; null when none does, and the user picks. */
export function pickItem(query: string, items: readonly MediaItem[]): MediaItem | null {
  return items.find((i) => coverage(query, i) >= 0.6) ?? null;
}

/** `seconds` as "3:45" or "1:02:03"; "live" for a stream. */
export function length(item: Pick<MediaItem, "seconds" | "live">): string {
  if (item.live) return "live";
  if (!item.seconds) return "?";
  const h = Math.floor(item.seconds / 3600);
  const m = Math.floor((item.seconds % 3600) / 60);
  const s = String(item.seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
