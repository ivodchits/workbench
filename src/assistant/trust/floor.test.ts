import { describe, expect, it } from "vitest";

import { FLOOR, floorHit } from "./floor";

describe("the floor", () => {
  for (const e of FLOOR) {
    it(`${e.id}: catches what it guards and lets the rest through`, () => {
      for (const h of e.hits) expect(e.test.test(h), `${e.id} should catch: ${h}`).toBe(true);
      for (const m of e.misses) expect(e.test.test(m), `${e.id} should pass: ${m}`).toBe(false);
    });
  }

  it("has unique ids", () => {
    expect(new Set(FLOOR.map((e) => e.id)).size).toBe(FLOOR.length);
  });

  it("reports the first entry hit, skipping the ones turned off", () => {
    expect(floorHit(["npm test", "git push origin main"])?.id).toBe("push");
    expect(floorHit(["git push --force"])?.id).toBe("push");
    expect(floorHit(["git push --force"], ["push"])?.id).toBe("force");
    expect(floorHit(["npm test"])).toBeNull();
  });
});
