import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayLog, RunReport } from "./daylog";
import { cancelQuit, QUIT_LIMIT_MS, quitRun, type QuitDeps, type QuitStatus } from "./daylogQuit";

const REPORT: RunReport = { notes: 0, calls: 0, tidied: [], away: [], capped: false };

function deps(over: Partial<QuitDeps> = {}) {
  const shown: (QuitStatus | null)[] = [];
  const d = {
    here: () => null,
    readAt: async () => 1000,
    workSince: async () => false,
    reachable: () => ({ available: true, main: "desktop", why: null }),
    askMain: vi.fn(async () => REPORT),
    syncMirror: vi.fn(async () => "head-a"),
    flush: vi.fn(async () => true),
    ack: vi.fn(),
    finish: vi.fn(),
    show: (s: QuitStatus | null) => shown.push(s),
    todayStart: () => 0,
    ...over,
  } satisfies QuitDeps;
  return { d, shown };
}

const logRunning = (ms: number) => ({ quitRun: () => new Promise<RunReport>((r) => setTimeout(() => r(REPORT), ms)) }) as unknown as DayLog;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("quitting waits for the daily log", () => {
  it("on the main with nothing new, quits at once and shows nothing", async () => {
    const { d, shown } = deps({ here: () => logRunning(0) });
    const p = quitRun(d);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(d.ack).toHaveBeenCalled();
    expect(d.flush).toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledTimes(1);
    expect(shown.filter(Boolean)).toEqual([]);
  });

  it("on the main with work, shows the run and quits by itself after it", async () => {
    const { d, shown } = deps({ here: () => logRunning(5000) });
    const p = quitRun(d);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown[shown.length - 1]).toMatchObject({ phase: "running" });
    expect(d.finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(d.finish).toHaveBeenCalledTimes(1);
    expect(shown[shown.length - 1]).toBeNull();
  });

  it("on the laptop with nothing new, quits at once without asking the main", async () => {
    const { d } = deps();
    await quitRun(d);
    expect(d.askMain).not.toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it("on the laptop with work, asks the main and waits for its commit to arrive", async () => {
    const heads = ["head-a", "head-a", "head-a", "head-b"];
    const { d, shown } = deps({ workSince: async () => true, syncMirror: vi.fn(async () => heads.shift() ?? "head-b") });
    const p = quitRun(d);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(d.askMain).toHaveBeenCalledTimes(1);
    expect(d.syncMirror).toHaveBeenCalledTimes(4);
    expect(shown.some((s) => s?.phase === "running" && s.step.includes("desktop"))).toBe(true);
    expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it("says so when the main can't be reached, and waits for Quit anyway", async () => {
    const { d, shown } = deps({ workSince: async () => true, reachable: () => ({ available: false, main: null, why: "not connected" }) });
    await quitRun(d);
    expect(shown[shown.length - 1]).toEqual({ phase: "unreachable", why: "not connected" });
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("gives up after the limit, says so, and quits", async () => {
    const { d, shown } = deps({ workSince: async () => true, askMain: vi.fn(() => new Promise<RunReport>(() => {})) });
    const p = quitRun(d);
    await vi.advanceTimersByTimeAsync(QUIT_LIMIT_MS + 2000);
    await p;
    expect(shown).toContainEqual({ phase: "gaveUp" });
    expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it("keeping Workbench open stops the run from quitting later", async () => {
    const { d } = deps({ here: () => logRunning(5000) });
    const p = quitRun(d);
    await vi.advanceTimersByTimeAsync(1000);
    cancelQuit();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(d.finish).not.toHaveBeenCalled();
  });
});
