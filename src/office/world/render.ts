// Drawing the office (office plans O1.1, O1.2): the floors once, then the furniture and
// the people together in depth order (by the y of their draw edge, so whoever stands
// lower on screen is in front), then what floats over heads — name tags, status icons
// and speech bubbles — on top of everything. People are drawn sliding from where the
// last sim step found them to where it left them, so walking is smooth at any frame
// rate. Each draw reports how long until the picture changes by itself, so the loop
// sleeps between animation frames.

import { FRAME_H, FRAME_W, frame } from "../art/characters";
import { DUCK_ANIMS, DUCK_H, DUCK_W, duckFrame } from "../art/duck";
import { nameTag, speechBubble, statusIcon } from "../art/labels";
import { PROPS, clockAt, floorTile, propFrame, type PropName } from "../art/props";
import { cached } from "../canvas";
import { WALK_CELL, type OfficeMap, type Point } from "../map/build";
import { MAP_H, MAP_W, TILE } from "../map/office";
import { SIM_STEP } from "../loop";
import { frameAt, play, type Playing } from "./anim";
import type { Bubble, Contractor, DuckEntity, Entity, Screen, WorkerEntity, World } from "./entities";

export const OFFICE_W = MAP_W * TILE;
export const OFFICE_H = MAP_H * TILE;

const SHADOW = "rgba(30, 24, 40, 0.28)";

export interface View {
  /** The walk grid and the named spots. */
  overlay?: boolean;
  /** Everyone's name tag, not just the hovered worker's. */
  tags?: boolean;
  /** The worker under the pointer, by id, or a contractor's desk as `desk:<index>`:
   *  their tag shows. */
  hover?: string | null;
  /** The worker a debug click sends walking, by id: their tag shows too. */
  selected?: string | null;
}

/** A piece of furniture: drawn at its depth, animated or still. */
interface Still {
  base: number;
  /** Draws it at `ms`; returns how long until it looks different. */
  draw: (ctx: CanvasRenderingContext2D, ms: number) => number;
}

function propStill(key: string, frames: number, ms: number, x: number, y: number, base: number, make: (f: number) => ReturnType<typeof propFrame>): Still {
  // Offset by x so the same prop in two places doesn't animate in step.
  const playing: Playing = play({ durations: Array<number>(frames).fill(ms) }, -x * 37);
  return {
    base,
    draw: (ctx, now) => {
      const { index, next } = frameAt(playing, now);
      ctx.drawImage(cached(`office/${key}/${index}`, () => make(index)), x, y);
      return next;
    },
  };
}

const SCREEN_PROP: Record<Screen, PropName> = { off: "monitorOff", code: "monitorCode", alert: "monitorAlert", laptop: "laptop" };
/** A contractor's tag: no shirt, so a neutral rim. */
const CONTRACTOR_RIM = "#8e8e9e";

export interface Renderer {
  draw(ctx: CanvasRenderingContext2D, world: World, ms: number, view?: View): number;
}

export function createRenderer(office: OfficeMap): Renderer {
  const furniture: Still[] = office.props.map((p) => {
    if (p.id === "clock") {
      return {
        base: p.base,
        draw: (ctx) => {
          const now = new Date();
          const h = now.getHours();
          const m = now.getMinutes();
          ctx.drawImage(cached(`clock/${h}:${m}`, () => propFrame(clockAt(h, m))), p.x, p.y);
          // Every zone is a whole number of minutes off UTC, so local minutes turn with UTC's.
          return 60_000 - (Date.now() % 60_000);
        },
      };
    }
    const key = p.colors ? `${p.id}:${JSON.stringify(p.colors)}` : p.id;
    return propStill(key, p.prop.frames.length, p.prop.ms ?? 1000, p.x, p.y, p.base, (f) => propFrame(p.prop, f, p.colors));
  });

  // A monitor per seat for each screen it can show; the world says which one is on.
  const monitors = office.seats.map((seat) => {
    const m = seat.monitor;
    const of = (screen: Screen): Still => {
      const prop = PROPS[SCREEN_PROP[screen]];
      return propStill(SCREEN_PROP[screen], prop.frames.length, prop.ms ?? 1000, m.x, m.y, m.base, (f) => propFrame(prop, f));
    };
    return { off: of("off"), code: of("code"), alert: of("alert"), laptop: of("laptop") } satisfies Record<Screen, Still>;
  });

  let floors: HTMLCanvasElement | undefined;

  return {
    draw(ctx, world, ms, view = {}) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage((floors ??= floorLayer(office)), 0, 0);

      // How far through the current step: people slide from `prev` to where they are.
      const t = Math.min(1, Math.max(0, (ms - world.stepAt) / SIM_STEP));
      let next = Infinity;
      const shown = (e: Entity): Point => {
        if (e.prev.x === e.x && e.prev.y === e.y) return e;
        if (t < 1) next = 0;
        return { x: e.prev.x + (e.x - e.prev.x) * t, y: e.prev.y + (e.y - e.prev.y) * t };
      };
      const people = [...world.workers.filter((w) => !w.away), world.duck].map((e) => ({ e, at: shown(e) }));

      // Furniture, monitors and people, back to front. Sorting is stable, so on a tie
      // the furniture (listed first) goes behind.
      const items: { base: number; draw: (ctx: CanvasRenderingContext2D, ms: number) => number }[] = [
        ...furniture,
        ...monitors.map((m, i) => m[world.screens[i]]),
        ...people.map(({ e, at }) => ({
          base: at.y,
          draw: (c: CanvasRenderingContext2D, ms: number) => (e.kind === "duck" ? drawDuck(c, e, at, ms) : drawWorker(c, e, at, ms)),
        })),
      ];
      items.sort((a, b) => a.base - b.base);
      for (const item of items) next = Math.min(next, item.draw(ctx, ms));

      for (const c of world.contractors) drawContractorTag(ctx, office, c, view);
      for (const { e, at } of people.sort((a, b) => a.at.y - b.at.y)) drawOverhead(ctx, e, at, view);
      if (view.overlay) drawOverlay(ctx, office, world);
      return next;
    },
  };
}

/** The floors and the back wall, which never change, drawn once. */
function floorLayer(office: OfficeMap): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = OFFICE_W;
  layer.height = OFFICE_H;
  const ctx = layer.getContext("2d")!;
  office.floors.forEach((line, ty) =>
    line.forEach((kind, tx) => {
      if (!kind) return;
      const alt = (tx + ty) % 2 === 1;
      ctx.drawImage(cached(`floor/${kind}/${alt}`, () => floorTile(kind, alt)), tx * TILE, ty * TILE);
    }),
  );
  for (const x of office.backWall) ctx.drawImage(cached("prop/wall/0", () => propFrame(PROPS.wall)), x, 0);
  return layer;
}

function drawWorker(ctx: CanvasRenderingContext2D, w: WorkerEntity, at: Point, ms: number): number {
  const { index, next } = frameAt(w.playing, ms);
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  if (w.seat === null) {
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const img = cached(`worker/${w.worker.id}/${w.anim}/${w.dir}/${index}`, () => frame(w.worker.look, w.anim, w.dir, index));
  ctx.drawImage(img, x - FRAME_W / 2, y - FRAME_H);
  return next;
}

function drawDuck(ctx: CanvasRenderingContext2D, d: DuckEntity, at: Point, ms: number): number {
  const { index, next } = frameAt(d.playing, ms);
  const img = cached(`duck/${d.anim}/${d.view}/${index}`, () => duckFrame(d.view, DUCK_ANIMS[d.anim][index].pose));
  ctx.drawImage(img, Math.round(at.x - DUCK_W / 2), Math.round(at.y - DUCK_H));
  return next;
}

/** Stacked up from the top of the head: the name tag, the status icon, the bubble. */
function drawOverhead(ctx: CanvasRenderingContext2D, e: Entity, at: Point, view: View): void {
  const layers: HTMLCanvasElement[] = [];
  if (e.kind === "worker") {
    const w = e.worker;
    if (view.tags || view.hover === w.id || view.selected === w.id) {
      layers.push(cached(`tag/${w.id}/${e.tag}`, () => nameTag(w.name, w.look.top.base, e.tag)));
    }
    if (e.overhead && !e.bubble) layers.push(cached(`icon/${e.overhead}`, () => statusIcon(e.overhead!)));
  }
  if (e.bubble) layers.push(bubbleImage(e.bubble));
  if (!layers.length) return;

  // Duck's head fills its frame; a worker's starts a pixel or two down.
  let bottom = Math.round(at.y) - (e.kind === "duck" ? DUCK_H - 2 : FRAME_H) - 1;
  const cx = Math.round(at.x);
  for (const img of layers) {
    const x = Math.min(Math.max(0, cx - Math.floor(img.width / 2)), OFFICE_W - img.width);
    const y = Math.max(0, bottom - img.height);
    ctx.drawImage(img, x, y);
    bottom = y - 1;
  }
}

/** "Remote contractor" over a contractor's laptop, when tags show or it's hovered. */
function drawContractorTag(ctx: CanvasRenderingContext2D, office: OfficeMap, c: Contractor, view: View): void {
  if (!view.tags && view.hover !== `desk:${c.desk}`) return;
  const img = cached(`tag/contractor/${c.tag}`, () => nameTag("Remote contractor", CONTRACTOR_RIM, c.tag));
  const m = office.seats[c.desk].monitor;
  const x = Math.min(Math.max(0, m.x + 7 - Math.floor(img.width / 2)), OFFICE_W - img.width);
  ctx.drawImage(img, x, Math.max(0, m.y + 4 - img.height));
}

function bubbleImage(b: Bubble): HTMLCanvasElement {
  return cached(`bubble/${b.tone}/${b.text}`, () => speechBubble(b.text, b.tone));
}

/** Blocked walk cells in red, desk stand points in blue, spots in yellow, and where
 *  everyone walking is headed, in white. */
function drawOverlay(ctx: CanvasRenderingContext2D, office: OfficeMap, world: World): void {
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
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  for (const w of world.workers) {
    if (!w.walk) continue;
    ctx.beginPath();
    ctx.moveTo(w.x + 0.5, w.y + 0.5);
    for (const p of w.walk.points) ctx.lineTo(p.x + 0.5, p.y + 0.5);
    ctx.stroke();
  }
}
