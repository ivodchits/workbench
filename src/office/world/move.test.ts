import { describe, expect, it } from "vitest";

import { WALK_CELL, buildOffice, cellOf, isFree, type Point } from "../map/build";
import { createWorld, type WorkerEntity, type World } from "./entities";
import { REPATH_AFTER, SQUEEZE_AFTER, enter, landing, leave, stepWalkers, walkTo } from "./move";
import { findPath } from "./path";

const office = buildOffice();
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const centre = (c: Point) => ({ x: c.x * WALK_CELL + WALK_CELL / 2, y: c.y * WALK_CELL + WALK_CELL / 2 });

/** Steps until `w` stops walking; every position along the way. */
function walkOut(world: World, w: WorkerEntity, most = 2000): Point[] {
  const seen: Point[] = [{ x: w.x, y: w.y }];
  let ms = 0;
  for (let n = 0; w.walk && n < most; n++) {
    stepWalkers(world, office, (ms += 100));
    seen.push({ x: w.x, y: w.y });
  }
  expect(w.walk, "still walking").toBeNull();
  return seen;
}

/** Puts `b` on their feet at `at`. */
function standAt(b: WorkerEntity, at: Point): void {
  Object.assign(b, { seat: null, ...at, prev: { ...at } });
}

describe("walking", () => {
  it("gets up, walks to a point without stepping on furniture, and faces the way it goes", () => {
    const world = createWorld(office);
    const w = world.workers[0];
    const to = landing(office, { x: 40, y: 300 });
    expect(walkTo(office, w, to, 0)).toBe(true);
    expect(w.seat).toBeNull();
    expect(w.anim).toBe("walk");
    let last = { x: w.x, y: w.y };
    let ms = 0;
    while (w.walk) {
      stepWalkers(world, office, (ms += 100));
      expect(isFree(office.walk, cellOf(w)), `${w.x},${w.y}`).toBe(true);
      const dx = w.x - last.x;
      const dy = w.y - last.y;
      if (dx && !dy) expect(w.dir).toBe(dx > 0 ? "right" : "left");
      if (dy && !dx) expect(w.dir).toBe(dy > 0 ? "down" : "up");
      last = { x: w.x, y: w.y };
    }
    expect({ x: w.x, y: w.y }).toEqual(landing(office, to));
    expect(w.anim).toBe("idle");
  });

  it("sends a point on furniture to the nearest place that can be reached", () => {
    const desk = office.seats[0].desk;
    const at = landing(office, { x: desk.x + 4, y: desk.y + 4 });
    expect(isFree(office.walk, cellOf(at))).toBe(true);
  });

  it("sits down at the end of a walk to a desk", () => {
    const world = createWorld(office);
    const [w] = world.workers;
    const other = office.seats.find((s) => !world.workers.some((o) => o.seat === s.index))!;
    walkTo(office, w, other.stand, 0, { kind: "sit", seat: other.index });
    walkOut(world, w);
    expect(w.seat).toBe(other.index);
    expect([w.dir, w.anim]).toEqual(["up", "type"]);
  });

  it("leaves through the door and comes back in", () => {
    const world = createWorld(office);
    const [w] = world.workers;
    leave(office, w, 0);
    expect(walkOut(world, w).slice(-1)[0]).toEqual(office.door);
    expect(w.away).toBe(true);
    expect(walkTo(office, w, { x: 100, y: 100 }, 0)).toBe(false);

    enter(office, w, office.seats[w.home].stand, 0, { kind: "sit", seat: w.home });
    expect([w.away, w.x, w.y]).toEqual([false, office.door.x, office.door.y]);
    walkOut(world, w);
    expect(w.seat).toBe(w.home);
  });
});

describe("other people in the way", () => {
  it("waits, then finds a way round someone standing in the way", () => {
    const world = createWorld(office);
    const [w, b] = world.workers;
    const to = landing(office, { x: 40, y: 300 });
    const cells = findPath(office.walk, cellOf(office.seats[w.home].stand), cellOf(to))!;
    standAt(b, centre(cells[Math.floor(cells.length / 2)]));
    walkTo(office, w, to, 0);
    const path = walkOut(world, w);
    expect(path.some((p) => same(cellOf(p), cellOf(b)))).toBe(false);
    expect(path.length).toBeGreaterThan(REPATH_AFTER);
  });

  it("squeezes past when there is no way round", () => {
    const world = createWorld(office);
    const [w, b] = world.workers;
    const to = landing(office, { x: 40, y: 300 });
    standAt(b, to);
    walkTo(office, w, to, 0);
    const path = walkOut(world, w);
    expect(path[path.length - 1]).toEqual(to);
    expect(path.length).toBeGreaterThan(SQUEEZE_AFTER);
  });
});
