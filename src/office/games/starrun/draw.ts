// Star run's picture (office plan O5.3b): the starfield in three layers, the ship and
// the enemies as little sprites (white for a moment when hit), lumpy asteroids made from
// their outline number, bursts, and the score, lives and sector over it all.

import { textBitmap } from "../../art/font";
import { bitmap, draw, keysOf, type ColorMap, type Part } from "../../art/pixels";
import { cached } from "../../canvas";
import type { Game } from "../game";
import { mix, SR_H, SR_W } from "./sectors";
import { BANNER_STEPS, BURST_STEPS, OVER_WAIT, ROCK_R, runState, stepRun, type RunState } from "./starrun";

const SPRITES = {
  ship: {
    rows: ["...w...", "..wbw..", "..wcw..", ".wwcww.", "wwbwbww", "w.bwb.w", "..w.w.."],
    colors: { w: "#dfe6f2", b: "#4f8fe0", c: "#7fd1ff" },
  },
  life: { rows: ["..w..", ".www.", "wwwww", "w.w.w"], colors: { w: "#dfe6f2" } },
  dart: { rows: ["r.....r", "rr.k.rr", ".rrkrr.", "..rrr..", "...r..."], colors: { r: "#e0544f", k: "#ffcf3f" } },
  swoop: {
    rows: ["p.......p", "pp.....pp", ".ppqqqpp.", "..ppqpp..", "...ppp..."],
    colors: { p: "#b06ce0", q: "#f0c3ff" },
  },
  gunner: {
    rows: ["..ggggggg..", ".gghhhhhgg.", "gghhkkkhhgg", "ggh.kkk.hgg", "g.hhhhhhh.g", "g..g...g..g", "...g...g..."],
    colors: { g: "#5f6b7a", h: "#8fa0b3", k: "#ff6f6f" },
  },
  diver: {
    rows: ["o.....o", "oo...oo", "ooomooo", ".ooooo.", "..omo..", "...o..."],
    colors: { o: "#ff9f3d", m: "#fff2a8" },
  },
} as const satisfies Record<string, { rows: readonly string[]; colors: ColorMap }>;

type SpriteName = keyof typeof SPRITES;

function sprite(name: SpriteName, white = false): HTMLCanvasElement {
  return cached(`starrun/${name}/${white ? "hit" : "lit"}`, () => {
    const { rows, colors } = SPRITES[name];
    const part: Part = { rows };
    const out = bitmap(rows[0].length, rows.length);
    draw(out, part, white ? Object.fromEntries([...keysOf(part)].map((k) => [k, "#ffffff"])) : colors);
    return out;
  });
}

/** An asteroid of `size`, outline `shape`: a disc with lumps, lit from the top left. */
function rockSprite(size: 0 | 1 | 2, shape: number, white: boolean): HTMLCanvasElement {
  return cached(`starrun/rock/${size}/${shape}/${white ? "hit" : "lit"}`, () => {
    const r = ROCK_R[size];
    const p1 = (mix(shape, 1) % 628) / 100;
    const p2 = (mix(shape, 2) % 628) / 100;
    const pit = { x: (mix(shape, 3) % 3) - 1, y: (mix(shape, 4) % 3) - 1 };
    const rows: string[] = [];
    for (let dy = -r; dy <= r; dy++) {
      let row = "";
      for (let dx = -r; dx <= r; dx++) {
        const a = Math.atan2(dy, dx);
        const edge = r * (0.8 + 0.12 * Math.sin(3 * a + p1) + 0.08 * Math.sin(5 * a + p2)) + 0.4;
        if (Math.hypot(dx, dy) > edge) row += ".";
        else if (size > 0 && dx === pit.x * Math.ceil(r / 3) && dy === pit.y * Math.ceil(r / 3)) row += "d";
        else row += dx + dy > r * 0.45 ? "d" : dx + dy < -r * 0.5 ? "l" : "m";
      }
      rows.push(row);
    }
    const out = bitmap(2 * r + 1, 2 * r + 1);
    draw(out, { rows }, white ? { l: "#ffffff", m: "#ffffff", d: "#ffffff" } : { l: "#b3a491", m: "#8a7a6a", d: "#5e5248" });
    return out;
  });
}

const INK = "#ebe6f3";
const DIM = "#a39bb4";
const SPACE = "#0b0a12";
const text = (s: string, color: string) => cached(`game-text/${color}/${s}`, () => textBitmap(s, color));
const centre = (ctx: CanvasRenderingContext2D, s: string, color: string, y: number) => {
  const t = text(s, color);
  ctx.drawImage(t, Math.round((SR_W - t.width) / 2), Math.round(y));
};

/** The stars: each layer moves at its own share of the scroll. */
const LAYERS = [
  { count: 34, speed: 0.15, color: "#2e2a40" },
  { count: 20, speed: 0.4, color: "#5b5470" },
  { count: 10, speed: 1, color: "#c9c2d8" },
] as const;

function drawStars(ctx: CanvasRenderingContext2D, distance: number): void {
  LAYERS.forEach((l, n) => {
    ctx.fillStyle = l.color;
    for (let i = 0; i < l.count; i++) {
      const x = mix(i, n * 7 + 1) % SR_W;
      const y = (((mix(i, n * 7 + 2) % SR_H) + distance * l.speed) % SR_H + SR_H) % SR_H;
      ctx.fillRect(x, Math.floor(y), 1, n === 2 ? 2 : 1);
    }
  });
}

function put(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number): void {
  ctx.drawImage(img, Math.round(x - (img.width - 1) / 2), Math.round(y - (img.height - 1) / 2));
}

export function drawRun(ctx: CanvasRenderingContext2D, s: RunState): void {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = SPACE;
  ctx.fillRect(0, 0, SR_W, SR_H);
  drawStars(ctx, s.distance);

  for (const r of s.rocks) put(ctx, rockSprite(r.size, r.shape, r.flash > 0), r.x, r.y);
  for (const e of s.enemies) put(ctx, sprite(e.kind, e.flash > 0), e.x, e.y);
  ctx.fillStyle = "#ffe066";
  for (const b of s.shots) ctx.fillRect(Math.round(b.x), Math.round(b.y) - 2, 1, 4);
  for (const b of s.bolts) {
    ctx.fillStyle = "#ff6f91";
    ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 3, 3);
    ctx.fillStyle = "#ffe0e8";
    ctx.fillRect(Math.round(b.x), Math.round(b.y), 1, 1);
  }

  const ship = s.ship;
  if (s.phase === "play" && (ship.safe === 0 || Math.floor(ship.safe / 4) % 2 === 0)) {
    // The flame flickers under it.
    ctx.fillStyle = s.t % 4 < 2 ? "#ff8a3d" : "#ffcf3f";
    const flame = 1 + (s.t % 3 === 0 ? 1 : 0);
    ctx.fillRect(Math.round(ship.x) - 1, Math.round(ship.y) + 4, 1, flame);
    ctx.fillRect(Math.round(ship.x) + 1, Math.round(ship.y) + 4, 1, flame);
    put(ctx, sprite("ship"), ship.x, ship.y);
  }

  for (const b of s.bursts) {
    const k = b.t / BURST_STEPS;
    ctx.fillStyle = k < 0.3 ? "#fff2a8" : k < 0.6 ? "#ffb347" : "#e0544f";
    const r = 1 + b.r * k;
    for (let n = 0; n < 10; n++) {
      const a = (n / 10) * Math.PI * 2 + b.r;
      ctx.fillRect(Math.round(b.x + Math.cos(a) * r), Math.round(b.y + Math.sin(a) * r), 1, 1);
    }
    if (b.t < 4) ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 3, 3);
  }

  // Score, lives and the sector over the top.
  ctx.drawImage(text(String(s.score), INK), 4, 4);
  const life = sprite("life");
  for (let n = 0; n < s.lives; n++) ctx.drawImage(life, SR_W - 4 - (n + 1) * (life.width + 2), 4);
  const where = text(`S${s.sector + 1}`, DIM);
  ctx.drawImage(where, Math.round((SR_W - where.width) / 2), 4);

  if (s.phase === "play" && s.banner > 0 && s.banner < BANNER_STEPS - 10 && Math.floor(s.banner / 8) % 4 !== 0) {
    centre(ctx, `SECTOR ${s.sector + 1}`, "#ffcf3f", 86);
  }
  const start = s.gamepad ? "START" : "ENTER";
  if (s.paused) box(ctx, [["PAUSED", INK], [`${start}: GO ON`, DIM]]);
  if (s.phase === "over") {
    const best = s.score > s.best ? "NEW BEST!" : `BEST ${s.best}`;
    const lines: [string, string][] = [
      ["GAME OVER", "#ff6f91"],
      [`SCORE ${s.score}`, INK],
      [`REACHED SECTOR ${s.sector + 1}`, DIM],
      [best, "#ffcf3f"],
    ];
    if (s.t >= OVER_WAIT && Math.floor(s.t / 20) % 3 !== 0) lines.push([`${start}: FLY AGAIN`, INK]);
    box(ctx, lines);
  }
}

function box(ctx: CanvasRenderingContext2D, lines: readonly [string, string][]): void {
  const w = Math.max(...lines.map(([l]) => text(l, INK).width)) + 16;
  const h = lines.length * 10 + 8;
  const y = (SR_H - h) / 2;
  ctx.fillStyle = "#15131bdd";
  ctx.fillRect(Math.round((SR_W - w) / 2), Math.round(y), w, h);
  lines.forEach(([l, c], n) => centre(ctx, l, c, y + 6 + n * 10));
}

/** A run of Star run, with `best` the score to beat. */
export function starRun(best: number, seed = Date.now()): Game {
  const s = runState(seed >>> 0, best);
  return {
    w: SR_W,
    h: SR_H,
    get score() {
      return s.score;
    },
    step: (pad) => stepRun(s, pad),
    draw: (ctx) => drawRun(ctx, s),
  };
}
