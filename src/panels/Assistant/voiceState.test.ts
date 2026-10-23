import { describe, expect, it, vi } from "vitest";

const duck = vi.hoisted(() => ({
  mode: "assistant",
  listeners: [] as (() => void)[],
  conversation: null as ((s: import("../../ipc/voice").ConversationState) => void) | null,
  wakeToggle: null as ((on: boolean) => void) | null,
}));
vi.mock("./duckState", () => ({
  sendMessage: vi.fn(),
  setDrawerOpen: vi.fn(),
  openThread: vi.fn(),
  getDuckState: () => ({ current: "t-open" }),
  currentMode: () => duck.mode,
  subscribeDuck: (cb: () => void) => duck.listeners.push(cb),
}));
vi.mock("./replySpeech", () => ({ isSpeaking: () => false, onAnnounced: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("../../state/registry", () => ({ getRegistry: () => ({ projects: [], instances: [] }) }));
vi.mock("../../ipc/prefs", () => ({ getPref: vi.fn(async (_k: string, d: unknown) => d), setPref: vi.fn() }));
vi.mock("../../ipc/voice", () => {
  const on = () => vi.fn(async () => () => {});
  return {
    onConversationLevel: on(),
    onConversationState: vi.fn(async (cb: (s: ConversationState) => void) => {
      duck.conversation = cb;
      return () => {};
    }),
    onVoiceState: on(),
    onVoiceTranscript: on(),
    onVoiceTurn: on(),
    voiceConfigure: vi.fn(async () => {}),
    voiceConversation: vi.fn(async () => {}),
    voiceConversationOn: vi.fn(async () => false),
    voiceConversationPatience: vi.fn(async () => {}),
    onWakeState: on(),
    onWakeToggle: vi.fn(async (cb: (on: boolean) => void) => {
      duck.wakeToggle = cb;
      return () => {};
    }),
    voiceWakeState: vi.fn(async () => ({ on: false, listening: false, hold: null, error: null })),
  };
});

import * as ipc from "../../ipc/voice";
import type { ConversationState, VoiceTurn } from "../../ipc/voice";
import { openThread } from "./duckState";
import { onAnnounced } from "./replySpeech";
import {
  getVoiceState,
  heardAnnouncement,
  initVoice,
  messageFor,
  REPLY_AFTER_MS,
  replyTarget,
  routeTurn,
  wakeLine,
} from "./voiceState";

describe("a transcript as a message", () => {
  it("is sent as said, or with the words as heard beside a fix", () => {
    expect(messageFor({ text: " What is api doing? " }, ["api"])).toBe("What is api doing?");
    expect(messageFor({ text: "Открой пул реквест для воркбенча" }, ["Workbench"])).toBe(
      'Открой pull request для Workbench\n\n(voice; as heard: "Открой пул реквест для воркбенча")',
    );
  });
});

describe("conversation mode's turns (V4)", () => {
  function harness(current: string | null, canStart = true) {
    const log: string[] = [];
    const d = {
      current: () => current,
      provisional: (t: string | null, text: string) => {
        log.push(`provisional ${t} ${text}`);
        return canStart && t !== null;
      },
      commit: (t: string) => log.push(`commit ${t}`),
      withdraw: (t: string) => log.push(`withdraw ${t}`),
      send: (text: string) => log.push(`send ${text}`),
    };
    const turn = (id: number, phase: VoiceTurn["phase"], text = "") => routeTurn({ run: 1, id, text, phase }, d, text);
    return { log, turn };
  }

  it("start provisionally, are withdrawn when you go on, and the merged one commits", () => {
    const { log, turn } = harness("t1");
    turn(1, "provisional", "restart the api");
    turn(1, "withdrawn");
    turn(2, "provisional", "restart the api and the web");
    turn(2, "final", "restart the api and the web");
    expect(log).toEqual([
      "provisional t1 restart the api",
      "withdraw t1",
      "provisional t1 restart the api and the web",
      "commit t1",
    ]);
  });

  it("wait to be final when the thread can't start one now", () => {
    const { log, turn } = harness("t1", false);
    turn(1, "provisional", "what needs me?");
    turn(1, "withdrawn");
    turn(2, "provisional", "what needs me now?");
    turn(2, "final", "what needs me now?");
    expect(log).toEqual(["provisional t1 what needs me?", "provisional t1 what needs me now?", "send what needs me now?"]);
  });
});

describe("after an announcement (V8)", () => {
  it("the mic stays off, and turning it on replies in the announcement's thread", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await initVoice();
    const said = vi.mocked(onAnnounced).mock.calls[0][0];
    said("t-news");
    // Nothing listens by itself.
    expect(ipc.voiceConversation).not.toHaveBeenCalled();
    expect(openThread).not.toHaveBeenCalled();

    // You turn it on (the key): the announcement's thread opens first.
    const state = vi.mocked(ipc.onConversationState).mock.calls[0][0];
    const s = (state: ConversationState["state"]): ConversationState => ({
      run: 1,
      state,
      held: false,
      duplex: false,
      message: null,
      cancelling: false,
      suppression: null,
      output: null,
    });
    state(s("preparing"));
    expect(openThread).toHaveBeenCalledExactlyOnceWith("t-news");
    // Once: the next run doesn't move threads again.
    state(s("off"));
    state({ ...s("preparing"), run: 2 });
    expect(openThread).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("is a reply only within a minute", () => {
    heardAnnouncement("t1", 1000);
    expect(replyTarget(1000 + REPLY_AFTER_MS)).toBe("t1");
    expect(replyTarget(1000 + REPLY_AFTER_MS)).toBeNull();
    heardAnnouncement("t2", 1000);
    expect(replyTarget(1001 + REPLY_AFTER_MS)).toBeNull();
  });
});

describe("conversation mode's pauses (S1)", () => {
  it("follow the thread its turns go to", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await initVoice();
    const state = duck.conversation!;
    const s = (st: ConversationState["state"], run = 5): ConversationState => ({
      run,
      state: st,
      held: false,
      duplex: false,
      message: null,
      cancelling: false,
      suppression: null,
      output: null,
    });
    const asked = vi.mocked(ipc.voiceConversationPatience);
    asked.mockClear();
    // The assistant's thread: your setting (quick), which the run started on.
    state(s("preparing"));
    state(s("listening"));
    expect(asked).not.toHaveBeenCalled();
    // Into a duck thread: it waits for you to think.
    duck.mode = "duck";
    for (const l of duck.listeners) l();
    expect(asked).toHaveBeenCalledExactlyOnceWith("thinking");
    // Off, then on again in it: the new run starts on the setting, so it's said again.
    state(s("off"));
    state(s("preparing", 6));
    state(s("listening", 6));
    expect(asked).toHaveBeenCalledTimes(2);
    duck.mode = "assistant";
    vi.unstubAllGlobals();
  });
});

describe("the wake word (V6)", () => {
  it("is off by default, and the tray's item turns the setting on and hands it over", async () => {
    await initVoice();
    expect(getVoiceState().prefs.wake).toBe(false);
    expect(getVoiceState().wake).toEqual({ on: false, listening: false, hold: null, error: null });
    const sent = vi.mocked(ipc.voiceConfigure).mock.calls;
    duck.wakeToggle?.(true);
    expect(getVoiceState().prefs.wake).toBe(true);
    expect(sent[sent.length - 1][0]).toMatchObject({ wake: true, wakeSensitivity: 0.5, wakeFullScreen: true, wakeBattery: true });
    duck.wakeToggle?.(false);
    expect(sent[sent.length - 1][0]).toMatchObject({ wake: false });
  });

  it("says what it's doing: an error first, then why it's deaf, then listening", () => {
    const w = { on: true, listening: false, hold: null, error: null };
    expect(wakeLine({ ...w, error: "The microphone didn't open: gone" })).toBe("The microphone didn't open: gone");
    expect(wakeLine({ ...w, hold: "call" })).toMatch(/another app/);
    expect(wakeLine({ ...w, hold: "busy" })).toMatch(/^Paused/);
    expect(wakeLine({ ...w, listening: true })).toMatch(/^Listening/);
    expect(wakeLine(w)).toMatch(/^Starting/);
  });
});
