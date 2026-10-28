import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatterAnswer, ChatterRequest } from "../remote/chatter";
import type { RemoteProject } from "../remote/protocol";
import { createChatter, dayOf, projectsFor, sceneRequest, timeOf, type ChatterState } from "./chatter";
import type { Who } from "./describe";
import type { Link } from "./net";
import { ROSTER, type Team } from "./roster";
import { instance, snapshot } from "./world/fixtures";

const worker = (id: string) => ROSTER.find((w) => w.id === id)!;
const project = (id: string, lastCommitAt: number | null): RemoteProject => ({ id, name: id, group: null, remote: false, lastCommitAt, commitsToday: null });
const rooms: Record<string, Team> = { dem: "demiurge", twr: "tinywizard" };
const roomOf = (id: string): Team => rooms[id] ?? "open";

describe("a chatter request", () => {
  const felix: Who = { worker: worker("felix"), instance: instance("a", "dem", { projectName: "Demiurge", title: "fix the build" }), since: null };
  const mira: Who = { worker: worker("mira"), instance: null, since: null };
  const snap = { ...snapshot([]), projects: [project("misc", 10), project("dem", 5), project("side", 20), project("twr", 30)] };

  it("names the speakers' sessions' projects first, then their rooms', latest committed first", () => {
    expect(projectsFor([felix, mira], snap, roomOf)).toEqual(["dem", "side", "misc"]);
    expect(projectsFor([{ worker: worker("pip"), instance: null, since: null }], snap, roomOf)).toEqual(["twr"]);
  });

  it("says what each one is up to, where and when", () => {
    const now = new Date(2026, 9, 28, 14, 5);
    const req = sceneRequest(["felix", "mira"], "the water cooler", (id) => (id === "felix" ? felix : mira), snap, roomOf, now);
    expect(req).toMatchObject({ day: "2026-10-28", time: "Wednesday 14:05", place: "the water cooler", lines: 4 });
    expect(req.speakers[0].id).toBe("felix");
    expect(req.speakers[0].doing).toContain("Demiurge · fix the build");
    expect(req.speakers[0].doing).toMatch(/\(Demiurge\)$/);
    expect(req.speakers[1].doing).toBe("free, between sessions (Open space)");
    expect(dayOf(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(timeOf(new Date(2026, 0, 5, 9, 7))).toBe("Monday 09:07");
  });
});

describe("the chatter client", () => {
  const usage = { callsThisHour: 0, perHour: 20, tokensToday: 0, tokensPerDay: 50_000 };
  const on: ChatterState = { settings: { on: true, model: "haiku", perHour: 20, tokensPerDay: 50_000 }, usage };
  const req: ChatterRequest = { day: "2026-10-28", time: "", place: "", speakers: [], projects: [], lines: 4 };
  const scene = { lines: [{ speaker: "mira", text: "Hi" }, { speaker: "felix", text: "Hey" }], mood: null };

  let answers: ChatterAnswer[];
  let asked: number;
  const link = (state: ChatterState) =>
    ({
      chatter: async () => state,
      setChatter: async (patch: Partial<ChatterState["settings"]>) => ({ ...state, settings: { ...state.settings, ...patch } }),
      askScene: async () => {
        asked++;
        return answers.shift() ?? null;
      },
    }) as unknown as Link;

  beforeEach(() => {
    answers = [];
    asked = 0;
    vi.stubGlobal("document", { hidden: false });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks nothing at all while chatter is off", async () => {
    const c = createChatter(link({ ...on, settings: { ...on.settings, on: false } }), () => {});
    expect(await c.scene(req)).toBeNull();
    await c.refresh();
    expect(await c.scene(req, true)).toBeNull();
    expect(asked).toBe(0);
  });

  it("asks nothing before Workbench has said it's on, nor while the page is hidden", async () => {
    const c = createChatter(link(on), () => {});
    expect(await c.scene(req)).toBeNull();
    await c.refresh();
    vi.stubGlobal("document", { hidden: true });
    expect(await c.scene(req)).toBeNull();
    expect(asked).toBe(0);
  });

  it("returns the scene and keeps the usage", async () => {
    const c = createChatter(link(on), () => {});
    await c.refresh();
    answers.push({ status: "ok", scene, usage: { ...usage, callsThisHour: 1, tokensToday: 900 } });
    expect(await c.scene(req)).toEqual(scene);
    expect(c.state?.usage.tokensToday).toBe(900);
  });

  it("waits out a spent hour, and a spent day till the next", async () => {
    const c = createChatter(link(on), () => {});
    await c.refresh();
    answers.push({ status: "hour", usage });
    expect(await c.scene(req)).toBeNull();
    expect(await c.scene(req, true)).toBeNull();
    expect(asked).toBe(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    answers.push({ status: "day", usage });
    expect(await c.scene(req)).toBeNull();
    expect(await c.scene(req)).toBeNull();
    expect(asked).toBe(2);
    answers.push({ status: "ok", scene, usage });
    expect(await c.scene({ ...req, day: "2026-10-29" })).toEqual(scene);
  });

  it("holds off after a failure, unless asked by hand; turning it off stops it", async () => {
    const c = createChatter(link(on), () => {});
    await c.refresh();
    answers.push({ status: "error", message: "boom", usage });
    expect(await c.scene(req)).toBeNull();
    expect(c.lastError).toBe("boom");
    expect(await c.scene(req)).toBeNull();
    expect(asked).toBe(1);
    answers.push({ status: "ok", scene, usage });
    expect(await c.scene(req, true)).toEqual(scene);
    expect(c.lastError).toBeNull();
    answers.push({ status: "off", usage });
    vi.advanceTimersByTime(60_001);
    expect(await c.scene(req)).toBeNull();
    expect(c.state?.settings.on).toBe(false);
    expect(await c.scene(req, true)).toBeNull();
    expect(asked).toBe(3);
  });
});
