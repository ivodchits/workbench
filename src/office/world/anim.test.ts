import { describe, expect, it } from "vitest";

import { frameAt, play } from "./anim";

describe("animation player", () => {
  const loop = { durations: [100, 50, 200] };

  it("steps through the frames from the clip's start, and loops", () => {
    const p = play(loop, 1000);
    expect(frameAt(p, 1000)).toEqual({ index: 0, next: 100 });
    expect(frameAt(p, 1120)).toEqual({ index: 1, next: 30 });
    expect(frameAt(p, 1150)).toEqual({ index: 2, next: 200 });
    expect(frameAt(p, 1000 + 350 + 10)).toEqual({ index: 0, next: 90 });
  });

  it("an offset start shifts the phase", () => {
    expect(frameAt(play(loop, -120), 0).index).toBe(1);
  });

  it("before the start, it shows the first frame", () => {
    expect(frameAt(play(loop, 500), 0)).toEqual({ index: 0, next: 100 });
  });

  it("a clip played once holds its last frame", () => {
    const p = play({ ...loop, once: true }, 0);
    expect(frameAt(p, 340).index).toBe(2);
    expect(frameAt(p, 351)).toEqual({ index: 2, next: Infinity });
    expect(frameAt(p, 10_000)).toEqual({ index: 2, next: Infinity });
  });

  it("a single frame never changes", () => {
    expect(frameAt(play({ durations: [500] }, 0), 123)).toEqual({ index: 0, next: Infinity });
  });
});
