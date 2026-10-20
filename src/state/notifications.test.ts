// The done alert's body (step W3): Duck's summary headline when it sets one and it
// comes in time, else the turn's last line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HookEnvelope } from "../ipc/hooks";

const hooks: ((env: HookEnvelope) => void)[] = [];
// No DOM here: the window never has focus, so nothing counts as watched.
vi.stubGlobal("document", { hasFocus: () => false });

vi.mock("../ipc/attention", () => ({
  notifyAlert: vi.fn(() => Promise.resolve()),
  notifyNeedsYou: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc/hooks", () => ({
  onHookEvent: vi.fn((cb: (env: HookEnvelope) => void) => {
    hooks.push(cb);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../ipc/remote", () => ({ remotePushSend: vi.fn(() => Promise.resolve()) }));
vi.mock("../ipc/prefs", () => ({
  getPref: vi.fn(() => new Promise(() => {})),
  setPref: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc/transcript", () => ({ onTurnEnded: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./status", () => ({
  getLiveStatuses: () => new Map(),
  onStatusTransition: vi.fn(),
}));
vi.mock("./registry", () => ({
  getRegistry: () => ({
    projects: [{ id: "p1", name: "Backend" }],
    instances: [{ id: "i1", projectId: "p1", title: "api", taskNote: null }],
  }),
}));
vi.mock("./dock", () => ({ getActivePanelId: () => null }));
vi.mock("./duckOwned", () => ({ duckTask: () => null }));
vi.mock("./promptHold", () => ({ shouldTell: () => Promise.resolve(true) }));

const { notifyAlert } = await import("../ipc/attention");
const { remotePushSend } = await import("../ipc/remote");
const { initNotifications, setDoneSummary } = await import("./notifications");

function stop(name = "Stop") {
  for (const h of hooks)
    h({
      instanceId: "i1",
      event: { hook_event_name: name, last_assistant_message: "All done, the tests pass." },
    } as unknown as HookEnvelope);
}

beforeEach(() => {
  vi.useFakeTimers();
  initNotifications();
  vi.mocked(notifyAlert).mockClear();
  vi.mocked(remotePushSend).mockClear();
});
afterEach(() => {
  setDoneSummary(null);
  vi.useRealTimers();
});

describe("done alerts", () => {
  it("use the last line without a summarizer", () => {
    stop();
    expect(notifyAlert).toHaveBeenCalledWith("○ done · Backend.api", "All done, the tests pass.");
  });

  it("use the summary headline when it comes", async () => {
    const make = vi.fn(() => Promise.resolve("Fixed the login redirect; tests pass."));
    setDoneSummary(make);
    stop();
    // The hook's whole final reply goes along: the transcript may not have it yet.
    expect(make).toHaveBeenCalledWith("i1", "All done, the tests pass.");
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyAlert).toHaveBeenCalledWith("○ done · Backend.api", "Fixed the login redirect; tests pass.");
    expect(remotePushSend).toHaveBeenCalledWith("i1", "○ done · Backend.api", "Fixed the login redirect; tests pass.");
  });

  it("fall back to the last line when the summary is off, fails or is late", async () => {
    setDoneSummary(() => Promise.resolve(null));
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyAlert).toHaveBeenLastCalledWith("○ done · Backend.api", "All done, the tests pass.");

    setDoneSummary(() => Promise.reject(new Error("no key")));
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifyAlert).toHaveBeenCalledTimes(2);

    setDoneSummary(() => new Promise(() => {}));
    stop();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(notifyAlert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notifyAlert).toHaveBeenCalledTimes(3);
    expect(notifyAlert).toHaveBeenLastCalledWith("○ done · Backend.api", "All done, the tests pass.");
  });

  it("don't summarize a turn that stopped on an error", async () => {
    const make = vi.fn(() => Promise.resolve("headline"));
    setDoneSummary(make);
    stop("StopFailure");
    await vi.advanceTimersByTimeAsync(0);
    expect(make).not.toHaveBeenCalled();
    expect(notifyAlert).toHaveBeenCalledWith("○ done · Backend.api", "Stopped on an error.");
  });
});
