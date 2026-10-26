// The whole office (office plan OD.5), for the preview and, until workers come to life in
// O1, the office page: the floor plan built from map/, everyone at their home desk, Duck
// behind the boss desk, with an overlay of the walk grid and the named spots.

import { ANIMS, frame } from "./art/characters";
import { DUCK_ANIMS, DUCK_H, duckFrame } from "./art/duck";
import { PROPS, clockAt, floorTile, propFrame, type PropName } from "./art/props";
import { WALK_CELL, buildOffice, type OfficeMap, type Seat } from "./map/build";
import { MAP_H, MAP_W, TILE } from "./map/office";
import { cached, frameIn, untilNextFrame } from "./canvas";
import { ROSTER, type Team, type Worker } from "./roster";

export const OFFICE_W = MAP_W * TILE;
export const OFFICE_H = MAP_H * TILE;

/** Each team fills its own room's desks in roster order; by desk index. */
function homeDesks(seats: readonly Seat[]): Map<number, Worker> {
  const room: Record<Team, Seat["room"]> = { demiurge: "demiurge", tinywizard: "tinywizard", open: "open" };
  const seated = new Map<number, Worker>();
  for (const team of Object.keys(room) as Team[]) {
    const mine = seats.filter((s) => s.room === room[team]);
    ROSTER.filter((w) => w.team === team).forEach((w, i) => seated.set(mine[i].index, w));
  }
  return seated;
}

/** One worker needs you, so the alert screen shows up somewhere. */
const NEEDS_YOU = "ada";

interface Thing {
  base: number;
  draw: (ctx: CanvasRenderingContext2D, ms: number) => void;
  /** How long after `ms` it looks different. */
  next: (ms: number) => number;
}

const still = () => Infinity;

/** Something looping through `durations`, offset by `phase` so neighbours don't tick together. */
function looping(base: number, durations: readonly number[], phase: number, draw: (ctx: CanvasRenderingContext2D, f: number) => void): Thing {
  if (durations.length < 2) return { base, draw: (ctx) => draw(ctx, 0), next: still };
  return {
    base,
    draw: (ctx, ms) => draw(ctx, frameIn(durations, ms + phase)),
    next: (ms) => untilNextFrame(durations, ms + phase),
  };
}

function propThing(id: string, frames: number, ms: number, x: number, y: number, base: number, make: (f: number) => ReturnType<typeof propFrame>): Thing {
  return looping(base, Array<number>(frames).fill(ms), x * 37, (ctx, f) => ctx.drawImage(cached(`office/${id}/${f}`, () => make(f)), x, y));
}

function things(office: OfficeMap, seated: Map<number, Worker>): Thing[] {
  const list: Thing[] = office.props.map((p) => {
    if (p.id === "clock") {
      return {
        base: p.base,
        draw: (ctx) => {
          const now = new Date();
          const h = now.getHours();
          const m = now.getMinutes();
          ctx.drawImage(cached(`clock/${h}:${m}`, () => propFrame(clockAt(h, m))), p.x, p.y);
        },
        // Every zone is a whole number of minutes off UTC, so local minutes turn with UTC's.
        next: () => 60_000 - (Date.now() % 60_000),
      };
    }
    const key = p.colors ? `${p.id}:${JSON.stringify(p.colors)}` : p.id;
    return propThing(key, p.prop.frames.length, p.prop.ms ?? 1000, p.x, p.y, p.base, (f) => propFrame(p.prop, f, p.colors));
  });

  for (const seat of office.seats) {
    const who = seated.get(seat.index);
    const screen: PropName = !who ? "monitorOff" : who.id === NEEDS_YOU ? "monitorAlert" : "monitorCode";
    const m = PROPS[screen];
    list.push(propThing(screen, m.frames.length, m.ms ?? 1000, seat.monitor.x, seat.monitor.y, seat.monitor.base, (f) => propFrame(m, f)));
    if (!who) continue;
    const anim = who.id === NEEDS_YOU ? "idle" : "type";
    const durations = ANIMS[anim].frames.map((f) => f.ms);
    list.push(
      looping(seat.sit.base, durations, seat.sit.x * 53, (ctx, f) =>
        ctx.drawImage(cached(`worker/${who.id}/${anim}/up/${f}`, () => frame(who.look, anim, "up", f)), seat.sit.x, seat.sit.y),
      ),
    );
  }

  const duck = DUCK_ANIMS.idle;
  list.push(
    looping(
      office.duck.y + DUCK_H,
      duck.map((d) => d.ms),
      0,
      (ctx, f) => ctx.drawImage(cached(`duck/idle/down/${f}`, () => duckFrame("down", duck[f].pose)), office.duck.x, office.duck.y),
    ),
  );
  return list.sort((a, b) => a.base - b.base);
}

const office = buildOffice();
const seated = homeDesks(office.seats);
const drawList = things(office, seated);

/** Who sits where, for the hover labels. */
export const OFFICE_SEATS = office.seats.flatMap((seat) => {
  const worker = seated.get(seat.index);
  return worker ? [{ worker, x: seat.sit.x, y: seat.sit.y }] : [];
});

let floorLayer: HTMLCanvasElement | undefined;

/** The floors and the back wall, which never change, drawn once. */
function floorsOf(office: OfficeMap): HTMLCanvasElement {
  if (floorLayer) return floorLayer;
  floorLayer = document.createElement("canvas");
  floorLayer.width = OFFICE_W;
  floorLayer.height = OFFICE_H;
  const ctx = floorLayer.getContext("2d")!;
  office.floors.forEach((line, ty) =>
    line.forEach((kind, tx) => {
      if (!kind) return;
      const alt = (tx + ty) % 2 === 1;
      ctx.drawImage(cached(`floor/${kind}/${alt}`, () => floorTile(kind, alt)), tx * TILE, ty * TILE);
    }),
  );
  for (const x of office.backWall) ctx.drawImage(cached("prop/wall/0", () => propFrame(PROPS.wall)), x, 0);
  return floorLayer;
}

/** Draws the office at `ms`; returns how long until it looks different. */
export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, overlay = false): number {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(floorsOf(office), 0, 0);
  let next = Infinity;
  for (const thing of drawList) {
    thing.draw(ctx, ms);
    next = Math.min(next, thing.next(ms));
  }
  if (overlay) drawOverlay(ctx, office);
  return next;
}

/** Blocked walk cells in red, desk stand points in blue, spots in yellow. */
function drawOverlay(ctx: CanvasRenderingContext2D, office: OfficeMap): void {
  const { cols, rows, blocked } = office.walk;
  ctx.fillStyle = "rgba(230, 40, 60, 0.32)";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) if (blocked[y * cols + x]) ctx.fillRect(x * WALK_CELL, y * WALK_CELL, WALK_CELL, WALK_CELL);
  }
  const dot = (x: number, y: number, color: string) => {
    ctx.fillStyle = "#1d1622";
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, y - 1, 3, 3);
  };
  for (const s of office.seats) dot(s.stand.x, s.stand.y, "#5aa0ff");
  for (const s of office.spots) dot(s.x, s.y, "#ffd23f");
  dot(office.door.x, office.door.y, "#ffffff");
}
