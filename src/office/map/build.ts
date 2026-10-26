// Turns the floor plan (office.ts) into what the office runs on: the floor of every
// tile, the furniture as positioned props with draw-order edges, the seats at each
// desk, and an 8px walkability grid for pathfinding.

import { PROPS, glass, glassSide, partition, partitionSide, type FloorKind, type Prop } from "../art/props";
import {
  DESKS,
  DOOR,
  DUCK_AT,
  FLOOR_OF,
  LAYOUT,
  MAP_H,
  MAP_W,
  PLACEMENTS,
  ROOM_OF,
  SPOTS,
  TILE,
  type Placement,
  type PropRef,
  type Room,
  type SpotSpec,
} from "./office";

export const WALK_CELL = 8;

export interface Point {
  x: number;
  y: number;
}

export interface PlacedProp {
  /** Cache key: the catalogue name, or the builder and its length. */
  id: string;
  prop: Prop;
  x: number;
  y: number;
  base: number;
  colors?: Record<string, string>;
}

export interface Seat {
  index: number;
  room: Room;
  desk: Point;
  /** The monitor's top-left corner and draw edge; which screen it shows is live. */
  monitor: Point & { base: number };
  /** A seated worker's sprite's top-left corner and draw edge. */
  sit: Point & { base: number };
  /** Where to stand to sit down (feet), behind the chair. */
  stand: Point;
  /** Where a session's intern stands (feet), beside the desk. */
  intern: Point;
}

export interface WalkGrid {
  cols: number;
  rows: number;
  /** 1 where nobody can stand. */
  blocked: Uint8Array;
}

export interface OfficeMap {
  /** Per tile: the room, or null for wall. */
  rooms: (Room | null)[][];
  floors: (FloorKind | null)[][];
  /** Back-wall tiles (x, in pixels), drawn as plain wall under what hangs on them. */
  backWall: number[];
  props: PlacedProp[];
  seats: Seat[];
  spots: SpotSpec[];
  walk: WalkGrid;
  door: Point;
  duck: Point;
}

function resolve(ref: PropRef): [string, Prop] {
  if (typeof ref === "string") return [ref, PROPS[ref] as Prop];
  const make = { partition, partitionSide, glass, glassSide }[ref.build];
  return [`${ref.build}${ref.tiles}`, make(ref.tiles)];
}

/** How deep a prop sits on the floor when its placement doesn't say. */
function defaultFoot(ref: PropRef, p: Prop): number {
  if (typeof ref !== "string" && (ref.build === "partitionSide" || ref.build === "glassSide")) return p.h;
  if (ref === "kicker" || ref === "dndTable") return 16;
  return Math.min(p.h, 12);
}

interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function place(pl: Placement, foots: Footprint[]): PlacedProp {
  const [id, prop] = resolve(pl.prop);
  const base = pl.base ?? pl.y + prop.h;
  const foot = pl.foot ?? defaultFoot(pl.prop, prop);
  if (foot > 0) foots.push({ x0: pl.x, y0: pl.y + prop.h - foot, x1: pl.x + prop.w, y1: pl.y + prop.h });
  return { id, prop, x: pl.x, y: pl.y, base, ...(pl.colors ? { colors: pl.colors } : {}) };
}

export function buildOffice(): OfficeMap {
  if (LAYOUT.length !== MAP_H) throw new Error(`layout has ${LAYOUT.length} rows, not ${MAP_H}`);
  const rooms = LAYOUT.map((line, y) => {
    if (line.length !== MAP_W) throw new Error(`layout row ${y} is ${line.length} wide, not ${MAP_W}`);
    return [...line].map((c) => {
      if (c === "W") return null;
      const room = ROOM_OF[c];
      if (!room) throw new Error(`layout row ${y}: unknown tile "${c}"`);
      return room;
    });
  });
  const floors = rooms.map((line) => line.map((r) => (r ? FLOOR_OF[r] : null)));
  const backWall = [...LAYOUT[0]].flatMap((c, x) => (c === "W" ? [x * TILE] : []));

  const foots: Footprint[] = [];
  const props = PLACEMENTS.map((pl) => place(pl, foots));

  const seats = DESKS.map(({ room, x, y }, index): Seat => {
    props.push(place({ prop: "desk", x, y }, foots));
    props.push(place({ prop: "chair", x: x + 8, y: y + 15, base: y + 26 }, foots));
    return {
      index,
      room,
      desk: { x, y },
      monitor: { x: x + 9, y: y - 11, base: y + 21 },
      sit: { x: x + 8, y: y - 4, base: y + 22 },
      stand: { x: x + 16, y: y + 34 },
      intern: { x: x + 44, y: y + 22 },
    };
  });

  const cols = (MAP_W * TILE) / WALK_CELL;
  const rows = (MAP_H * TILE) / WALK_CELL;
  const blocked = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * WALK_CELL;
      const y0 = cy * WALK_CELL;
      const wall = rooms[Math.floor(y0 / TILE)][Math.floor(x0 / TILE)] === null;
      const inFurniture = foots.some((f) => x0 < f.x1 && x0 + WALK_CELL > f.x0 && y0 < f.y1 && y0 + WALK_CELL > f.y0);
      if (wall || inFurniture) blocked[cy * cols + cx] = 1;
    }
  }

  props.sort((a, b) => a.base - b.base);
  return {
    rooms,
    floors,
    backWall,
    props,
    seats,
    spots: SPOTS,
    walk: { cols, rows, blocked },
    door: DOOR,
    duck: DUCK_AT,
  };
}

/** The walk cell under a point in pixels. */
export const cellOf = (p: Point): Point => ({ x: Math.floor(p.x / WALK_CELL), y: Math.floor(p.y / WALK_CELL) });

export function isFree(walk: WalkGrid, cell: Point): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < walk.cols && cell.y < walk.rows && !walk.blocked[cell.y * walk.cols + cell.x];
}

/** Every cell reachable on foot from `from` (4-way), as a mask. */
export function reachable(walk: WalkGrid, from: Point): Uint8Array {
  const seen = new Uint8Array(walk.cols * walk.rows);
  if (!isFree(walk, from)) return seen;
  const queue = [from];
  seen[from.y * walk.cols + from.x] = 1;
  while (queue.length) {
    const { x, y } = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: x + dx, y: y + dy };
      const i = next.y * walk.cols + next.x;
      if (isFree(walk, next) && !seen[i]) {
        seen[i] = 1;
        queue.push(next);
      }
    }
  }
  return seen;
}
