// Pathfinding on the walk grid (office plan O1.2): A* over the 8 px cells, 4-way so a
// path only ever needs the four facings, with a small cost per turn so people walk in
// long straight legs rather than staircases. Pure: cells in, cells out.

import { isFree, type Point, type WalkGrid } from "../map/build";

const STEP = 10;
const TURN = 4;
const DIRS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** Cells from `from` to `to`, both included; null when `to` can't be reached. The start
 *  may be blocked (someone getting up from a chair); every other cell must be free and
 *  not `avoid`ed. */
export function findPath(walk: WalkGrid, from: Point, to: Point, avoid?: (cell: Point) => boolean): Point[] | null {
  if (!isFree(walk, to) || avoid?.(to)) return null;
  if (from.x === to.x && from.y === to.y) return [from];

  // A state is a cell and the direction it was entered by (4 = the start).
  const states = walk.cols * walk.rows * 5;
  const cost = new Float64Array(states).fill(Infinity);
  const came = new Int32Array(states).fill(-1);
  const id = (c: Point, d: number) => (c.y * walk.cols + c.x) * 5 + d;
  const h = (c: Point) => (Math.abs(c.x - to.x) + Math.abs(c.y - to.y)) * STEP;

  const open = new Heap();
  const start = id(from, 4);
  cost[start] = 0;
  open.push(start, h(from));
  while (open.size) {
    const s = open.pop();
    const cell = Math.floor(s / 5);
    const at = { x: cell % walk.cols, y: Math.floor(cell / walk.cols) };
    if (at.x === to.x && at.y === to.y) return unwind(s, came, walk.cols);
    const d0 = s % 5;
    for (let d = 0; d < 4; d++) {
      const next = { x: at.x + DIRS[d].x, y: at.y + DIRS[d].y };
      if (!isFree(walk, next) || avoid?.(next)) continue;
      const n = id(next, d);
      const c = cost[s] + STEP + (d0 !== 4 && d0 !== d ? TURN : 0);
      if (c >= cost[n]) continue;
      cost[n] = c;
      came[n] = s;
      open.push(n, c + h(next));
    }
  }
  return null;
}

function unwind(s: number, came: Int32Array, cols: number): Point[] {
  const path: Point[] = [];
  for (let at = s; at !== -1; at = came[at]) {
    const cell = Math.floor(at / 5);
    path.push({ x: cell % cols, y: Math.floor(cell / cols) });
  }
  return path.reverse();
}

/** The free cell nearest `cell` (straight-line), among those `allowed` when given. */
export function nearestFree(walk: WalkGrid, cell: Point, allowed?: Uint8Array): Point | null {
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = 0; y < walk.rows; y++) {
    for (let x = 0; x < walk.cols; x++) {
      const i = y * walk.cols + x;
      if (walk.blocked[i] || (allowed && !allowed[i])) continue;
      const d = (x - cell.x) ** 2 + (y - cell.y) ** 2;
      if (d < bestD) [best, bestD] = [{ x, y }, d];
    }
  }
  return best;
}

/** A binary min-heap of state ids by priority. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
