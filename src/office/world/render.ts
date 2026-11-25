// Drawing the office (office plans O1.1, O1.2, O1.4): the floors once, then the
// furniture and the people together in depth order (by the y of their draw edge, so
// whoever stands lower on screen is in front), then what floats over heads — name
// tags, status icons and speech bubbles, a red one flashing — on top of everything.
// People are drawn sliding from where the last sim step found them to where it left
// them, so walking is smooth at any frame rate. Each draw reports how long until the picture changes by itself, so the loop
// sleeps between animation frames. The lounge TV is on only while someone plays the
// console, and a kicker match shows its ball and, over the table, the score (O2.2).
// The windows show the sky of the hour, and the whiteboard on Demiurge's wall keeps the
// coffee budget: what's left of each usage window (O2.4).

import { FRAME_H, frame } from "../art/characters";
import { DUCK_ANIMS, DUCK_H, DUCK_W, duckFrame } from "../art/duck";
import { FERNANDO_ANIMS, FERNANDO_H, FERNANDO_W, fernandoFrame } from "../art/fernando";
import { machineMark, nameTag, speechBubble, statusIcon } from "../art/labels";
import { BALL_H, BALL_W, HEART_H, HEART_W, LUPA_ANIMS, LUPA_H, ballFrame, heartFrame, lupaFrame, lupaView } from "../art/lupa";
import { textBitmap } from "../art/font";
import { PROPS, clockAt, floorTile, propFrame, type PropName } from "../art/props";
import { cached } from "../canvas";
import { WALK_CELL, type OfficeMap, type Point, type Seat } from "../map/build";
import { MAP_H, MAP_W, TILE } from "../map/office";
import { SIM_STEP } from "../loop";
import { frameAt, play, type Playing } from "./anim";
import { ballAt, kickerScore, type KickerMatch } from "./groups";
import { SKY_COLORS, hoursOf, officeTime, skyAt } from "./ambience";
import { tvScreen } from "../games/emulator/screen";
import { boardScreen } from "../games/screen";
import { HEART_MS, LUPA_ID, type Budget, type Bubble, type Contractor, type DuckEntity, type Entity, type FernandoEntity, type Heart, type Screen, type WorkerEntity, type World } from "./entities";
import type { Ball, LupaEntity } from "./lupa";

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
  /** A free desk to start a session at (O3.2), outlined. */
  desk?: number | null;
  /** Whose bubble is being answered (O3.3), as `hover`: their tag shows. */
  asking?: string | null;
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

/** Where a bubble asking for you (`!`, `?`) was drawn, in office pixels, and whose it
 *  is: a worker's id, or a contractor's desk as `desk:<index>` (O3.3). */
export interface AskBubble {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Renderer {
  draw(ctx: CanvasRenderingContext2D, world: World, ms: number, view?: View): number;
  /** The bubbles asking for you as last drawn, back to front. */
  asks(): readonly AskBubble[];
}

/** The kicker's playing field inside its sprite: where the ball runs. */
const FIELD = { x: 3, y: 3, w: 32, h: 10 };
/** How often a kicker match is redrawn: the ball moves. */
const BALL_EVERY = 60;
/** The TV's screen inside its sprite, where a Library game shows (O5.3d), and how often
 *  it is redrawn then. */
const TV_SCREEN = { x: 4, y: 2, w: 28, h: 13 };
/** The standing whiteboard's writing area (`whiteboardStand`), and Pictionary's board
 *  in it (O5.4): 3:2, as tall as it goes. */
const STAND_BOARD = { x: 2 + Math.round((28 - 20) / 2), y: 2, w: 20, h: 13 };
export const TV_EVERY = 100;

export function createRenderer(office: OfficeMap): Renderer {
  /** The world being drawn, for the furniture that shows its state. */
  let drawing: World | null = null;
  const still = (p: (typeof office.props)[number], prop = p.prop, key = p.id) =>
    propStill(key, prop.frames.length, prop.ms ?? 1000, p.x, p.y, p.base, (f) => propFrame(prop, f, p.colors));

  const furniture: Still[] = office.props.map((p) => {
    if (p.id === "clock") {
      return {
        base: p.base,
        draw: (ctx) => {
          const now = officeTime();
          const h = now.getHours();
          const m = now.getMinutes();
          ctx.drawImage(cached(`clock/${h}:${m}`, () => propFrame(clockAt(h, m))), p.x, p.y);
          // Every zone is a whole number of minutes off UTC, so local minutes turn with UTC's.
          return 60_000 - (Date.now() % 60_000);
        },
      };
    }
    if (p.id === "windowWall") {
      return {
        base: p.base,
        draw: (ctx) => {
          const sky = skyAt(hoursOf(officeTime()));
          ctx.drawImage(cached(`window/${sky}`, () => propFrame(p.prop, 0, SKY_COLORS[sky])), p.x, p.y);
          return 60_000 - (Date.now() % 60_000);
        },
      };
    }
    if (p.id === "whiteboard") {
      const board = still(p);
      return {
        base: p.base,
        draw: (ctx, ms) => {
          board.draw(ctx, ms);
          if (drawing) drawBudget(ctx, drawing.budget, p.x, p.y);
          return Infinity;
        },
      };
    }
    if (p.id === "whiteboardStand") {
      const stand = still(p);
      return {
        base: p.base,
        draw: (ctx, ms) => {
          const next = stand.draw(ctx, ms);
          const board = boardScreen.get();
          if (!board) return next;
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(board, p.x + STAND_BOARD.x, p.y + STAND_BOARD.y, STAND_BOARD.w, STAND_BOARD.h);
          ctx.restore();
          return TV_EVERY;
        },
      };
    }
    if (p.id === "tvOn") {
      const on = still(p);
      const off = still(p, PROPS.tvOff, "tvOff");
      return {
        base: p.base,
        draw: (ctx, ms) => {
          const picture = tvScreen.get();
          if (!picture) return (drawing?.tv ? on : off).draw(ctx, ms);
          on.draw(ctx, ms);
          // The game, shrunk to the screen: smoothed, so it reads as a picture.
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(picture, p.x + TV_SCREEN.x, p.y + TV_SCREEN.y, TV_SCREEN.w, TV_SCREEN.h);
          ctx.restore();
          return TV_EVERY;
        },
      };
    }
    if (p.id === "kicker") {
      const table = still(p);
      return {
        base: p.base,
        draw: (ctx, ms) => {
          const next = table.draw(ctx, ms);
          const m = drawing?.kicker;
          if (!m) return next;
          const ball = ballAt(m, ms);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(Math.round(p.x + FIELD.x + ball.x * FIELD.w), Math.round(p.y + FIELD.y + ball.y * FIELD.h), 2, 2);
          return ms < m.end ? Math.min(next, BALL_EVERY) : next;
        },
      };
    }
    return still(p, p.prop, p.colors ? `${p.id}:${JSON.stringify(p.colors)}` : p.id);
  });
  const kickerTable = office.props.find((p) => p.id === "kicker");

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



  let asks: AskBubble[] = [];
  return {
    asks: () => asks,
    draw(ctx, world, ms, view = {}) {
      ctx.imageSmoothingEnabled = false;
      asks = [];
      ctx.drawImage((floors ??= floorLayer(office)), 0, 0);
      drawing = world;

      // How far through the current step: people slide from `prev` to where they are.
      const t = Math.min(1, Math.max(0, (ms - world.stepAt) / SIM_STEP));
      let next = Infinity;
      const shown = (e: { x: number; y: number; prev: Point }): Point => {
        if (e.prev.x === e.x && e.prev.y === e.y) return e;
        if (t < 1) next = 0;
        return { x: e.prev.x + (e.x - e.prev.x) * t, y: e.prev.y + (e.y - e.prev.y) * t };
      };
      const people = [...world.workers.filter((w) => !w.away), world.duck].map((e) => ({ e, at: shown(e) }));
      const lupaAt = shown(world.lupa);
      const ballAt = shownBall(world.ball, t, () => (next = 0));

      // Furniture, monitors and people, back to front. Sorting is stable, so on a tie
      // the furniture (listed first) goes behind.
      const items: { base: number; draw: (ctx: CanvasRenderingContext2D, ms: number) => number }[] = [
        ...furniture,
        ...monitors.map((m, i) => m[world.screens[i]]),
        ...people.map(({ e, at }) => ({
          base: at.y,
          draw: (c: CanvasRenderingContext2D, ms: number) => (e.kind === "duck" ? drawDuck(c, e, at, ms) : drawWorker(c, e, at, ms)),
        })),
        { base: world.fernando.y, draw: (c: CanvasRenderingContext2D, ms: number) => drawFernando(c, world.fernando, ms) },
        { base: lupaAt.y, draw: (c: CanvasRenderingContext2D, ms: number) => drawLupa(c, world.lupa, lupaAt, ms) },
        // A held ball is drawn over everything, below.
        ...(world.ball.carried || world.ball.held ? [] : [{ base: ballAt.y, draw: (c: CanvasRenderingContext2D) => (drawBall(c, ballAt), Infinity) }]),
      ];
      items.sort((a, b) => a.base - b.base);
      for (const item of items) next = Math.min(next, item.draw(ctx, ms));
      if (view.desk != null) outlineDesk(ctx, office.seats[view.desk]);

      for (const c of world.contractors) next = Math.min(next, drawContractorTag(ctx, office, c, view, ms, asks));
      for (const { e, at } of people.sort((a, b) => a.at.y - b.at.y)) next = Math.min(next, drawOverhead(ctx, e, at, view, ms, asks));
      next = Math.min(next, drawFernandoOverhead(ctx, world.fernando, view, ms));
      next = Math.min(next, drawLupaOverhead(ctx, world.lupa, lupaAt, view, ms));
      if (world.ball.held) drawBall(ctx, ballAt);
      next = Math.min(next, drawHearts(ctx, world, people, lupaAt, ms));
      if (world.kicker && kickerTable) next = Math.min(next, drawScore(ctx, world.kicker, kickerTable.x + kickerTable.prop.w / 2, kickerTable.y - 1, ms));
      if (view.overlay) drawOverlay(ctx, office, world);
      return next;
    },
  };
}

/** The coffee budget, on the wall whiteboard at `x`, `y`: a mug for the five-hour
 *  window and a pot for the week, each with a gauge of the coffee left, red when it's
 *  nearly gone and empty grey when not known. */
function drawBudget(ctx: CanvasRenderingContext2D, budget: Budget, x: number, y: number): void {
  // The board's writing area is x 2–29, y 2–14.
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(x + 2, y + 2, 28, 13);
  const row = (used: number | null, top: number, pot: boolean) => {
    ctx.fillStyle = "#6f472b";
    if (pot) {
      ctx.fillRect(x + 3, top, 4, 4);
      ctx.fillRect(x + 4, top - 1, 2, 1);
    } else {
      ctx.fillRect(x + 3, top + 1, 3, 3);
      ctx.fillRect(x + 6, top + 2, 1, 1);
    }
    // The gauge: an outline, coffee for what's left.
    ctx.fillStyle = "#3d3c4a";
    ctx.fillRect(x + 9, top, 20, 4);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(x + 10, top + 1, 18, 2);
    if (used === null) {
      ctx.fillStyle = "#b9b9c6";
      for (let i = 0; i < 18; i += 3) ctx.fillRect(x + 10 + i, top + 1, 1, 2);
      return;
    }
    const left = Math.round((18 * (100 - used)) / 100);
    ctx.fillStyle = used >= 80 ? "#d94a4a" : "#9c6a42";
    ctx.fillRect(x + 10, top + 1, left, 2);
  };
  row(budget.fiveHour, y + 3, false);
  row(budget.sevenDay, y + 9, true);
}

/** A kicker match's score over the table, its bottom centre at (`cx`, `bottom`).
 *  Returns how long until the next goal changes it. */
function drawScore(ctx: CanvasRenderingContext2D, m: KickerMatch, cx: number, bottom: number, ms: number): number {
  const [w, e] = kickerScore(m, ms);
  const img = cached(`score/${w}:${e}`, () => speechBubble(`${w} : ${e}`));
  ctx.drawImage(img, Math.round(cx - img.width / 2), bottom - img.height);
  const goal = m.goals.find((g) => g.at > ms);
  return goal ? goal.at - ms : Infinity;
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
  if (w.seat === null && !w.lift) {
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    ctx.ellipse(x, y - 1, 6, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const img = cached(`worker/${w.worker.id}/${w.anim}/${w.dir}/${index}`, () => frame(w.worker.look, w.anim, w.dir, index));
  // Lying on a table, the sprite is up on its top (`lift`), wider than a frame.
  ctx.drawImage(img, x - Math.floor(img.width / 2), y - (w.lift ?? 0) - img.height);
  return next;
}

function drawDuck(ctx: CanvasRenderingContext2D, d: DuckEntity, at: Point, ms: number): number {
  const { index, next } = frameAt(d.playing, ms);
  const img = cached(`duck/${d.anim}/${d.view}/${index}`, () => duckFrame(d.view, DUCK_ANIMS[d.anim][index].pose));
  ctx.drawImage(img, Math.round(at.x - DUCK_W / 2), Math.round(at.y - DUCK_H));
  return next;
}

/** Fernando's sprite, on a shadow like a standing worker's. */
function drawFernando(ctx: CanvasRenderingContext2D, f: FernandoEntity, ms: number): number {
  const { index, next } = frameAt(f.playing, ms);
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(f.x, f.y - 1, 8, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  const img = cached(`fernando/${f.anim}/${index}`, () => fernandoFrame(FERNANDO_ANIMS[f.anim][index].pose));
  ctx.drawImage(img, Math.round(f.x - FERNANDO_W / 2), Math.round(f.y - FERNANDO_H));
  return next;
}

/** Where the ball is shown: sliding between steps like everyone, a held one exactly
 *  where it is (it follows the pointer between steps). */
function shownBall(b: Ball, t: number, moving: () => void): { x: number; y: number; z: number } {
  if (b.held) return b;
  const { prev } = b;
  if (prev.x === b.x && prev.y === b.y && prev.z === b.z) return b;
  if (t < 1) moving();
  return { x: prev.x + (b.x - prev.x) * t, y: prev.y + (b.y - prev.y) * t, z: prev.z + (b.z - prev.z) * t };
}

/** The ball, its shadow on the floor under it and the ball up off it by its height. */
function drawBall(ctx: CanvasRenderingContext2D, b: { x: number; y: number; z: number }): void {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(1.5, 3 - b.z / 6), 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(cached("ball", ballFrame), x - BALL_W / 2, Math.round(y - b.z) - BALL_H + 1);
}

/** Lupa, on a shadow (a flatter one asleep), the ball in her mouth if she has it. */
function drawLupa(ctx: CanvasRenderingContext2D, l: LupaEntity, at: Point, ms: number): number {
  const { index, next } = frameAt(l.playing, ms);
  const view = lupaView(l.anim, l.view);
  const pose = LUPA_ANIMS[l.anim].frames[index].pose;
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(x, y - 1, view === "down" || view === "up" ? 7 : 10, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  const img = cached(`lupa/${pose}/${view}/${l.carrying}`, () => lupaFrame(pose, view, l.carrying));
  ctx.drawImage(img, x - Math.floor(img.width / 2), y - img.height);
  return next;
}

/** Lupa's tag: her collar's pink. */
const LUPA_TAG = "#c93c66";
const ZZZ = "#e9e4f2";

/** Over Lupa: z's drifting up while she sleeps, her name tag when hovered. */
function drawLupaOverhead(ctx: CanvasRenderingContext2D, l: LupaEntity, at: Point, view: View, ms: number): number {
  const x = Math.round(at.x);
  const top = Math.round(at.y) - (l.anim === "sleep" ? 9 : LUPA_H);
  let next = Infinity;
  if (l.anim === "sleep") {
    const z = cached("lupa/z", () => textBitmap("z", ZZZ));
    // Two at a time, each rising and drifting right over 1.6 s.
    for (const offset of [0, 800]) {
      const p = ((ms + offset) % 1600) / 1600;
      ctx.globalAlpha = 1 - p;
      ctx.drawImage(z, x + 6 + Math.round(p * 6), top - 2 - Math.round(p * 10));
    }
    ctx.globalAlpha = 1;
    next = 100;
  }
  if (view.tags || view.hover === LUPA_ID) {
    const img = cached("tag/lupa", () => nameTag("Lupa", LUPA_TAG, null));
    ctx.drawImage(img, Math.min(Math.max(0, x - Math.floor(img.width / 2)), OFFICE_W - img.width), Math.max(0, top - img.height - 1));
  }
  return next;
}

/** The hearts floating up over Anya and Lupa: popping in, rising, drifting, fading. */
function drawHearts(ctx: CanvasRenderingContext2D, world: World, people: { e: Entity; at: Point }[], lupaAt: Point, ms: number): number {
  if (!world.hearts.length) return Infinity;
  const img = cached("heart", heartFrame);
  let live = false;
  for (const h of world.hearts as Heart[]) {
    const age = ms - h.at;
    if (age < 0 || age >= HEART_MS) continue;
    live = true;
    const who = h.over === LUPA_ID ? null : people.find((p) => p.e.kind === "worker" && p.e.worker.id === h.over);
    const at = who?.at ?? lupaAt;
    const lift = who?.e.kind === "worker" ? (who.e.lift ?? 0) : 0;
    const head = h.over === LUPA_ID ? (world.lupa.anim === "sleep" ? 9 : LUPA_H) : who?.e.kind === "worker" && who.e.anim === "lie" ? 15 : FRAME_H;
    const p = age / HEART_MS;
    // A quick pop: bigger for the first tenth of a second.
    const scale = age < 100 ? 2 : age < 180 ? 1.5 : 1;
    const w = HEART_W * scale;
    const hgt = HEART_H * scale;
    const cx = at.x + h.dx * p + Math.sin(p * Math.PI * 2) * 2;
    const y = at.y - lift - head - 2 - p * 16;
    ctx.globalAlpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
    ctx.drawImage(img, Math.round(cx - w / 2), Math.round(y - hgt), w, hgt);
  }
  ctx.globalAlpha = 1;
  return live ? 0 : Infinity;
}

/** Fernando's id for hover and the view. */
export const FERNANDO_ID = "fernando";
/** His name tag: the poncho's orange. */
const FERNANDO_TAG = "#d9623b";

/** Over Fernando: his bubble, and his name tag when he's hovered or tags are on. */
function drawFernandoOverhead(ctx: CanvasRenderingContext2D, f: FernandoEntity, view: View, ms: number): number {
  const layers: HTMLCanvasElement[] = [];
  if (f.bubble) layers.push(bubbleImage(f.bubble, ms));
  if (view.tags || view.hover === FERNANDO_ID) layers.push(cached("tag/fernando", () => nameTag("Fernando", FERNANDO_TAG, null)));
  // The brim is a pixel under the frame's top.
  let bottom = Math.round(f.y) - FERNANDO_H;
  for (const img of layers) {
    const x = Math.min(Math.max(0, Math.round(f.x) - Math.floor(img.width / 2)), OFFICE_W - img.width);
    const y = Math.max(0, bottom - img.height);
    ctx.drawImage(img, x, y);
    bottom = y - 1;
  }
  return pulseIn(f.bubble, ms);
}

/** Stacked up from the top of the head: the bubble (or the status icon), then the name
 *  tag, so a tag showing on hover never moves the bubble out from under the pointer.
 *  Returns how long until a pulsing bubble flashes. */
function drawOverhead(ctx: CanvasRenderingContext2D, e: Entity, at: Point, view: View, ms: number, asks: AskBubble[]): number {
  const layers: HTMLCanvasElement[] = [];
  const bubble = e.bubble ? bubbleImage(e.bubble, ms) : null;
  if (bubble) layers.push(bubble);
  if (e.kind === "worker") {
    const w = e.worker;
    if (e.overhead && !e.bubble) layers.push(cached(`icon/${e.overhead}`, () => statusIcon(e.overhead!)));
    // Another machine's worker (fleet plan F9.3): a small mark with its initial.
    if (e.elsewhere && !e.bubble) layers.push(cached(`mark/${e.elsewhere}`, () => machineMark(e.elsewhere!)));
    if (view.tags || view.hover === w.id || view.selected === w.id || view.asking === w.id) {
      layers.push(cached(`tag/${w.id}/${e.tag}`, () => nameTag(w.name, w.look.top.base, e.tag)));
    }
  }
  if (!layers.length) return Infinity;

  // Duck's head fills its frame; a worker's starts a pixel or two down.
  let bottom = Math.round(at.y) - (e.kind === "duck" ? DUCK_H - 2 : FRAME_H) - 1;
  const cx = Math.round(at.x);
  for (const img of layers) {
    const x = Math.min(Math.max(0, cx - Math.floor(img.width / 2)), OFFICE_W - img.width);
    const y = Math.max(0, bottom - img.height);
    ctx.drawImage(img, x, y);
    bottom = y - 1;
    if (e.kind === "worker" && img === bubble && asking(e.bubble)) asks.push({ id: e.worker.id, x, y, w: img.width, h: img.height });
  }
  return pulseIn(e.bubble, ms);
}

/** Over a contractor's laptop: the bubble when the session needs you, and above it
 *  "Remote contractor" when tags show or it's hovered. */
function drawContractorTag(ctx: CanvasRenderingContext2D, office: OfficeMap, c: Contractor, view: View, ms: number, asks: AskBubble[]): number {
  const layers: HTMLCanvasElement[] = [];
  const bubble = c.bubble ? bubbleImage(c.bubble, ms) : null;
  if (bubble) layers.push(bubble);
  if (view.tags || view.hover === `desk:${c.desk}` || view.asking === `desk:${c.desk}`) {
    layers.push(cached(`tag/contractor/${c.tag}`, () => nameTag("Remote contractor", CONTRACTOR_RIM, c.tag)));
  }
  const m = office.seats[c.desk].monitor;
  let bottom = m.y + 4;
  for (const img of layers) {
    const x = Math.min(Math.max(0, m.x + 7 - Math.floor(img.width / 2)), OFFICE_W - img.width);
    const y = Math.max(0, bottom - img.height);
    ctx.drawImage(img, x, y);
    bottom = y - 1;
    if (img === bubble && asking(c.bubble)) asks.push({ id: `desk:${c.desk}`, x, y, w: img.width, h: img.height });
  }
  return pulseIn(c.bubble, ms);
}

/** A dotted outline round a desk, its chair and monitor. */
function outlineDesk(ctx: CanvasRenderingContext2D, seat: Seat): void {
  const top = seat.monitor.y - 1;
  const h = seat.sit.base + 5 - top;
  ctx.fillStyle = "#ffd75e";
  for (let x = seat.desk.x - 1; x <= seat.desk.x + 32; x += 2) {
    ctx.fillRect(x, top, 1, 1);
    ctx.fillRect(x, top + h - 1, 1, 1);
  }
  for (let y = top; y < top + h; y += 2) {
    ctx.fillRect(seat.desk.x - 1, y, 1, 1);
    ctx.fillRect(seat.desk.x + 32, y, 1, 1);
  }
}

/** A pulsing bubble flashes between its own tone and "needs" this often. */
const PULSE_MS = 400;

function bubbleImage(b: Bubble, ms: number): HTMLCanvasElement {
  const tone = b.pulse && Math.floor(ms / PULSE_MS) % 2 === 1 ? "needs" : b.tone;
  return cached(`bubble/${tone}/${b.text}`, () => speechBubble(b.text, tone));
}

/** A session's `!` or `?`: not something said. */
const asking = (b: Bubble | null) => !!b && b.tone !== "say";

const pulseIn = (b: Bubble | null, ms: number) => (b?.pulse ? PULSE_MS - (ms % PULSE_MS) : Infinity);

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
