// @vitest-environment jsdom
// Duck restarting in place (fleet plan F6.3): the real start, on a fake backend.
// After a restart exactly one of each listener and timer is left, the old engine
// is gone from every surface, and nothing reloads the window.
import { afterEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
const invoked: string[] = [];

/** What the fake backend answers: empty state everywhere. */
function answer(cmd: string): unknown {
  invoked.push(cmd);
  if (/list|threads|pending|recent|since|calls|rows|conns|routines|tasks|drawings|autopilots|waiting|skills|timers|seen/i.test(cmd)) return [];
  return null;
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(cb);
    listeners.set(name, set);
    return () => void set.delete(cb);
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => answer(cmd)),
  Channel: class {
    onmessage: unknown = null;
  },
  convertFileSrc: (p: string) => p,
}));

const emit = (name: string, payload: unknown = null) => {
  for (const cb of listeners.get(name) ?? []) cb({ payload });
};
const counts = () => Object.fromEntries([...listeners].map(([k, v]) => [k, v.size]).filter(([, n]) => n));

afterEach(() => {
  vi.useRealTimers();
});

describe("Duck restarting without a reload (F6.3)", () => {
  it("leaves one of each listener and timer, and a fresh engine behind the drawer", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    const intervals = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => void, ms?: number) => {
      const h = realSet(cb, ms);
      intervals.add(h);
      return h;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((h: ReturnType<typeof setInterval>) => {
      intervals.delete(h);
      realClear(h);
    }) as typeof clearInterval);

    const { initAssistant, getDuck, onDuckSwitch } = await import("./index");
    await initAssistant();
    const duck = getDuck();
    expect(duck).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    const before = counts();
    const timersBefore = intervals.size;
    expect(before["duck-promoted"]).toBe(1);
    // The core's own: the brain's, the reminders', the spend meter's; and its timers.
    expect(before).toMatchObject({ "brain-tool-call": 1, "duck-reminders-changed": 1, "assistant-usage": 1 });
    expect(timersBefore).toBeGreaterThanOrEqual(4);

    const starts: (string | null)[] = [];
    onDuckSwitch((w) => starts.push(w));
    const synced: string[] = [];
    duck!.subscribe((e) => synced.push(e.type));

    for (let i = 0; i < 2; i++) {
      emit("duck-promoted", 7 + i);
      await vi.waitFor(() => expect(starts.length).toBe(i + 1));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(counts()).toEqual(before);
    expect(intervals.size).toBe(timersBefore);
    expect(reload).not.toHaveBeenCalled();
    // Every surface got the new engine's threads.
    expect(synced.filter((t) => t === "threads").length).toBeGreaterThanOrEqual(2);
    for (const h of intervals) realClear(h as ReturnType<typeof setInterval>);
  }, 20_000);
});
