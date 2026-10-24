// The phone's app reconnecting (H7): what the phone brain made offline goes to
// the desktop before the kept taps, and what the desktop took is dropped.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHostMessage } from "../remote/protocol";

const kept = new Map<string, string | null>();
const armed: { alarms: unknown[]; source: string }[] = [];

vi.mock("./native", () => ({
  inApp: () => true,
  onLaunch: async () => {},
  onTalkStop: async () => {},
  onReminderActed: async () => {},
  onMicError: async () => {},
  hostInfo: async () => ({ tools: ["phone_flashlight"], version: 1, locked: false }),
  runTool: async () => null,
  offlineGet: async (n: string) => kept.get(n) ?? null,
  offlinePut: async (n: string, v: string | null) => void kept.set(n, v),
  armReminders: async (alarms: unknown[], source: string) => void armed.push({ alarms, source }),
  takeReminderActions: async () => [{ id: "r1", action: "done" }],
}));

const { connected, initApp, onAppFrame } = await import("./duckApp");

const message = (seq: number, role: string, text: string, source: string) => ({ threadId: "t1", seq, ts: seq, role, content: [{ type: "text", text }], source });

describe("the app reconnecting (H7)", () => {
  beforeEach(() => {
    kept.clear();
    armed.length = 0;
  });

  it("sends the offline brain's reminders and threads first, then the taps, and drops what was taken", async () => {
    const r1 = { id: "r1", title: "Call the bank", state: "open", created: "2026-10-23T10:00", due: "2030-01-02T10:00" };
    const r2 = { id: "r2", title: "Not taken", state: "open", created: "2026-10-23T10:00" };
    kept.set("reminders", JSON.stringify([r1, r2]));
    kept.set(
      "threads",
      JSON.stringify({
        threads: [
          { row: { id: "t1", title: "", mode: "assistant", created: 0, updated: 0 }, messages: [message(0, "user", "remind me", "phone-voice"), message(1, "assistant", "Done.", "duck")] },
          { row: { id: "t2", title: "", mode: "assistant", created: 0, updated: 0 }, messages: [] },
        ],
        pending: [],
      }),
    );
    const posted: RemoteHostMessage[] = [];
    initApp({
      post: (m) => {
        posted.push(m);
        // The desktop takes r1 and the thread.
        if (m.type === "offline.sync") queueMicrotask(() => onAppFrame({ type: "offline.synced", reminders: ["r1"], threads: ["t1"], v: 1 }));
      },
      live: () => true,
      listen: () => {},
      talk: () => {},
      open: () => {},
      pushed: () => {},
      talkStopped: () => {},
      note: () => {},
    });
    await connected();
    expect(posted.map((m) => m.type)).toEqual(["hello", "offline.sync", "reminder.action"]);
    const sync = posted[1] as Extract<RemoteHostMessage, { type: "offline.sync" }>;
    expect(sync.reminders.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(sync.threads).toEqual([
      { id: "t1", title: "remind me", messages: [{ role: "user", text: "remind me", at: 0, voice: true }, { role: "assistant", text: "Done.", at: 1 }] },
    ]);
    // Kept: what wasn't taken, armed as the phone's own; the empty thread gone too.
    expect(JSON.parse(kept.get("reminders")!)).toEqual([r2]);
    expect(armed).toEqual([{ alarms: [], source: "phone" }]);
    expect(kept.get("threads")).toBeNull();
  });

  it("with nothing made offline, sends only the hello and the taps", async () => {
    const posted: string[] = [];
    initApp({ post: (m) => void posted.push(m.type), live: () => true, listen: () => {}, talk: () => {}, open: () => {}, pushed: () => {}, talkStopped: () => {}, note: () => {} });
    await connected();
    expect(posted).toEqual(["hello", "reminder.action"]);
  });
});
