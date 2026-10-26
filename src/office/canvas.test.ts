import { describe, expect, it } from "vitest";

import { fitSize, frameIn, untilNextFrame } from "./canvas";

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
