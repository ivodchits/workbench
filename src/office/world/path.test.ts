import { describe, expect, it } from "vitest";

import { buildOffice, cellOf, isFree, type Point, type WalkGrid } from "../map/build";
import { findPath, nearestFree } from "./path";

/** A grid from rows of "." (free) and "#" (blocked). */
function grid(rows: string[]): WalkGrid {
  const cols = rows[0].length;
  const blocked = new Uint8Array(cols * rows.length);
  rows.forEach((r, y) => [...r].forEach((c, x) => (blocked[y * cols + x] = c === "#" ? 1 : 0)));
  return { cols, rows: rows.length, blocked };
}

const turns = (path: Point[]) =>
  path.filter((_, i) => i > 0 && i < path.length - 1 && path[i - 1].x !== path[i + 1].x && path[i - 1].y !== path[i + 1].y).length;

function expectWalkable(walk: WalkGrid, path: Point[]): void {
  path.forEach((c, i) => {
    if (i === 0) return;
    expect(isFree(walk, c), `${c.x},${c.y}`).toBe(true);
    expect(Math.abs(c.x - path[i - 1].x) + Math.abs(c.y - path[i - 1].y)).toBe(1);
  });
}

describe("A* on the walk grid", () => {
  const open = grid(Array<string>(8).fill("........"));

  it("finds a shortest path, in 4-way steps", () => {
    const path = findPath(open, { x: 0, y: 0 }, { x: 5, y: 3 })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 5, y: 3 });
    expect(path.length).toBe(5 + 3 + 1);
    expectWalkable(open, path);
  });

  it("walks in straight legs, not a staircase", () => {
    expect(turns(findPath(open, { x: 0, y: 0 }, { x: 7, y: 7 })!)).toBe(1);
  });

  it("goes round walls, and gives up when there is no way", () => {
    const walled = grid(["....#...", "....#...", "........", "....#...", "....#..."]);
    const path = findPath(walled, { x: 0, y: 0 }, { x: 7, y: 0 })!;
    expect(path.some((c) => c.y === 2 && c.x === 4)).toBe(true);
    expectWalkable(walled, path);
    const shut = grid(["....#...", "....#...", "....#..."]);
    expect(findPath(shut, { x: 0, y: 0 }, { x: 7, y: 0 })).toBeNull();
    expect(findPath(shut, { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
  });

  it("may start on a blocked cell, but never steps onto one", () => {
    const chair = grid(["#...", "...."]);
    const path = findPath(chair, { x: 0, y: 0 }, { x: 3, y: 1 })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expectWalkable(chair, path);
  });

  it("steps round cells it is told to avoid", () => {
    const person = { x: 3, y: 0 };
    const path = findPath(grid(["......", "......"]), { x: 0, y: 0 }, { x: 5, y: 0 }, (c) => c.x === person.x && c.y === person.y)!;
    expect(path.some((c) => c.x === person.x && c.y === person.y)).toBe(false);
  });

  it("finds the nearest free cell, among the allowed ones", () => {
    const g = grid(["...", ".#.", "..."]);
    expect(nearestFree(g, { x: 1, y: 1 })).not.toEqual({ x: 1, y: 1 });
    expect(nearestFree(g, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    const only = new Uint8Array(9);
    only[8] = 1;
    expect(nearestFree(g, { x: 0, y: 0 }, only)).toEqual({ x: 2, y: 2 });
  });
});

describe("paths through the office", () => {
  const office = buildOffice();

  it("reaches every desk from the door without crossing furniture", () => {
    for (const s of office.seats) {
      const path = findPath(office.walk, cellOf(office.door), cellOf(s.stand));
      expect(path, `desk ${s.index}`).not.toBeNull();
      expectWalkable(office.walk, path!);
    }
  });
});
