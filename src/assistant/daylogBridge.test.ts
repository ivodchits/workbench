import { describe, expect, it } from "vitest";
import { startDayLogBridge, type DayLogEvent, type DayLogRequest, type Where } from "./daylogBridge";
import type { ClientMessage, DuckEvent, Stamped } from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

function rig(where: Where) {
  const sent: ClientMessage[] = [];
  const out: DayLogEvent[] = [];
  let request: ((r: DayLogRequest) => void) | null = null;
  let deliver: ((e: Stamped<DuckEvent>) => void) | null = null;
  const stop = startDayLogBridge({
    transport: {
      send: (m) => sent.push(m),
      subscribe: (cb) => {
        deliver = cb;
        return () => (deliver = null);
      },
    },
    where: () => where,
    listen: (cb) => {
      request = cb;
      return () => (request = null);
    },
    emit: (ev) => out.push(ev),
  });
  return { sent, out, ask: (r: DayLogRequest) => request!(r), deliver: (e: DuckEvent) => deliver!({ ...e, v: PROTOCOL_VERSION } as Stamped<DuckEvent>), stop };
}

const run: DayLogRequest = { requestId: "r1", kind: "send", msg: { type: "daylog.run", requestId: "r1", what: "refresh" } };

describe("the daily log's bridge", () => {
  it("sends a run to the main and passes its steps back", () => {
    const r = rig({ available: true, main: "desktop", why: null });
    r.ask({ requestId: "w", kind: "where" });
    expect(r.out[0]).toEqual({ type: "where", requestId: "w", available: true, main: "desktop", why: null });
    r.ask(run);
    expect(r.sent).toEqual([run.kind === "send" && run.msg]);
    r.deliver({ type: "daylog.step", requestId: "r1", step: { step: "writing" } });
    r.deliver({ type: "threads", threads: [] });
    r.deliver({ type: "daylog.done", requestId: "r1", error: null, report: null });
    expect(r.out.slice(1).map((e) => e.type)).toEqual(["daylog.step", "daylog.done"]);
  });

  it("says why when the main can't be reached, and sends nothing", () => {
    const r = rig({ available: false, main: null, why: "Duck's main machine isn't connected now." });
    r.ask(run);
    expect(r.sent).toEqual([]);
    expect(r.out).toEqual([{ type: "daylog.done", requestId: "r1", error: "Duck's main machine isn't connected now.", report: null }]);
  });
});
