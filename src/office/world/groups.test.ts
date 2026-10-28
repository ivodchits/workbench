import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { behave } from "./behave";
import { createWorld } from "./entities";
import { dice, instance, snapshot, testStaff } from "./fixtures";
import { CHEER_FOR, GOALS_TO_WIN, SCENES_PER_CHAT, SCENE_WAIT, ballAt, facings, kickerScore, lineFor, newMatch, type GroupEvent, type SceneWriter } from "./groups";
import { stepWalkers } from "./move";
import { seatSessions } from "./sessions";

const office = buildOffice();

describe("a kicker match", () => {
  it("runs to five goals, one side winning", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const m = newMatch("a", "b", 1000, dice(seed));
      const [w, e] = kickerScore(m, m.end);
      expect(Math.max(w, e)).toBe(GOALS_TO_WIN);
      expect(Math.min(w, e)).toBeLessThan(GOALS_TO_WIN);
      expect(kickerScore(m, m.start)).toEqual([0, 0]);
      expect(m.goals.every((g, i) => i === 0 || g.at > m.goals[i - 1].at)).toBe(true);
      expect(m.end).toBe(m.goals[m.goals.length - 1].at);
    }
  });

  it("keeps the ball on the table, and puts it in the net at each goal", () => {
    const m = newMatch("a", "b", 0, dice(4));
    for (let ms = 0; ms < m.end; ms += 37) {
      const b = ballAt(m, ms);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(1);
    }
    for (const g of m.goals) {
      const b = ballAt(m, g.at - 1);
      expect(Math.abs(b.x - (g.side === "west" ? 1 : 0))).toBeLessThan(0.01);
    }
  });
});

describe("idle workers together", () => {
  /** An office for `minutes` with a few sessions working, as the page steps it: what
   *  went in the log, and what was seen along the way. */
  function run(minutes: number, seed: number, hour = 15) {
    const world = createWorld(office);
    const staff = testStaff();
    staff.hour = () => hour;
    staff.random = dice(seed);
    let ms = 0;
    seatSessions(office, world, staff, snapshot(["a", "b", "c"].map((id) => instance(id, "misc"))), ms, () => 0);
    const log: string[] = [];
    let tvAlone = 0;
    let saidAtCooler = 0;
    let movedMidMatch = 0;
    for (const end = minutes * 60_000; ms < end; ) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
      log.push(...staff.events.map((e) => e.text));
      staff.events.length = 0;
      const onSofa = world.workers.filter((w) => staff.idle.get(w.worker.id)?.activity === "sofa" && staff.idle.get(w.worker.id)?.until !== null && !w.walk);
      if (world.tv && onSofa.length < 2) tvAlone++;
      for (const w of world.workers) if (w.bubble?.tone === "say" && staff.idle.get(w.worker.id)?.activity === "cooler") saidAtCooler++;
      const m = world.kicker;
      if (m && ms < m.end + CHEER_FOR) for (const id of [m.west, m.east]) if (world.workers.find((w) => w.worker.id === id)!.walk) movedMidMatch++;
    }
    return { log, tvAlone, saidAtCooler, movedMidMatch };
  }

  it("chat at the cooler, play the kicker and the console by themselves, in an ordinary afternoon", () => {
    for (const seed of [2, 3, 4]) {
      const { log, tvAlone, saidAtCooler, movedMidMatch } = run(30, seed);
      expect(log.some((l) => l.endsWith("are chatting at the water cooler")), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(log.some((l) => l.endsWith("got the console out")), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(log.some((l) => / beat .* 5:\d at the kicker$/.test(l)), `seed ${seed}: ${log.join(" | ")}`).toBe(true);
      expect(saidAtCooler).toBeGreaterThan(0);
      expect(tvAlone).toBe(0);
      expect(movedMidMatch).toBe(0);
    }
  }, 30_000);
});

describe("scenes at the water cooler", () => {
  it("turns each one toward the others", () => {
    const f = facings([
      { id: "top", x: 474, y: 298 },
      { id: "left", x: 458, y: 314 },
      { id: "right", x: 490, y: 314 },
    ]);
    expect(Object.fromEntries(f)).toEqual({ top: "down", left: "right", right: "left" });
    expect(Object.fromEntries(facings([{ id: "a", x: 0, y: 0 }, { id: "b", x: 16, y: 16 }]))).toEqual({ a: "right", b: "left" });
    expect(facings([{ id: "alone", x: 0, y: 0 }]).size).toBe(0);
  });

  /** An afternoon with `writer` writing the cooler's scenes, stepped as the page steps
   *  it, letting the writer's promises settle between steps. */
  async function run(minutes: number, seed: number, writer: SceneWriter | null) {
    const world = createWorld(office);
    const staff = testStaff();
    staff.hour = () => 15;
    staff.random = dice(seed);
    staff.writer = writer;
    let ms = 0;
    seatSessions(office, world, staff, snapshot(["a", "b", "c"].map((id) => instance(id, "misc"))), ms, () => 0);
    const events: GroupEvent[] = [];
    /** What was said at the cooler, in order, and when each chat began. */
    const said: { ms: number; id: string; text: string }[] = [];
    const starts: number[] = [];
    let facingAway = 0;
    const up = new Map<string, string>();
    const away = new Set<string>();
    for (const end = minutes * 60_000; ms < end; ) {
      stepWalkers(world, office, (ms += 100));
      behave(office, world, staff, ms);
      // A chat's key says when it began (it may have been before this step).
      for (const e of staff.events) if (e.kind === "chat" && !e.line) starts.push(Number(e.key.slice("chat:".length)));
      events.push(...staff.events);
      staff.events.length = 0;
      const chatting = world.workers.filter((w) => staff.idle.get(w.worker.id)?.activity === "cooler" && staff.idle.get(w.worker.id)?.until !== null && !w.walk);
      if (chatting.length >= 2) {
        const want = facings(chatting.map((w) => ({ id: w.worker.id, x: w.x, y: w.y })));
        // Someone just arrived turns on the next step.
        for (const w of chatting) {
          const off = w.dir !== want.get(w.worker.id) && staff.groupFace.has(w.worker.id);
          if (off && away.has(w.worker.id)) facingAway++;
          if (off) away.add(w.worker.id);
          else away.delete(w.worker.id);
        }
      }
      for (const w of world.workers) {
        const text = w.bubble?.tone === "say" ? w.bubble.text : null;
        if (text && up.get(w.worker.id) !== text && staff.idle.get(w.worker.id)?.activity === "cooler") said.push({ ms, id: w.worker.id, text });
        if (text) up.set(w.worker.id, text);
        else up.delete(w.worker.id);
      }
      // The writer's promises settle between steps, as they would between frames.
      for (let n = 0; n < 4; n++) await null;
    }
    return { events, said, starts, facingAway };
  }

  const sceneFor = (ids: string[], n: number) => ({ lines: Array.from({ length: n }, (_, i) => ({ speaker: ids[i % ids.length], text: `Line ${i} by ${ids[i % ids.length]}` })), mood: null });

  it("plays a written scene line by line, in the log, facing each other, within two asks a chat", async () => {
    const asks: string[][] = [];
    const saids: string[][] = [];
    const writer: SceneWriter = async (ids, _place, said) => {
      asks.push(ids);
      saids.push(said);
      return sceneFor(ids, 4);
    };
    const { events, said, starts, facingAway } = await run(30, 2, writer);
    expect(starts.length).toBeGreaterThan(0);
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.length).toBeLessThanOrEqual(starts.length * SCENES_PER_CHAT);
    // The scene's lines, each by its speaker, in order.
    const scripted = said.filter((s) => s.text.startsWith("Line "));
    expect(scripted.length).toBeGreaterThan(0);
    for (const s of scripted) expect(s.text.endsWith(`by ${s.id}`)).toBe(true);
    const lines = events.flatMap((e) => (e.kind === "chat" && e.line ? [e.line] : []));
    expect(lines.length).toBe(scripted.length);
    expect(lines[0]).toMatch(/^[A-Z][a-z]+: Line 0 by /);
    // The log has one head per chat, not a line per canned remark.
    expect(events.filter((e) => e.kind === "chat" && !e.line).length).toBe(starts.length);
    expect(facingAway).toBe(0);
    // A chat's first ask starts afresh; a second carries on from its first scene.
    expect(saids[0]).toEqual([]);
    const followUp = saids.find((s) => s.length > 0);
    expect(followUp).toBeDefined();
    for (const l of followUp!) expect(l).toMatch(/^[A-Z][a-z]+: Line \d by [a-z]+$/);
  }, 60_000);

  it("waits a moment for a scene, then fills in with canned lines", async () => {
    const slow: SceneWriter = () => new Promise(() => {});
    const { said, starts } = await run(30, 2, slow);
    expect(said.length).toBeGreaterThan(0);
    for (const s of said) {
      const start = Math.max(...starts.filter((t) => t <= s.ms));
      if (s.ms - start < 10_000) expect(s.ms - start).toBeGreaterThanOrEqual(SCENE_WAIT);
    }
  }, 60_000);

  it("with no scene to be had, chats as before, asking again with each canned line", async () => {
    let asks = 0;
    const none: SceneWriter = async () => {
      asks++;
      return null;
    };
    const { said, starts, events } = await run(30, 3, none);
    expect(said.length).toBeGreaterThan(0);
    expect(asks).toBeGreaterThan(starts.length);
    expect(asks).toBeLessThanOrEqual(starts.length + said.length);
    expect(events.some((e) => e.kind === "chat" && e.line)).toBe(false);
  }, 60_000);

  it("gets its scene after all when the first ask came back empty (the page was hidden)", async () => {
    const tries = new Map<string, number>();
    const late: SceneWriter = async (ids) => {
      const key = ids.join();
      tries.set(key, (tries.get(key) ?? 0) + 1);
      return tries.get(key)! > 1 ? sceneFor(ids, 3) : null;
    };
    const { events } = await run(30, 2, late);
    expect(events.some((e) => e.kind === "chat" && e.line?.includes("Line 0"))).toBe(true);
  }, 60_000);

  it("gives the time a line stays up by its length", () => {
    expect(lineFor("Hi")).toBeLessThan(lineFor("Back in my day we called it Tuesday."));
  });
});
