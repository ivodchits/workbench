// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { age, clockTime, linkText, stripText } from "./link";
import { backoff } from "./net";
import { load, memoryBackend, save, saver, useBackend } from "./store";

describe("the connection indicator", () => {
  it("says the state, how old what's shown is, and what waits", () => {
    const now = 10_000_000;
    expect(linkText("live", now - 600_000, 0, now)).toBe("● live");
    expect(linkText("connecting", null, 0, now)).toBe("◌ connecting");
    expect(linkText("offline", now - 600_000, 2, now)).toBe("○ offline · 10m ago · 2 to send");
    expect(age(now - 10_000, now)).toBe("just now");
    expect(age(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(age(now - 2 * 86400_000, now)).toBe("2d ago");
  });

  it("says offline on every screen, with when the data is from", () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    const at = new Date(2026, 9, 30, 14, 32).getTime();
    expect(stripText(at, now)).toBe(`Offline — showing cached data from ${clockTime(at, now)}`);
    expect(clockTime(at, now)).toMatch(/32/);
    expect(clockTime(new Date(2026, 9, 28, 9, 5).getTime(), now)).not.toBe(clockTime(new Date(2026, 9, 30, 9, 5).getTime(), now));
    expect(stripText(null, now)).toContain("nothing cached yet");
  });

  it("waits longer after each failed retry, up to a cap", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoff(n, mid))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(backoff(0, () => 0)).toBe(800);
    expect(backoff(0, () => 1)).toBe(1200);
  });
});

describe("the phone's store", () => {
  it("keeps copies, and writes a busy key at most once per interval", async () => {
    useBackend(memoryBackend());
    const v = { a: [1] };
    await save("k", v);
    v.a.push(2);
    expect(await load("k")).toEqual({ a: [1] });
    const write = saver("s", 10_000);
    write(1);
    write(2);
    expect(await load("s")).toBeUndefined();
    write.flush();
    await Promise.resolve();
    expect(await load("s")).toBe(2);
  });
});
