// The whole office for the preview (office plan OD.5): the floor plan built from
// map/, everyone at their home desk, Duck behind the boss desk. A static picture —
// people start moving in O1 — with an overlay of the walk grid and the named spots.

import { ANIMS, frame } from "./art/characters";
import { DUCK_ANIMS, DUCK_H, duckFrame } from "./art/duck";
import { PROPS, clockAt, floorTile, propFrame, type PropName } from "./art/props";
import { WALK_CELL, buildOffice, type Seat } from "./map/build";
import { MAP_H, MAP_W, TILE } from "./map/office";
import { cached, frameIn } from "./previewCanvas";
import { ROSTER, type Team, type Worker } from "./roster";

export const OFFICE_W = MAP_W * TILE;
export const OFFICE_H = MAP_H * TILE;

const office = buildOffice();

/** Each team fills its own room's desks in roster order. */
function homeDesks(): Map<Seat, Worker> {
  const room: Record<Team, Seat["room"]> = { demiurge: "demiurge", tinywizard: "tinywizard", open: "open" };
  const seated = new Map<Seat, Worker>();
  for (const team of Object.keys(room) as Team[]) {
    const seats = office.seats.filter((s) => s.room === room[team]);
    ROSTER.filter((w) => w.team === team).forEach((w, i) => seated.set(seats[i], w));
  }
  return seated;
}

const seated = homeDesks();
/** One worker needs you, so the alert screen shows up somewhere. */
const NEEDS_YOU = "ada";

interface Thing {
  base: number;
  draw: (ctx: CanvasRenderingContext2D, ms: number) => void;
}

function propThing(id: string, frames: number, ms: number, x: number, y: number, base: number, make: (f: number) => ReturnType<typeof propFrame>): Thing {
  const durations = Array<number>(frames).fill(ms);
  return {
    base,
    draw: (ctx, now) => {
      const f = frameIn(durations, now + x * 37);
      ctx.drawImage(cached(`office/${id}/${f}`, () => make(f)), x, y);
    },
  };
}

function things(): Thing[] {
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
      };
    }
    const key = p.colors ? `${p.id}:${JSON.stringify(p.colors)}` : p.id;
    return propThing(key, p.prop.frames.length, p.prop.ms ?? 1000, p.x, p.y, p.base, (f) => propFrame(p.prop, f, p.colors));
  });

  for (const seat of office.seats) {
    const who = seated.get(seat);
    const screen: PropName = !who ? "monitorOff" : who.id === NEEDS_YOU ? "monitorAlert" : "monitorCode";
    const m = PROPS[screen];
    list.push(propThing(screen, m.frames.length, m.ms ?? 1000, seat.monitor.x, seat.monitor.y, seat.monitor.base, (f) => propFrame(m, f)));
    if (!who) continue;
    const anim = who.id === NEEDS_YOU ? "idle" : "type";
    const durations = ANIMS[anim].frames.map((f) => f.ms);
    list.push({
      base: seat.sit.base,
      draw: (ctx, ms) => {
        const f = frameIn(durations, ms + seat.sit.x * 53);
        ctx.drawImage(cached(`worker/${who.id}/${anim}/up/${f}`, () => frame(who.look, anim, "up", f)), seat.sit.x, seat.sit.y);
      },
    });
  }

  const duck = DUCK_ANIMS.idle;
  list.push({
    base: office.duck.y + DUCK_H,
    draw: (ctx, ms) => {
      const f = frameIn(duck.map((d) => d.ms), ms);
      ctx.drawImage(cached(`duck/idle/down/${f}`, () => duckFrame("down", duck[f].pose)), office.duck.x, office.duck.y);
    },
  });
  return list.sort((a, b) => a.base - b.base);
}

const drawList = things();

/** Who sits where, for the hover labels. */
export const OFFICE_SEATS = [...seated].map(([seat, w]) => ({ worker: w, x: seat.sit.x, y: seat.sit.y }));

export function drawOffice(ctx: CanvasRenderingContext2D, ms: number, overlay = false): void {
  ctx.imageSmoothingEnabled = false;
  office.floors.forEach((line, ty) =>
    line.forEach((kind, tx) => {
      if (!kind) return;
      const alt = (tx + ty) % 2 === 1;
      ctx.drawImage(cached(`floor/${kind}/${alt}`, () => floorTile(kind, alt)), tx * TILE, ty * TILE);
    }),
  );
  for (const x of office.backWall) ctx.drawImage(cached("prop/wall/0", () => propFrame(PROPS.wall)), x, 0);
  for (const thing of drawList) thing.draw(ctx, ms);
  if (overlay) drawOverlay(ctx);
}

/** Blocked walk cells in red, desk stand points in blue, spots in yellow. */
function drawOverlay(ctx: CanvasRenderingContext2D): void {
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
  for (const s of office.seats) {
    dot(s.stand.x, s.stand.y, "#5aa0ff");
  }
  for (const s of office.spots) dot(s.x, s.y, "#ffd23f");
  dot(office.door.x, office.door.y, "#ffffff");
}
