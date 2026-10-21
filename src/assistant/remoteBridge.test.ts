import { describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../ipc/assistant";
import type { AssistantRemoteInput } from "../ipc/remote";
import type { RemoteDuckFrame } from "../remote/protocol";
import type { ClientMessage, DuckEndpoint, DuckEvent } from "./protocol";
import { parseRemote, startRemoteBridge, type BridgeDeps } from "./remoteBridge";
import type { Lang } from "./speakable";

const fix = (t: string) => t.replace("воркбенч", "Workbench");

describe("parseRemote", () => {
  it("stores the phone's messages as the phone's, dictated ones with their names fixed", () => {
    expect(parseRemote({ type: "send", threadId: null, text: " hi " }, fix)).toEqual({
      type: "send",
      threadId: null,
      text: "hi",
      source: "phone",
    });
    expect(parseRemote({ type: "send", threadId: "t1", text: "открой воркбенч", voice: true, source: "desktop" }, fix)).toEqual({
      type: "send",
      threadId: "t1",
      text: "открой Workbench",
      source: "phone-voice",
    });
  });

  it("lets a phone pause trust but not loosen it or change settings", () => {
    expect(parseRemote({ type: "trust.pause" }, fix)).toEqual({ type: "trust.pause", paused: true });
    // A phone's `paused: false` is not a resume.
    expect(parseRemote({ type: "trust.pause", paused: false }, fix)).toEqual({ type: "trust.pause", paused: true });
    for (const type of ["settings.set", "trust.rule.add", "trust.rule.remove", "trust.mode", "trust.floor", "trust.replay", "thread.delete"])
      expect(parseRemote({ type }, fix)).toBe(`"${type}" can't be sent from the phone`);
    expect(parseRemote("sync", fix)).toBe("not a Duck message");
    expect(typeof parseRemote({ type: "send", threadId: null, text: "x".repeat(20_001) }, fix)).toBe("string");
    expect(typeof parseRemote({ type: "send", threadId: null, text: "   " }, fix)).toBe("string");
  });
});

function harness(over: Partial<BridgeDeps> = {}) {
  const duckListeners = new Set<(e: DuckEvent) => void>();
  const handled: { msg: ClientMessage; reply?: (e: DuckEvent) => void }[] = [];
  const duck: DuckEndpoint = {
    handle: (msg, reply) => void handled.push({ msg, reply }),
    onEvent(cb) {
      duckListeners.add(cb);
      return () => void duckListeners.delete(cb);
    },
  };
  let input: (i: AssistantRemoteInput) => void = () => {};
  const sent: { frame: RemoteDuckFrame; conn: number | null }[] = [];
  const pushes: string[][] = [];
  let n = 0;
  const render = vi.fn<(text: string, lang: Lang) => Promise<{ id: string; seconds: number }>>(async () => ({ id: `a${++n}`, seconds: 2 }));
  const warm = vi.fn<(ru: boolean) => void>();
  const bridge = startRemoteBridge({
    duck,
    link: {
      onInput: (cb) => {
        input = cb;
        return () => {};
      },
      emit: (frame, conn) => void sent.push({ frame, conn }),
      push: (...a) => void pushes.push(a),
    },
    watching: () => false,
    fixVoice: fix,
    prepare: async (sentence) => ({ text: sentence.trim(), lang: /[а-я]/i.test(sentence) ? "ru" : "en" }),
    render,
    warm,
    ...over,
  });
  const event = (e: DuckEvent) => duckListeners.forEach((l) => l(e));
  const phone = (conn: number, msg: unknown) => input({ conn, device: "d", kind: "message", msg });
  const open = (conn: number) => input({ conn, device: "d", kind: "open", msg: null });
  const close = (conn: number) => input({ conn, device: "d", kind: "close", msg: null });
  return { handled, sent, pushes, render, warm, stop: bridge.stop, bridge, event, phone, open, close };
}

const userMessage = (threadId: string, text: string, source: string): StoredMessage => ({
  threadId,
  seq: 1,
  ts: 1,
  role: "user",
  content: [{ type: "text", text }],
  source,
});

describe("startRemoteBridge", () => {
  it("answers the phone that asked, and sends Duck's events to every phone while one is open", () => {
    const h = harness();
    h.event({ type: "delta", threadId: "t", text: "nobody" });
    expect(h.sent).toEqual([]);
    h.open(1);
    h.open(2);
    h.phone(1, { type: "sync" });
    expect(h.handled[0].msg).toEqual({ type: "sync" });
    h.handled[0].reply!({ type: "threads", threads: [] });
    expect(h.sent).toEqual([{ frame: { type: "threads", threads: [], v: 1 }, conn: 1 }]);
    h.event({ type: "delta", threadId: "t", text: "both" });
    expect(h.sent[1]).toEqual({ frame: { type: "delta", threadId: "t", text: "both", v: 1 }, conn: null });
    h.phone(2, { type: "settings.set", settings: {} });
    expect(h.handled).toHaveLength(1);
    expect(h.sent[2]).toEqual({ frame: { type: "error", message: `"settings.set" can't be sent from the phone`, v: 1 }, conn: 2 });
    h.close(1);
    h.close(2);
    h.event({ type: "delta", threadId: "t", text: "gone" });
    expect(h.sent).toHaveLength(3);
  });

  it("speaks a reply to the phone that asked a sentence at a time, in order, as it streams", async () => {
    const h = harness();
    h.open(1);
    h.phone(1, { type: "send", threadId: "t", text: "что меня ждёт?", voice: true, speak: true });
    expect(h.warm).toHaveBeenCalledWith(true);
    h.event({ type: "message", message: userMessage("t", "что меня ждёт?", "phone-voice") });
    // A tool's results are stored as a user message too: not a new turn.
    h.event({ type: "message", message: { ...userMessage("t", "", "duck"), content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
    h.event({ type: "delta", threadId: "t", text: "Two sessions need you. Api " });
    // The first sentence goes out while the reply is still streaming.
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledWith("Two sessions need you.", "en"));
    const tts = () => h.sent.filter((s) => s.frame.type === "tts" || s.frame.type === "ttsEnd");
    await vi.waitFor(() =>
      expect(tts()).toEqual([
        { frame: { type: "tts", threadId: "t", reply: "r1", part: 0, id: "a1", seconds: 2, text: "Two sessions need you.", v: 1 }, conn: 1 },
      ]),
    );
    h.event({ type: "delta", threadId: "t", text: "waits for approval." });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    await vi.waitFor(() => expect(tts()).toHaveLength(3));
    expect(h.render).toHaveBeenLastCalledWith("Api waits for approval.", "en");
    expect(tts().slice(1)).toEqual([
      { frame: { type: "tts", threadId: "t", reply: "r1", part: 1, id: "a2", seconds: 2, text: "Api waits for approval.", v: 1 }, conn: 1 },
      { frame: { type: "ttsEnd", threadId: "t", reply: "r1", parts: 2, v: 1 }, conn: 1 },
    ]);
  });

  it("speaks the reply in a thread Duck moved the phone into, when the one that moved it was spoken", async () => {
    const h = harness();
    h.open(1);
    h.phone(1, { type: "send", threadId: "a", text: "go to the demiurge thread and give me the details", voice: true, speak: true });
    h.event({ type: "message", message: userMessage("a", "go to the demiurge thread and give me the details", "phone-voice") });
    h.event({ type: "delta", threadId: "a", text: "Moving to Demiurge." });
    h.event({ type: "turnState", threadId: "a", state: "idle", queued: 0 });
    h.event({ type: "goThread", threadId: "d", from: "a", surface: "phone" });
    h.event({ type: "message", message: userMessage("d", "[Brought over by Duck…]\n\ngive me the details", "phone-voice") });
    h.event({ type: "delta", threadId: "d", text: "Three steps are done. " });
    h.event({ type: "turnState", threadId: "d", state: "idle", queued: 0 });
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledWith("Three steps are done.", "en"));
    const parts = h.sent.filter((s) => s.frame.type === "tts").map((s) => [s.conn, (s.frame as { threadId: string }).threadId]);
    expect(parts).toEqual([
      [1, "a"],
      [1, "d"],
    ]);
    // A read asked for there plays on that phone.
    expect(h.bridge.voiceFor("d")?.where).toBe("phone");

    // A move from a desktop request, or a reply not spoken, brings no voice.
    h.event({ type: "goThread", threadId: "e", from: "d", surface: "desktop" });
    h.event({ type: "message", message: userMessage("e", "[Brought over…]\n\nwhat's next", "phone") });
    h.event({ type: "delta", threadId: "e", text: "Nothing. " });
    h.event({ type: "turnState", threadId: "e", state: "idle", queued: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.render).toHaveBeenCalledTimes(2);
  });

  it("speaks a provisional turn's reply as it streams, and cuts it when the turn is withdrawn", async () => {
    const h = harness();
    h.open(1);
    expect(parseRemote({ type: "send", threadId: "t", text: "hi", voice: true, provisional: true }, fix)).toMatchObject({ provisional: true });
    expect(parseRemote({ type: "turn.commit", threadId: "t" }, fix)).toEqual({ type: "turn.commit", threadId: "t" });
    h.phone(1, { type: "send", threadId: "t", text: "what needs me", voice: true, speak: true, provisional: true });
    h.event({ type: "provisional", threadId: "t", text: "what needs me", source: "phone-voice" });
    h.event({ type: "delta", threadId: "t", text: "Two sessions need you. Api " });
    const tts = () => h.sent.filter((s) => s.frame.type === "tts" || s.frame.type === "ttsEnd" || s.frame.type === "ttsCut");
    await vi.waitFor(() => expect(tts()).toHaveLength(1));
    // It stood: the message is stored, and the reply goes on as one.
    h.phone(1, { type: "turn.commit", threadId: "t" });
    h.event({ type: "message", message: userMessage("t", "what needs me", "phone-voice") });
    h.event({ type: "delta", threadId: "t", text: "waits." });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    await vi.waitFor(() => expect(tts()).toHaveLength(3));
    expect(tts().map((s) => [s.frame.type, "reply" in s.frame ? s.frame.reply : null])).toEqual([
      ["tts", "r1"],
      ["tts", "r1"],
      ["ttsEnd", "r1"],
    ]);

    // The next one is withdrawn (you went on talking): what the phone has is cut.
    h.phone(1, { type: "send", threadId: "t", text: "and the", voice: true, speak: true, provisional: true });
    h.event({ type: "provisional", threadId: "t", text: "and the", source: "phone-voice" });
    h.event({ type: "delta", threadId: "t", text: "Sure. The " });
    await vi.waitFor(() => expect(tts()).toHaveLength(4));
    h.event({ type: "withdrawn", threadId: "t" });
    expect(tts()[4]).toEqual({ frame: { type: "ttsCut", threadId: "t", v: 1 }, conn: 1 });
    h.event({ type: "delta", threadId: "t", text: "rest. And more. " });
    await new Promise((r) => setTimeout(r, 20));
    expect(tts()).toHaveLength(5);
  });

  it("keeps the parts in order when a later sentence is ready first", async () => {
    const slow: ((v: { id: string; seconds: number }) => void)[] = [];
    const h = harness({
      prepare: (sentence) =>
        sentence.startsWith("First")
          ? new Promise((r) => setTimeout(() => r({ text: sentence, lang: "en" }), 20))
          : Promise.resolve({ text: sentence, lang: "en" }),
      render: (text) => new Promise((r) => slow.push((v) => r({ ...v, id: text }))),
    });
    h.open(1);
    h.phone(1, { type: "send", threadId: "t", text: "go", speak: true });
    h.event({ type: "message", message: userMessage("t", "go", "phone") });
    h.event({ type: "delta", threadId: "t", text: "First one. Second one." });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    await vi.waitFor(() => expect(slow).toHaveLength(1));
    slow[0]({ id: "", seconds: 1 });
    await vi.waitFor(() => expect(slow).toHaveLength(2));
    slow[1]({ id: "", seconds: 1 });
    const parts = () => h.sent.flatMap((s) => (s.frame.type === "tts" ? [s.frame.id] : []));
    await vi.waitFor(() => expect(parts()).toEqual(["First one.", "Second one."]));
  });

  it("doesn't speak a reply the phone stopped, or one it didn't ask to hear", async () => {
    const h = harness();
    h.open(1);
    h.phone(1, { type: "send", threadId: "t", text: "long one", speak: true });
    h.event({ type: "message", message: userMessage("t", "long one", "phone") });
    h.event({ type: "delta", threadId: "t", text: "Once upon" });
    h.phone(1, { type: "stop", threadId: "t" });
    h.event({ type: "delta", threadId: "t", text: " a time. There was" });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    h.phone(1, { type: "send", threadId: "t", text: "quiet" });
    h.event({ type: "message", message: userMessage("t", "quiet", "phone") });
    h.event({ type: "delta", threadId: "t", text: "Fine." });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.render).not.toHaveBeenCalled();
    expect(h.sent.some((s) => s.frame.type === "ttsEnd")).toBe(false);
  });

  it("pushes a confirmation once when no surface would see it", () => {
    const confirm: DuckEvent = {
      type: "confirm",
      request: { threadId: "t", batchId: "b", toolUseId: "u1", name: "stop_session", input: {}, summary: "Stop api." },
    };
    const h = harness();
    h.event(confirm);
    h.event(confirm);
    expect(h.pushes).toEqual([["t", "Duck is waiting for a yes or no", "Stop api."]]);

    const watched = harness({ watching: () => true });
    watched.event(confirm);
    expect(watched.pushes).toEqual([]);

    const phoneOpen = harness();
    phoneOpen.open(1);
    phoneOpen.event(confirm);
    expect(phoneOpen.pushes).toEqual([]);
  });
  it("plays a read on the phone that asked, and cuts it there", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.open(1);
      expect(h.bridge.voiceFor("t")).toBeNull();
      h.phone(1, { type: "send", threadId: "t", text: "read me the note" });
      h.event({ type: "message", message: userMessage("t", "read me the note", "phone") });
      const v = h.bridge.voiceFor("t")!;
      expect(v.where).toBe("phone");
      let heard: boolean | null = null;
      void v.play([Promise.resolve({ text: "One.", lang: "en" }), Promise.resolve(null)]).then((x) => (heard = x));
      await vi.advanceTimersByTimeAsync(0);
      const frames = h.sent.map((s) => s.frame.type).filter((t) => t !== "message");
      expect(frames).toEqual(["tts", "ttsEnd"]);
      // It's heard once the phone has had time to play it (2 s), less the lead.
      await vi.advanceTimersByTimeAsync(400);
      expect(heard).toBe(null);
      await vi.advanceTimersByTimeAsync(200);
      expect(heard).toBe(true);
      v.cut();
      expect(h.sent[h.sent.length - 1]).toEqual({ frame: { type: "ttsCut", threadId: "t", v: 1 }, conn: 1 });
      // A message from the desktop takes the thread's reads back.
      h.event({ type: "message", message: userMessage("t", "here now", "desktop") });
      expect(h.bridge.voiceFor("t")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the phone drive the reader, and never sends it images", () => {
    const h = harness();
    h.open(1);
    h.phone(1, { type: "reader", action: "next" });
    expect(h.handled[0].msg).toEqual({ type: "reader", action: "next" });
    h.event({
      type: "message",
      message: {
        ...userMessage("t", "", "duck"),
        content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "Captured" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
      },
    });
    const m = h.sent[h.sent.length - 1].frame as { message: { content: unknown } };
    expect(JSON.stringify(m.message.content)).not.toContain("AAAA");
    expect(JSON.stringify(m.message.content)).toContain("not kept");
  });
  it("says an announcement on every open phone, and lets a phone set Do Not Disturb", async () => {
    const h = harness();
    h.open(1);
    h.open(2);
    expect(h.bridge.phones()).toBe(2);
    h.bridge.announce("The research is done. Tests pass.", "t");
    await vi.waitFor(() => expect(h.sent.filter((s) => s.frame.type === "ttsEnd")).toHaveLength(2));
    const parts = h.sent.filter((s) => s.frame.type === "tts").map((s) => [s.conn, (s.frame as { reply: string; part: number }).part]);
    expect(parts).toEqual([[1, 0], [2, 0], [1, 1], [2, 1]]);
    expect((h.sent[0].frame as { reply: string }).reply).toMatch(/^news/);
    h.phone(1, { type: "dnd", until: 123 });
    expect(h.handled[0].msg).toEqual({ type: "dnd", until: 123 });
  });
  it("says a stock acknowledgement when a spoken reply has nothing to say yet", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.open(1);
      h.phone(1, { type: "send", threadId: "t", text: "check api", speak: true });
      h.event({ type: "message", message: userMessage("t", "check api", "phone") });
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.render).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.render).toHaveBeenCalledWith("One moment.", "en");
      // One that started with its own acknowledgement gets none.
      h.phone(1, { type: "send", threadId: "u", text: "check tests", speak: true });
      h.event({ type: "message", message: userMessage("u", "check tests", "phone") });
      h.event({ type: "delta", threadId: "u", text: "Checking the tests. " });
      h.event({ type: "tool", threadId: "u", phase: "start", toolUseId: "x", name: "read_session", input: {} });
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.render.mock.calls.map((c) => c[0])).toEqual(["One moment.", "Checking the tests."]);
    } finally {
      vi.useRealTimers();
    }
  });
});
