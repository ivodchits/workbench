import { describe, expect, it } from "vitest";

import { checkPart, keysOf } from "./pixels";
import { FLOORS, PROPS, PROP_COLORS, floorTile, propFrame, type Prop } from "./props";

describe("props", () => {
  for (const [name, p] of Object.entries(PROPS) as [string, Prop][]) {
    it(`${name} fits its box and every key has a colour`, () => {
      const colors = { ...PROP_COLORS, ...p.colors };
      p.frames.forEach((parts, f) => {
        for (const part of parts) {
          checkPart(part, `${name}[${f}]`);
          expect((part.x ?? 0) + part.rows[0].length, name).toBeLessThanOrEqual(p.w);
          expect((part.y ?? 0) + part.rows.length, name).toBeLessThanOrEqual(p.h);
          for (const key of keysOf(part)) expect(colors[key], `${name} uses "${key}"`).toBeDefined();
        }
        expect(propFrame(p, f).data.some((v) => v > 0)).toBe(true);
      });
    });
  }
});

describe("floors", () => {
  it("every floor is a 16×16 tile in keys 1-3", () => {
    for (const [name, f] of Object.entries(FLOORS)) {
      expect(f.rows.length, name).toBe(16);
      checkPart({ rows: f.rows }, name);
      expect(f.rows[0].length, name).toBe(16);
      for (const key of keysOf({ rows: f.rows })) expect("123", `${name} uses "${key}"`).toContain(key);
      floorTile(name as keyof typeof FLOORS, true);
    }
  });
});
