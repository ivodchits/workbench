import { describe, expect, it } from "vitest";

import { fitSize, frameIn, sideLayout, untilNextFrame } from "./canvas";

describe("untilNextFrame", () => {
  const durations = [100, 300, 50];

  it("counts down to the end of the frame showing", () => {
    expect(untilNextFrame(durations, 0)).toBe(100);
    expect(untilNextFrame(durations, 40)).toBe(60);
    expect(untilNextFrame(durations, 100)).toBe(300);
    expect(untilNextFrame(durations, 420)).toBe(30);
  });

  it("wraps round the loop", () => {
    expect(untilNextFrame(durations, 450 + 40)).toBe(60);
  });

  it("lands where frameIn turns over", () => {
    for (let ms = 0; ms < 900; ms += 7) {
      const wait = untilNextFrame(durations, ms);
      expect(frameIn(durations, ms + wait - 0.5)).toBe(frameIn(durations, ms));
      expect(frameIn(durations, ms + wait)).not.toBe(frameIn(durations, ms));
    }
  });

  it("never comes for a still", () => {
    expect(untilNextFrame([1000], 5)).toBe(Infinity);
  });
});

describe("fitSize", () => {
  it("fills the room the tighter way, drawing at the next whole scale up", () => {
    const { scale, backing } = fitSize(1557, 938, 1, 512, 352);
    expect(scale).toBeCloseTo(938 / 352);
    expect(backing).toBe(3);
  });

  it("keeps a whole scale whole", () => {
    expect(fitSize(1536, 2000, 1, 512, 352)).toEqual({ scale: 3, backing: 3 });
    expect(fitSize(1535, 2000, 1, 512, 352)).toEqual({ scale: 3, backing: 3 });
  });

  it("counts device pixels", () => {
    expect(fitSize(1024, 2000, 2, 512, 352)).toEqual({ scale: 4, backing: 4 });
  });

  it("never goes below 1", () => {
    expect(fitSize(200, 100, 1, 512, 352)).toEqual({ scale: 1, backing: 1 });
  });
});

describe("sideLayout", () => {
  const layout = (w: number, h: number) => sideLayout(w, h, 512, 352, 8, 280);

  it("gives the sidebar what's left beside an office as tall as the window", () => {
    expect(layout(1920, 1080)).toEqual({ below: false, size: 356 });
    expect(layout(2560, 1440)).toEqual({ below: false, size: 472 });
    // An office 1064 px tall is 1547.6 wide: with the pads and 356 px, the window is full.
    expect(16 + (1064 * 512) / 352 + 356).toBeCloseTo(1920, 0);
  });

  it("keeps it usable on a narrow screen, where the office gives way", () => {
    expect(layout(1280, 1024)).toEqual({ below: false, size: 280 });
  });

  it("puts it under the office on a portrait screen", () => {
    expect(layout(1080, 1920)).toEqual({ below: true, size: 1172 });
    expect(layout(400, 500)).toEqual({ below: true, size: 280 });
  });
});
