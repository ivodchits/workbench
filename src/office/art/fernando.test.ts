import { describe, expect, it } from "vitest";

import { FERNANDO_H, FERNANDO_W, allFernandoPoses, fernandoFrame, fernandoRows } from "./fernando";

describe("fernando", () => {
  it("draws every pose of every animation, in his frame and colours", () => {
    for (const pose of allFernandoPoses()) {
      const rows = fernandoRows(pose);
      expect(rows).toHaveLength(FERNANDO_H);
      for (const r of rows) expect(r).toHaveLength(FERNANDO_W);
      // Every key has a colour: drawing throws otherwise.
      const bmp = fernandoFrame(pose);
      expect([bmp.w, bmp.h]).toEqual([FERNANDO_W, FERNANDO_H]);
    }
  });

  it("stands on the frame's bottom row in every pose, the hat never cut off", () => {
    for (const pose of allFernandoPoses()) {
      const rows = fernandoRows(pose);
      expect(rows[FERNANDO_H - 1]).toMatch(/o/);
      expect(rows.some((r) => r.includes("g"))).toBe(true); // the hat's band
    }
  });

  it("is symmetric standing still, but for the shading", () => {
    const plain = fernandoRows().map((r) => r.replace(/[A-Z]/g, (k) => k.toLowerCase()));
    for (const r of plain) {
      const shape = r.replace(/[^.]/g, "#");
      expect(shape).toBe([...shape].reverse().join(""));
    }
  });

  it("moves only for a pose: a breath drops the body, the legs stay", () => {
    const still = fernandoRows();
    const breath = fernandoRows({ breath: true });
    expect(breath).not.toEqual(still);
    expect(breath.slice(-4)).toEqual(still.slice(-4));
    // The hat lifted shows his hair under it.
    expect(fernandoRows({ hatUp: true }).join("")).toMatch(/h{8}/);
  });
});
