import { describe, expect, it } from "vitest";

import { ROSTER } from "../roster";
import { ANIMS, FRAME_H, FRAME_W, allParts, colorsOf, frame, type Anim, type Dir } from "./characters";
import { checkPart, keysOf } from "./pixels";

describe("character templates", () => {
  it("every template is rectangular and fits the frame width", () => {
    for (const [label, part] of allParts()) {
      checkPart(part, label);
      expect((part.x ?? 0) + part.rows[0].length, label).toBeLessThanOrEqual(FRAME_W);
    }
  });

  it("every key a template uses has a colour", () => {
    const colors = colorsOf(ROSTER[0].look);
    for (const [label, part] of allParts()) {
      for (const key of keysOf(part)) expect(colors[key], `${label} uses "${key}"`).toBeDefined();
    }
  });
});

describe("frame", () => {
  const dirs: Dir[] = ["down", "up", "left", "right"];

  it("draws every worker in every animation and direction", () => {
    for (const worker of ROSTER) {
      for (const anim of Object.keys(ANIMS) as Anim[]) {
        for (const dir of dirs) {
          ANIMS[anim].frames.forEach((_, i) => {
            const bmp = frame(worker.look, anim, dir, i);
            expect([bmp.w, bmp.h]).toEqual([FRAME_W, FRAME_H]);
          });
        }
      }
    }
  });

  it("left is right mirrored", () => {
    const look = ROSTER[0].look;
    const right = frame(look, "walk", "right", 0);
    const left = frame(look, "walk", "left", 0);
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        const a = (y * FRAME_W + x) * 4;
        const b = (y * FRAME_W + (FRAME_W - 1 - x)) * 4;
        expect(left.data[b + 3]).toBe(right.data[a + 3]);
      }
    }
  });

  it("gives every worker a different look", () => {
    const seen = new Set(ROSTER.map((w) => JSON.stringify(w.look)));
    expect(seen.size).toBe(ROSTER.length);
  });
});
