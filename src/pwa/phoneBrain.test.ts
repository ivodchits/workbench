// The phone's fallback brain (H7): Duck's engine on the phone, its requests
// through the app's fetch (here a scripted API), its reminders and threads kept by
// the app, and what goes to the desktop when it's back.

import { describe, expect, it } from "vitest";
import { responseFrom, type ApiFrame } from "./native";
import { startPhoneBrain } from "./phoneBrain";
import { OFFLINE_NOTE, parseState, threadsToSync, transcript, withoutThreads } from "../assistant/offline";
import type { StoredMessage } from "../ipc/assistant";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** One streamed reply as the API sends it. */
function sse(blocks: Block[], stop: "end_turn" | "tool_use"): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", {
    message: { id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  return out + ev("message_stop", {});
}

/** The app's fetch over a script of replies, a frame at a time as the app sends
 *  them; the requests' bodies kept. */
function scripted(replies: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.shift() ?? sse([{ type: "text", text: "(nothing scripted)" }], "end_turn");
    return responseFrom(async (onFrame: (f: ApiFrame) => void) => {
      onFrame({ head: { status: 200, headers: { "content-type": "text/event-stream" } } });
      for (const chunk of reply.split(/(?<=\n\n)/)) onFrame({ chunk });
      onFrame({ end: true });
    });
  }) as unknown as typeof fetch;
  return { fetch: fetcher, bodies };
}

function app(replies: string[], spend = { usd: 0, cap: 5 }) {
  const kept = new Map<string, string | null>();
  const armed: unknown[][] = [];
  const ran: string[] = [];
  const api = scripted(replies);
  return {
    kept,
    armed,
    ran,
    bodies: api.bodies,
    deps: {
      fetch: api.fetch,
      get: async (n: string) => kept.get(n) ?? null,
      put: async (n: string, v: string | null) => void kept.set(n, v),
      runTool: async (t: string) => void ran.push(t),
      tools: ["phone_flashlight", "phone_set_timer"],
      arm: async (a: unknown[]) => void armed.push(a),
      spend: async () => spend,
    },
  };
}

describe("the phone's fallback brain (H7)", () => {
  it("answers on the phone key with the phone's tools and the reminders, and keeps both", async () => {
    const due = "2030-01-02T10:00";
    const a = app([
      sse([{ type: "tool_use", id: "tu1", name: "add_reminder", input: { title: "Call the bank", due } }], "tool_use"),
      sse([{ type: "text", text: "I'll remind you on 2 January at 10." }], "end_turn"),
    ]);
    const brain = await startPhoneBrain(a.deps);
    const threadId = await brain.send("remind me to call the bank on 2 January at 10", true);
    await brain.engine.settled(threadId);

    // The request: the offline note in the system prompt, no Workbench tools.
    const first = a.bodies[0];
    expect(JSON.stringify(first.system)).toContain(OFFLINE_NOTE.trim().slice(0, 60));
    const names = (first.tools as { name?: string }[]).map((t) => t.name);
    expect(names).toContain("add_reminder");
    expect(names).toContain("phone_flashlight");
    expect(names).not.toContain("create_session");
    expect(names).not.toContain("set_timer");
    expect(first.model).toMatch(/sonnet/);

    // The reminder, kept and armed as the phone's own.
    const reminders = JSON.parse(a.kept.get("reminders")!) as { title: string; due: string }[];
    expect(reminders).toMatchObject([{ title: "Call the bank", due }]);
    expect(a.armed[a.armed.length - 1]).toMatchObject([{ title: "Call the bank", at: [new Date(2030, 0, 2, 10).getTime()] }]);

    // The thread, kept; and what goes to the desktop: words, a line for the tool.
    await new Promise((r) => setTimeout(r, 0));
    const state = parseState(a.kept.get("threads")!);
    const sync = threadsToSync(state);
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ id: threadId, title: "remind me to call the bank on 2 January at 10" });
    expect(sync[0].messages.map((m) => [m.role, m.text, m.voice])).toEqual([
      ["user", "remind me to call the bank on 2 January at 10", true],
      ["assistant", "[used add_reminder]\n\nI'll remind you on 2 January at 10.", undefined],
    ]);
    expect(withoutThreads(state, [threadId]).threads).toEqual([]);
  });

  it("runs the phone's tools here, carries on the same thread, and goes to Haiku near the cap", async () => {
    const a = app(
      [
        sse([{ type: "tool_use", id: "tu1", name: "phone_flashlight", input: { on: true } }], "tool_use"),
        sse([{ type: "text", text: "Torch on." }], "end_turn"),
        sse([{ type: "text", text: "Done." }], "end_turn"),
      ],
      { usd: 4.5, cap: 5 },
    );
    const brain = await startPhoneBrain(a.deps);
    const t1 = await brain.send("torch on", false);
    await brain.engine.settled(t1);
    expect(a.ran).toEqual(["phone_flashlight"]);
    expect(a.bodies[0].model).toMatch(/haiku/);
    const t2 = await brain.send("thanks", false);
    expect(t2).toBe(t1);
    await brain.engine.settled(t2);
    brain.fresh();
    expect(brain.current()).toBeNull();
  });

  it("starts again after a thread's been idle, from what the app kept", async () => {
    let now = 1_000_000;
    const a = app([sse([{ type: "text", text: "Hi." }], "end_turn")]);
    const first = await startPhoneBrain({ ...a.deps, now: () => now });
    const t = await first.send("hello", false);
    await first.engine.settled(t);
    await new Promise((r) => setTimeout(r, 0));
    const again = await startPhoneBrain({ ...a.deps, now: () => now });
    expect(again.current()).toBe(t);
    now += 3 * 3_600_000;
    expect(again.current()).toBeNull();
  });
});

describe("an offline thread as the desktop takes it (H7)", () => {
  it("is a thread of its own, made once", async () => {
    const brain = await startPhoneBrain(app([]).deps);
    const t = { id: "t9", title: "Offline: torch", messages: [{ role: "user" as const, text: "torch on", source: "phone" as const }, { role: "assistant" as const, text: "On.", source: "phone" as const }] };
    expect(await brain.engine.importThread(t)).toBe(true);
    expect(await brain.engine.importThread(t)).toBe(false);
    const ms = await brain.messages("t9");
    expect(ms.map((m) => [m.role, m.content, m.source])).toEqual([
      ["user", [{ type: "text", text: "torch on" }], "phone"],
      ["assistant", [{ type: "text", text: "On." }], "duck"],
    ]);
  });

  const m = (seq: number, role: StoredMessage["role"], content: unknown, source = "phone"): StoredMessage => ({ threadId: "t", seq, ts: seq, role, content, source });

  it("keeps words, joins a turn's rounds, drops results, notices and events, and ends with a reply", () => {
    expect(
      transcript([
        m(0, "user", [{ type: "text", text: "torch on" }]),
        m(1, "assistant", [{ type: "tool_use", id: "a", name: "phone_flashlight", input: {} }], "duck"),
        m(2, "user", [{ type: "tool_result", tool_use_id: "a", content: "ok" }], "duck"),
        m(3, "assistant", [{ type: "text", text: "On." }], "duck"),
        m(4, "notice", { kind: "note", text: "x" }, "duck"),
        m(5, "user", [{ type: "text", text: "<workbench_event>x</workbench_event>" }], "event"),
        m(6, "user", [{ type: "text", text: "and off" }], "phone-voice"),
      ]),
    ).toEqual([
      { role: "user", text: "torch on", at: 0 },
      { role: "assistant", text: "[used phone_flashlight]\n\nOn.", at: 1 },
      { role: "user", text: "and off", at: 6, voice: true },
      { role: "assistant", text: "[No reply: the phone's brain didn't answer this.]", at: 6 },
    ]);
  });
});
