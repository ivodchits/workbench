import { describe, expect, it, vi } from "vitest";

vi.mock("./duckState", () => ({ sendMessage: vi.fn(), setDrawerOpen: vi.fn() }));
vi.mock("./replySpeech", () => ({ isSpeaking: () => false, onAnnounced: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("../../state/registry", () => ({ getRegistry: () => ({ projects: [], instances: [] }) }));

import type { VoiceTurn } from "../../ipc/voice";
import { messageFor, routeTurn } from "./voiceState";

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
      open: (t: string) => log.push(`open ${t}`),
    };
    const turn = (id: number, phase: VoiceTurn["phase"], text = "") =>
      routeTurn({ run: 1, id, text, phase, window: false }, d, text);
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
