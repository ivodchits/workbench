import { describe, expect, it } from "vitest";

import { fitScale, frameIn, untilNextFrame } from "./canvas";

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

describe("fitScale", () => {
  it("takes the largest whole scale that fits both ways", () => {
    expect(fitScale(1600, 1200, 1, 512, 352)).toBe(3);
    expect(fitScale(1600, 700, 1, 512, 352)).toBe(1);
  });

  it("counts device pixels", () => {
    expect(fitScale(1300, 800, 1.5, 512, 352)).toBe(3);
    expect(fitScale(1300, 800, 2, 512, 352)).toBe(4);
  });

  it("never goes below 1", () => {
    expect(fitScale(200, 100, 1, 512, 352)).toBe(1);
  });
});
