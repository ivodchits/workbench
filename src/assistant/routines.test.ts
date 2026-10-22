import { describe, expect, it } from "vitest";

import { BUILT_IN, createRoutines, isDue, nextSlot, ROUTINE_IDLE_MS, scheduleText, type Routine, type RoutineBackend } from "./routines";

/** Local time, so the slots are what a clock on the wall says. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3_600_000;

function memoryBackend(): RoutineBackend & { rows: Map<string, Routine> } {
  const rows = new Map<string, Routine>();
  return {
    rows,
    put: async (r) => void rows.set(r.id, structuredClone(r)),
    list: async () => [...rows.values()].map((r) => structuredClone(r)),
    remove: async (id) => void rows.delete(id),
  };
}

function lab(start: number, idle = 0) {
  const clock = { now: start, idle };
  const backend = memoryBackend();
  const ran: string[] = [];
  let fail: string | null = null;
  let n = 0;
  const routines = createRoutines({
    backend,
    now: () => clock.now,
    newId: () => `r${++n}`,
    idleMs: async () => clock.idle,
    run: async (r) => {
      ran.push(r.id);
      if (fail) throw new Error(fail);
      return `ran ${r.title}`;
    },
  });
  return { clock, backend, ran, routines, failWith: (m: string | null) => (fail = m) };
}

describe("schedules", () => {
  it("finds the next slot in local time", () => {
    // 2026-10-22 is a Thursday.
    const thu10 = at(2026, 10, 22, 10);
    expect(nextSlot({ every: "hour" }, thu10)).toBe(thu10 + HOUR);
    expect(nextSlot({ every: "day", at: "09:00" }, thu10)).toBe(at(2026, 10, 23, 9));
    expect(nextSlot({ every: "day", at: "11:30" }, thu10)).toBe(at(2026, 10, 22, 11, 30));
    expect(nextSlot({ every: "week", day: 0, idle: true }, thu10)).toBe(at(2026, 10, 25));
    expect(nextSlot({ every: "week", day: 4, at: "10:00" }, thu10)).toBe(at(2026, 10, 29, 10));
    expect(nextSlot({ every: "month", date: 1 }, thu10)).toBe(at(2026, 11, 1));
    expect(nextSlot({ every: "month", date: 22, at: "12:00" }, thu10)).toBe(at(2026, 10, 22, 12));
    expect(nextSlot({ every: "month", date: 1 }, at(2026, 12, 5))).toBe(at(2027, 1, 1));
  });

  it("says when in words", () => {
    expect(scheduleText({ every: "week", day: 0, idle: true })).toBe("Sundays after midnight, once you've been away an hour");
    expect(scheduleText({ every: "day", at: "08:30" })).toBe("every day at 08:30");
    expect(scheduleText({ every: "month", date: 2 })).toBe("on the 2nd of each month after midnight");
  });

  it("waits for the first idle hour, unless the slot's day has gone by", () => {
    const r = { enabled: true, nextRun: at(2026, 10, 25), schedule: { every: "week", day: 0, idle: true } } as Routine;
    expect(isDue(r, at(2026, 10, 24, 23), ROUTINE_IDLE_MS)).toBe(false);
    expect(isDue(r, at(2026, 10, 25, 14), 10 * 60_000)).toBe(false);
    expect(isDue(r, at(2026, 10, 25, 14), ROUTINE_IDLE_MS)).toBe(true);
    // Sunday went by (the app was closed, or you never left): Monday it runs.
    expect(isDue(r, at(2026, 10, 26, 9), 0)).toBe(true);
    expect(isDue({ ...r, enabled: false }, at(2026, 10, 26, 9), 0)).toBe(false);
  });
});

describe("routines", () => {
  it("starts with the built-in ones, which can be paused but not deleted", async () => {
    const { routines, backend } = lab(at(2026, 10, 22, 10));
    await routines.load();
    expect(routines.list().map((r) => r.id)).toEqual(BUILT_IN.map((b) => b.id));
    expect([...backend.rows.keys()]).toHaveLength(BUILT_IN.length);
    await expect(routines.remove("builtin-backup")).rejects.toThrow(/paused, not deleted/);
    expect((await routines.setEnabled("builtin-backup", false)).enabled).toBe(false);
    // Loading again doesn't add them twice.
    await routines.load();
    expect(routines.list()).toHaveLength(BUILT_IN.length);
  });

  it("runs a routine missed while the app was closed once, not once per missed slot", async () => {
    const l = lab(at(2026, 10, 22, 10));
    await l.routines.load();
    for (const b of BUILT_IN) await l.routines.setEnabled(b.id, false);
    const r = await l.routines.add({ title: "Morning briefing", schedule: { every: "day", at: "08:30" }, action: { kind: "message", text: "morning routine" }, threadId: "t1" });
    expect(r.nextRun).toBe(at(2026, 10, 23, 8, 30));
    // Closed for four days, back on the 27th at noon.
    l.clock.now = at(2026, 10, 27, 12);
    const again = createRoutines({ backend: l.backend, now: () => l.clock.now, idleMs: async () => 0, run: async (x) => (l.ran.push(x.id), "ok") });
    await again.load();
    await again.tick();
    await again.tick();
    expect(l.ran).toEqual([r.id]);
    const after = again.get(r.id)!;
    expect(after.lastRun).toBe(at(2026, 10, 27, 12));
    expect(after.nextRun).toBe(at(2026, 10, 28, 8, 30));
  });

  it("skipping Sunday runs housekeeping at the next start", async () => {
    const l = lab(at(2026, 10, 24, 18)); // Saturday evening
    await l.routines.load();
    await l.routines.setEnabled("builtin-backup", false);
    await l.routines.setEnabled("builtin-docs", false);
    expect(l.routines.get("builtin-housekeeping")!.nextRun).toBe(at(2026, 10, 25));
    // The app is closed all Sunday and started again on Tuesday morning, you at the keys.
    l.clock.now = at(2026, 10, 27, 9);
    await l.routines.tick();
    expect(l.ran).toEqual(["builtin-housekeeping"]);
    expect(l.routines.get("builtin-housekeeping")!.nextRun).toBe(at(2026, 11, 1));
  });

  it("records a failed run and waits for the next slot", async () => {
    const l = lab(at(2026, 10, 22, 10));
    await l.routines.load();
    l.clock.now = at(2026, 10, 22, 11, 1);
    l.failWith("offline");
    await l.routines.tick();
    const b = l.routines.get("builtin-backup")!;
    expect(b.lastResult).toBe("failed: offline");
    expect(b.nextRun).toBe(at(2026, 10, 22, 12, 1));
    await l.routines.tick();
    expect(l.ran.filter((x) => x === "builtin-backup")).toHaveLength(1);
  });

  it("runs one now without moving its slot, and a resumed one starts from its next slot", async () => {
    const l = lab(at(2026, 10, 22, 10));
    await l.routines.load();
    const slot = l.routines.get("builtin-backup")!.nextRun;
    expect(await l.routines.runNow("builtin-backup")).toBe("ran Back up Duck's data");
    expect(l.routines.get("builtin-backup")!.nextRun).toBe(slot);
    await l.routines.setEnabled("builtin-docs", false);
    l.clock.now = at(2026, 12, 15);
    expect((await l.routines.setEnabled("builtin-docs", true)).nextRun).toBe(at(2027, 1, 1));
  });

  it("keeps a job's memo across its run", async () => {
    const l = lab(at(2026, 10, 22, 10));
    const routines = createRoutines({
      backend: l.backend,
      now: () => l.clock.now,
      idleMs: async () => 0,
      run: async (r) => {
        await routines.memo(r.id, { failingSince: 5 });
        return "x";
      },
    });
    await routines.load();
    await routines.runNow("builtin-backup");
    expect(routines.get("builtin-backup")!.memo).toEqual({ failingSince: 5 });
    expect(l.backend.rows.get("builtin-backup")!.memo).toEqual({ failingSince: 5 });
  });
});
