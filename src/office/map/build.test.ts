import { describe, expect, it } from "vitest";

import { DESKS, MAP_H, MAP_W, TILE } from "./office";
import { WALK_CELL, buildOffice, cellOf, isFree, reachable, type Point } from "./build";

const office = buildOffice();
const fromDoor = reachable(office.walk, cellOf(office.door));
const canReach = (p: Point) => {
  const c = cellOf(p);
  return isFree(office.walk, c) && fromDoor[c.y * office.walk.cols + c.x] === 1;
};
/** Seats on a sofa or round a table are on the furniture: next to a reachable cell is enough. */
const canReachBeside = (p: Point) =>
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 2], [0, -2]].some(([dx, dy]) =>
    canReach({ x: p.x + dx * WALK_CELL, y: p.y + dy * WALK_CELL }),
  );

describe("office map", () => {
  it("has a seat per desk: 4 Demiurge, 2 TinyWizardRoyale, 8 open space", () => {
    const count = (room: string) => office.seats.filter((s) => s.room === room).length;
    expect(office.seats.length).toBe(DESKS.length);
    expect([count("demiurge"), count("tinywizard"), count("open")]).toEqual([4, 2, 8]);
  });

  it("keeps every prop on the canvas", () => {
    for (const p of office.props) {
      expect(p.x, p.id).toBeGreaterThanOrEqual(0);
      expect(p.y, p.id).toBeGreaterThanOrEqual(0);
      expect(p.x + p.prop.w, p.id).toBeLessThanOrEqual(MAP_W * TILE);
      expect(p.y + p.prop.h, p.id).toBeLessThanOrEqual(MAP_H * TILE);
    }
  });

  it("sorts props by their draw edge", () => {
    const bases = office.props.map((p) => p.base);
    expect(bases).toEqual([...bases].sort((a, b) => a - b));
  });

  it("can walk from the door to every desk and intern spot", () => {
    for (const s of office.seats) {
      expect(canReach(s.stand), `desk ${s.index} (${s.room}) stand`).toBe(true);
      expect(canReach(s.intern), `desk ${s.index} (${s.room}) intern`).toBe(true);
    }
  });

  it("can walk from the door to every spot", () => {
    for (const s of office.spots) expect(canReachBeside(s), s.id).toBe(true);
  });

  it("has no two spots on top of each other", () => {
    const taken = new Set<string>();
    for (const s of office.spots) {
      const key = `${s.x},${s.y}`;
      expect(taken.has(key), s.id).toBe(false);
      taken.add(key);
    }
  });
});
