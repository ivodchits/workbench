import { describe, expect, it } from "vitest";

import { FLOOR, FLOOR_EXCEPTIONS, floorHit } from "./floor";

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

  it("lets Duck's own backup push through by its named exception, and nothing more", () => {
    const backup = "git push origin HEAD:refs/heads/main (duck-data)";
    expect(floorHit([backup])?.id).toBe("push");
    expect(floorHit([backup], [], "duck-data-push")).toBeNull();
    expect(floorHit(["git push origin HEAD (duck-data)"], [], "duck-data-push")).toBeNull();
    // Forced, another remote, another repo, or another exception's claim: the floor holds.
    for (const t of [
      "git push --force origin HEAD:refs/heads/main (duck-data)",
      "git push origin +HEAD:refs/heads/main (duck-data)",
      "git push backup HEAD:refs/heads/main (duck-data)",
      "git push origin HEAD:refs/heads/main",
      "git push origin HEAD:refs/heads/main (duck-data) && git push --force",
    ])
      expect(floorHit([t], [], "duck-data-push"), t).not.toBeNull();
    expect(floorHit([backup], [], "something-else")?.id).toBe("push");
    expect(FLOOR_EXCEPTIONS.every((x) => FLOOR.some((e) => e.id === x.entry))).toBe(true);
  });
});
