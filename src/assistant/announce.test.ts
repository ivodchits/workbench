import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Announcer, batchText, DEFAULT_ANNOUNCE, headline, nextMorning, type AnnounceDeps, type AnnounceSettings, type Presence } from "./announce";

const T0 = new Date(2026, 9, 21, 15, 0).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function setup(over: Partial<AnnounceSettings> = {}) {
  const w = {
    presence: { idleMs: 5000, locked: false, fullScreen: false, focus: false } as Presence,
    dnd: null as number | null,
    speakOn: true,
    busy: false,
    phones: 0,
    said: [] as string[],
    phoned: [] as string[],
    pushed: [] as string[],
  };
  const deps: AnnounceDeps = {
    settings: () => ({ ...DEFAULT_ANNOUNCE, ...over }),
    dndUntil: () => w.dnd,
    presence: async () => w.presence,
    speakOn: () => w.speakOn,
    busy: () => w.busy,
    sayHere: async (t) => {
      w.said.push(t);
      return true;
    },
    phones: () => w.phones,
    sayOnPhones: (t) => w.phoned.push(t),
    push: (_, title, body) => w.pushed.push(`${title}: ${body}`),
  };
  return { w, a: new Announcer(deps) };
}

const report = (text: string, key = text) => ({ level: "report" as const, text, threadId: "t", key });
const needs = (text: string, key = text) => ({ level: "needs_you" as const, text, threadId: "t", key });

describe("Announcer", () => {
  it("speaks a report here after it settles, once you pause", async () => {
    const { w, a } = setup();
    w.presence = { ...w.presence, idleMs: 200 };
    a.add(report("The auth research is done."));
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.said).toEqual([]);
    w.presence = { ...w.presence, idleMs: 1500 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.said).toEqual(["The auth research is done."]);
  });

  it("batches what arrives while it waits, then holds the next for the window", async () => {
    const { w, a } = setup();
    w.busy = true;
    a.add(report("The auth research is done."));
    await vi.advanceTimersByTimeAsync(10_000);
    a.add(needs("The backend session needs you."));
    w.busy = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.said).toEqual(["Two things. The auth research is done. The backend session needs you."]);
    a.add(report("Tests pass."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.said[1]).toBe("Tests pass.");
  });

  it("says nothing during Do Not Disturb or with Speak off, then catches up", async () => {
    const { w, a } = setup();
    w.dnd = T0 + 60 * 60_000;
    a.add(report("The research is done."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toEqual([]);
    expect(w.pushed).toEqual([]);
    w.dnd = null;
    a.poke();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toEqual(["While it was quiet: one thing. The research is done."]);
    w.speakOn = false;
    a.add(report("Another."));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.said).toHaveLength(1);
    // Speak off is this PC's: away, a phone with Duck open still hears it.
    w.presence = { ...w.presence, idleMs: 10 * 60_000 };
    w.phones = 1;
    a.add(report("For the phone."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.phoned).toEqual(["For the phone."]);
  });

  it("follows Windows Focus and quiet hours", async () => {
    const { w, a } = setup({ quietHours: { on: true, from: 14 * 60, to: 16 * 60 } });
    a.add(report("Quiet hours."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toEqual([]);
    const f = setup();
    f.w.presence = { ...f.w.presence, focus: true };
    f.a.add(report("Focus."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.w.said).toEqual([]);
  });

  it("stays quiet over a full-screen app except for what needs you", async () => {
    const { w, a } = setup();
    w.presence = { ...w.presence, fullScreen: true };
    a.add(report("A report."));
    a.add(needs("It needs you."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toEqual(["It needs you."]);
  });

  it("goes to the phone with Duck open when you're away, else a push", async () => {
    const { w, a } = setup();
    w.presence = { ...w.presence, idleMs: 10 * 60_000 };
    w.phones = 1;
    a.add(report("Done."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.phoned).toEqual(["Done."]);
    w.phones = 0;
    a.add(report("Also done."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.pushed).toEqual(["Duck: Also done."]);
    expect(w.said).toEqual([]);
  });

  it("pushes what needs you even in Do Not Disturb when you're away", async () => {
    const { w, a } = setup();
    w.dnd = T0 + 3_600_000;
    w.presence = { ...w.presence, locked: true };
    a.add(needs("A card waits."));
    a.add(report("A report."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.pushed).toEqual(["Duck: 2 updates: Two things. A card waits. A report."]);
  });

  it("repeats an unanswered needs_you once, not an answered one", async () => {
    const { w, a } = setup();
    a.add(needs("A card waits.", "card:1"));
    a.add(needs("Another card.", "card:2"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toHaveLength(1);
    a.answered("card:2");
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5000);
    expect(w.said[1]).toBe("Still waiting: A card waits.");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(w.said).toHaveLength(2);
  });

  it("leaves info to the badge", async () => {
    const { w, a } = setup();
    a.add({ level: "info", text: "Housekeeping ran.", threadId: "t", key: "i" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.said).toEqual([]);
    expect(w.pushed).toEqual([]);
  });
});

describe("texts", () => {
  it("takes a reply's first sentence, two when it's short", () => {
    expect(headline("The auth research is done: use Passkeys first. Details follow.\n\n- one")).toBe("The auth research is done: use Passkeys first.");
    expect(headline("Done. Tests pass now. More.")).toBe("Done. Tests pass now.");
  });

  it("batches and catches up", () => {
    expect(batchText([{ text: "A." }])).toBe("A.");
    expect(batchText([{ text: "A." }, { text: "B." }])).toBe("Two things. A. B.");
    expect(batchText([1, 2, 3, 4].map((n) => ({ text: `${n}.` })), "Lead.")).toBe("Lead. 1. 2. 3. And 1 more in the drawer.");
  });

  it("finds the next morning", () => {
    expect(new Date(nextMorning(T0)).getDate()).toBe(22);
    expect(new Date(nextMorning(new Date(2026, 9, 21, 6, 0).getTime())).getHours()).toBe(8);
  });
});

describe("set_quiet and the settings", async () => {
  const { setQuiet } = await import("./tools/quiet");
  const { cleanSettings, DND_FOREVER } = await import("./settings");
  const { fakePort, toolCtx } = await import("./fakePort.test-util");

  it("sets Do Not Disturb and Speak", async () => {
    const set: (number | null)[] = [];
    let speak: boolean | null = true;
    const ctx = {
      ...toolCtx(fakePort()),
      quiet: { setDnd: (u: number | null) => void set.push(u), speakOn: () => speak, setSpeakOn: (on: boolean) => void (speak = on) },
    };
    expect(await setQuiet.run({ dnd: "1h" }, ctx)).toMatchObject({ dnd: expect.stringContaining("on until") });
    expect(set[0]).toBe(T0 + 3_600_000);
    await setQuiet.run({ dnd: "on", speak: false }, ctx);
    expect(set[1]).toBe(DND_FOREVER);
    expect(speak).toBe(false);
    await setQuiet.run({ dnd: "off" }, ctx);
    expect(set[2]).toBeNull();
    await expect(Promise.resolve().then(() => setQuiet.run({}, ctx))).rejects.toThrow("dnd or speak");
  });

  it("keeps only sane announcement settings", () => {
    const out = cleanSettings({ dndUntil: -5, announce: { batchSeconds: 99999, speak: { info: "loud" }, quietHours: { on: true, from: 1380 } } });
    expect(out.dndUntil).toBeUndefined();
    expect(out.announce?.batchSeconds).toBe(600);
    expect(out.announce?.speak.info).toBe("never");
    expect(out.announce?.quietHours).toEqual({ on: true, from: 1380, to: 480 });
  });
});
