import { describe, expect, it } from "vitest";

import type { AutopilotView, RoutineView } from "../assistant/protocol";
import { officeDuck, type DuckInputs } from "./officeDuck";

const routine = (running: boolean): RoutineView => ({
  id: "r",
  title: "Morning briefing",
  when: "every day at 09:00",
  does: "a message",
  on: true,
  builtIn: false,
  next: 0,
  last: null,
  lastResult: null,
  running,
});

const pilot = (instanceId: string, state: AutopilotView["state"]): AutopilotView => ({
  instanceId,
  session: instanceId,
  threadId: "t",
  state,
  text: "",
});

const duck = (d: Partial<DuckInputs>) => officeDuck({ speaking: false, routines: [], states: {}, autopilots: [], ...d });

describe("officeDuck", () => {
  it("is idle with nothing going", () => {
    expect(duck({ states: { a: "idle" }, routines: [routine(false)] })).toEqual({ state: "idle", autopilots: [] });
  });

  it("thinks while any thread's turn runs", () => {
    expect(duck({ states: { a: "idle", b: "streaming" } }).state).toBe("thinking");
    expect(duck({ states: { a: "tool" } }).state).toBe("thinking");
  });

  it("puts a routine over thinking and speaking over both", () => {
    expect(duck({ states: { a: "thinking" }, routines: [routine(true)] }).state).toBe("routine");
    expect(duck({ speaking: true, states: { a: "thinking" }, routines: [routine(true)] }).state).toBe("speaking");
  });

  it("names only the running autopilots' sessions", () => {
    const autopilots = [pilot("i1", "running"), pilot("i2", "paused"), pilot("i3", "running")];
    expect(duck({ autopilots }).autopilots).toEqual(["i1", "i3"]);
  });
});
