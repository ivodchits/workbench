// YouTube Music, Duck's first music provider (step H3). Search is the YouTube Data
// API's (`youtube.rs`, the key in the keychain); a search costs 101 of the 10,000
// free units a day, so the same search within the hour is answered from memory.
// Playing opens `music.youtube.com/watch?v=<id>` (a song) or
// `www.youtube.com/watch?v=<id>` (a video) on the device: the browser on the PC,
// the YouTube Music or YouTube app on the phone.

import type { YoutubeVideo } from "../../ipc/music";
import type { MediaItem, MediaKind, MusicProvider } from "./provider";

const KEEP_MS = 60 * 60_000;
const KEEP_MAX = 50;

/** A YouTube video id. */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeUrl(item: Pick<MediaItem, "id" | "kind">): string {
  if (!VIDEO_ID.test(item.id)) throw new Error(`"${item.id}" isn't a YouTube video id`);
  return item.kind === "music" ? `https://music.youtube.com/watch?v=${item.id}` : `https://www.youtube.com/watch?v=${item.id}`;
}

export function youtubeMusic(deps: {
  search(query: string, kind: MediaKind): Promise<YoutubeVideo[]>;
  now?: () => number;
}): MusicProvider {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { at: number; items: MediaItem[] }>();
  return {
    name: "YouTube Music",
    async search(query, kind) {
      const key = `${kind}:${query.trim().toLowerCase()}`;
      const hit = kept.get(key);
      if (hit && now() - hit.at < KEEP_MS) return hit.items;
      const items = (await deps.search(query.trim(), kind)).map(
        (v): MediaItem => ({ id: v.id, kind, title: v.title, artist: v.channel, seconds: v.seconds, ...(v.live && { live: true }) }),
      );
      kept.delete(key);
      kept.set(key, { at: now(), items });
      if (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value as string);
      return items;
    },
    play: (item, device, open) => open(device, youtubeUrl(item)),
  };
}
