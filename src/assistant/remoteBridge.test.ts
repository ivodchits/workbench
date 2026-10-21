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
  const stop = startRemoteBridge({
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
  return { handled, sent, pushes, render, warm, stop, event, phone, open, close };
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
    h.event({ type: "delta", threadId: "t", text: "Two sessions need you. Api " });
    // The first sentence goes out while the reply is still streaming.
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledWith("Two sessions need you.", "en"));
    const tts = () => h.sent.filter((s) => s.frame.type === "tts" || s.frame.type === "ttsEnd");
    await vi.waitFor(() =>
      expect(tts()).toEqual([
        { frame: { type: "tts", threadId: "t", reply: "r1", part: 0, id: "a1", seconds: 2, v: 1 }, conn: 1 },
      ]),
    );
    h.event({ type: "delta", threadId: "t", text: "waits for approval." });
    h.event({ type: "turnState", threadId: "t", state: "idle", queued: 0 });
    await vi.waitFor(() => expect(tts()).toHaveLength(3));
    expect(h.render).toHaveBeenLastCalledWith("Api waits for approval.", "en");
    expect(tts().slice(1)).toEqual([
      { frame: { type: "tts", threadId: "t", reply: "r1", part: 1, id: "a2", seconds: 2, v: 1 }, conn: 1 },
      { frame: { type: "ttsEnd", threadId: "t", reply: "r1", parts: 2, v: 1 }, conn: 1 },
    ]);
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
});
