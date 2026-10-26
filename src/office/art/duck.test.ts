import { describe, expect, it } from "vitest";

import { DUCK_H, DUCK_W, allDuckFrames, duckFrame } from "./duck";

describe("duck", () => {
  it("draws every pose in every view", () => {
    for (const bmp of allDuckFrames()) {
      expect([bmp.w, bmp.h]).toEqual([DUCK_W, DUCK_H]);
      expect(bmp.data.some((v) => v > 0)).toBe(true);
    }
  });

  it("left is right mirrored", () => {
    const right = duckFrame("right");
    const left = duckFrame("left");
    for (let y = 0; y < DUCK_H; y++) {
      for (let x = 0; x < DUCK_W; x++) {
        expect(left.data[(y * DUCK_W + (DUCK_W - 1 - x)) * 4 + 3]).toBe(right.data[(y * DUCK_W + x) * 4 + 3]);
      }
    }
  });

  it("stays inside its frame when nudged", () => {
    const still = duckFrame("down");
    const bobbed = duckFrame("down", { dy: 1 });
    const count = (d: Uint8ClampedArray) => d.filter((_, i) => i % 4 === 3 && d[i] > 0).length;
    expect(count(bobbed.data)).toBe(count(still.data));
  });
});
