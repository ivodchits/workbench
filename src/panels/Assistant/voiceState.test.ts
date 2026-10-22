import { describe, expect, it, vi } from "vitest";

vi.mock("./duckState", () => ({
  sendMessage: vi.fn(),
  setDrawerOpen: vi.fn(),
  openThread: vi.fn(),
  getDuckState: () => ({ current: "t-open" }),
}));
vi.mock("./replySpeech", () => ({ isSpeaking: () => false, onAnnounced: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("../../state/registry", () => ({ getRegistry: () => ({ projects: [], instances: [] }) }));
vi.mock("../../ipc/prefs", () => ({ getPref: vi.fn(async (_k: string, d: unknown) => d), setPref: vi.fn() }));
vi.mock("../../ipc/voice", () => {
  const on = () => vi.fn(async () => () => {});
  return {
    onConversationLevel: on(),
    onConversationState: on(),
    onVoiceState: on(),
    onVoiceTranscript: on(),
    onVoiceTurn: on(),
    voiceConfigure: vi.fn(async () => {}),
    voiceConversation: vi.fn(async () => {}),
    voiceConversationOn: vi.fn(async () => false),
  };
});

import * as ipc from "../../ipc/voice";
import type { ConversationState, VoiceTurn } from "../../ipc/voice";
import { openThread } from "./duckState";
import { onAnnounced } from "./replySpeech";
import { heardAnnouncement, initVoice, messageFor, REPLY_AFTER_MS, replyTarget, routeTurn } from "./voiceState";

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
