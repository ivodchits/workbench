import { describe, expect, it, vi } from "vitest";
import { createScope, unlisten } from "./scope";

describe("a scope (F6.3)", () => {
  it("undoes everything once, newest first, and at once after it's disposed", () => {
    const scope = createScope();
    const order: string[] = [];
    scope.add(() => order.push("first"));
    scope.add(() => {
      throw new Error("a failing undo doesn't stop the rest");
    });
    scope.add(() => order.push("last"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scope.dispose();
    scope.dispose();
    expect(order).toEqual(["last", "first"]);
    expect(scope.disposed).toBe(true);
    scope.add(() => order.push("late"));
    expect(order).toEqual(["last", "first", "late"]);
    warn.mockRestore();
  });

  it("clears its timers", () => {
    vi.useFakeTimers();
    try {
      const scope = createScope();
      let ticks = 0;
      let once = 0;
      scope.every(1000, () => ticks++);
      scope.after(1500, () => once++);
      vi.advanceTimersByTime(1000);
      scope.dispose();
      vi.advanceTimersByTime(5000);
      expect([ticks, once]).toEqual([1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlistens a Tauri listener whether it registered before or after", async () => {
    const early = vi.fn();
    const off = unlisten(Promise.resolve(early));
    await Promise.resolve();
    off();
    expect(early).toHaveBeenCalledTimes(1);

    let register!: (f: () => void) => void;
    const late = vi.fn();
    const offLate = unlisten(new Promise<() => void>((r) => (register = r)));
    offLate();
    register(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });
});
