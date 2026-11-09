import { describe, expect, it } from "vitest";

import { GUESTS, PEOPLE, ROSTER } from "../roster";
import { ANIMS, FRAME_H, FRAME_W, LIE_H, LIE_W, allParts, colorsOf, frame, type Anim, type Dir } from "./characters";
import { checkPart, keysOf } from "./pixels";

describe("character templates", () => {
  it("every template is rectangular and fits the frame width", () => {
    for (const [label, part] of allParts()) {
      checkPart(part, label);
      expect((part.x ?? 0) + part.rows[0].length, label).toBeLessThanOrEqual(label.startsWith("lie.") ? LIE_W : FRAME_W);
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

  it("draws everyone in every animation and direction", () => {
    for (const worker of PEOPLE) {
      for (const anim of Object.keys(ANIMS) as Anim[]) {
        for (const dir of dirs) {
          ANIMS[anim].frames.forEach((_, i) => {
            const bmp = frame(worker.look, anim, dir, i);
            expect([bmp.w, bmp.h]).toEqual(anim === "lie" ? [LIE_W, LIE_H] : [FRAME_W, FRAME_H]);
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

  it("gives everyone a different look", () => {
    const seen = new Set(PEOPLE.map((w) => JSON.stringify(w.look)));
    expect(seen.size).toBe(PEOPLE.length);
  });

  /** Whether `bmp` has a pixel of `hex` anywhere. */
  const uses = (bmp: ReturnType<typeof frame>, hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < bmp.data.length; i += 4) if (bmp.data[i + 3] && bmp.data[i] === r && bmp.data[i + 1] === g && bmp.data[i + 2] === b) return true;
    return false;
  };

  it("a dress takes the place of the trousers, and its lace shows", () => {
    const anya = GUESTS[0].look;
    for (const anim of ["idle", "walk", "relax", "drink"] as Anim[]) {
      for (const dir of dirs) {
        ANIMS[anim].frames.forEach((_, i) => {
          const bmp = frame(anya, anim, dir, i);
          expect(uses(bmp, anya.pants.base), `${anim} ${dir} ${i}`).toBe(false);
        });
      }
    }
    expect(uses(frame(anya, "idle", "down", 0), anya.dress!.base)).toBe(true);
  });

  it("lying fills its frame to the bottom row: the lift puts it on the table", () => {
    const bmp = frame(GUESTS[0].look, "lie", "down", 0);
    const bottom = [...Array(LIE_W).keys()].some((x) => bmp.data[((LIE_H - 1) * LIE_W + x) * 4 + 3] > 0);
    expect(bottom).toBe(true);
  });
});
