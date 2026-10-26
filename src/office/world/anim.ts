// The animation player (office plan O1.1): which frame of a clip is showing at a given
// time, and how long until that changes, so the loop only redraws when a frame turns.
// A clip either loops or plays once and holds its last frame. Each entity starts its
// clips at its own offset, so a room of typists doesn't tick in step.

export interface Clip {
  /** Per frame, how long it shows (ms). */
  durations: readonly number[];
  /** Plays once and holds the last frame, rather than looping. */
  once?: boolean;
}

export interface Playing {
  clip: Clip;
  /** When the clip's first frame started (ms on the scene's clock). */
  start: number;
}

export const play = (clip: Clip, start: number): Playing => ({ clip, start });

/** The frame showing at `ms`, and how long until the next one (Infinity when it holds). */
export function frameAt({ clip, start }: Playing, ms: number): { index: number; next: number } {
  const ds = clip.durations;
  if (ds.length < 2) return { index: 0, next: Infinity };
  const total = ds.reduce((sum, d) => sum + d, 0);
  let t = Math.max(0, ms - start);
  if (clip.once && t >= total) return { index: ds.length - 1, next: Infinity };
  t %= total;
  for (let i = 0; i < ds.length; i++) {
    if (t < ds[i]) return { index: i, next: ds[i] - t };
    t -= ds[i];
  }
  return { index: 0, next: ds[0] };
}
