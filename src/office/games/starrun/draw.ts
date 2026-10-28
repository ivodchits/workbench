// Star run's picture (office plan O5.3b): the starfield in three layers, the ship and
// the enemies as little sprites (white for a moment when hit), lumpy asteroids made from
// their outline number, bursts, and the score, lives and sector over it all. O5.3c adds
// the perks to pick up and what they give you, each zone's palette, and the bosses: a
// hull drawn from its plan with its turrets and glowing cores, and its health bar.

import { textBitmap } from "../../art/font";
import { bitmap, draw, keysOf, type ColorMap, type Part } from "../../art/pixels";
import { cached } from "../../canvas";
import type { Game } from "../game";
import { bossHealth, type Boss } from "./boss";
import { mix, PALETTES, SR_H, SR_W, ZONE_SECTORS, zoneOf } from "./sectors";
import { BANNER_STEPS, BURST_STEPS, MAGNET_STEPS, OVER_WAIT, ROCK_R, WARNING_STEPS, runState, stepRun, type RunState } from "./starrun";

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
  // The perks, each a capsule with its sign on it.
  spread: { rows: [".www.", "wkwkw", "wwkww", "wwkww", ".www."], colors: { w: "#ff8a3d", k: "#fff2a8" } },
  rapid: { rows: [".www.", "wkwkw", "wwkww", "wkwkw", ".www."], colors: { w: "#3fcf7f", k: "#e8ffe8" } },
  shield: { rows: [".www.", "wkkkw", "wkwkw", "wwkww", ".www."], colors: { w: "#4f8fe0", k: "#d8f0ff" } },
  bomb: { rows: [".www.", "wwkkw", "wkkkw", "wkkkw", ".www."], colors: { w: "#e0544f", k: "#2a1414" } },
  magnet: { rows: [".www.", "wkwkw", "wkwkw", "wwkww", ".www."], colors: { w: "#b06ce0", k: "#f0c3ff" } },
  oneup: { rows: [".www.", "wwkww", "wkkkw", "wkwkw", ".www."], colors: { w: "#ffcf3f", k: "#5a3a00" } },
  turret: { rows: [".ggg.", "ghhhg", "ghkhg", ".gkg.", "..k.."], colors: { g: "#4a4f5a", h: "#9aa3b0", k: "#1c1c22" } },
  wreck: { rows: [".k.k.", "kdkdk", ".dkd.", "k.d.k"], colors: { k: "#1c1c22", d: "#3a2a24" } },
} as const satisfies Record<string, { rows: readonly string[]; colors: ColorMap }>;

/** Each zone's look: the space, the three star layers, the asteroids (lit to dark) and
 *  a boss's hull (body, edge, plating) with the glow of its cores. */
interface Palette {
  space: string;
  stars: readonly [string, string, string];
  rock: readonly [string, string, string];
  hull: readonly [string, string, string];
  core: readonly [string, string];
}

const ZONE_PALETTES: readonly Palette[] = [
  { space: "#0b0a12", stars: ["#2e2a40", "#5b5470", "#c9c2d8"], rock: ["#b3a491", "#8a7a6a", "#5e5248"], hull: ["#5f6b7a", "#2c323c", "#7d8a9a"], core: ["#ff4f6f", "#ffd0da"] },
  { space: "#06121a", stars: ["#123040", "#2f6070", "#a8e8f0"], rock: ["#8fb0b0", "#5f8282", "#3c5656"], hull: ["#4a6a5a", "#1e3028", "#6f9a80"], core: ["#3fe0ff", "#d8faff"] },
  { space: "#170a10", stars: ["#40202a", "#704050", "#f0c0c8"], rock: ["#c49478", "#946a52", "#644434"], hull: ["#7a4a3a", "#3a2018", "#a06a52"], core: ["#ffcf3f", "#fff6c8"] },
  { space: "#0e0b1c", stars: ["#28205a", "#5040a0", "#d0c8ff"], rock: ["#a49ac0", "#766c94", "#4c446a"], hull: ["#5a4a8a", "#261c44", "#8070b8"], core: ["#7fff6f", "#e8ffe0"] },
  { space: "#10100a", stars: ["#363420", "#6a6638", "#f0eab0"], rock: ["#b8b08a", "#8a8462", "#5c5840"], hull: ["#6a6a4a", "#2c2c1c", "#94946a"], core: ["#ff8a3d", "#ffe0c0"] },
];
if (ZONE_PALETTES.length !== PALETTES) throw new Error("star run: a palette for each zone look");

const paletteOf = (s: RunState): Palette => ZONE_PALETTES[zoneOf(s.seed, s.zone).palette];

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
function rockSprite(size: 0 | 1 | 2, shape: number, white: boolean, pal: Palette): HTMLCanvasElement {
  return cached(`starrun/rock/${size}/${shape}/${white ? "hit" : pal.rock.join()}`, () => {
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
    draw(out, { rows }, white ? { l: "#ffffff", m: "#ffffff", d: "#ffffff" } : { l: pal.rock[0], m: pal.rock[1], d: pal.rock[2] });
    return out;
  });
}

const INK = "#ebe6f3";
const DIM = "#a39bb4";
const text = (s: string, color: string) => cached(`game-text/${color}/${s}`, () => textBitmap(s, color));
const centre = (ctx: CanvasRenderingContext2D, s: string, color: string, y: number) => {
  const t = text(s, color);
  ctx.drawImage(t, Math.round((SR_W - t.width) / 2), Math.round(y));
};

/** The stars: each layer moves at its own share of the scroll. */
const LAYERS = [
  { count: 34, speed: 0.15 },
  { count: 20, speed: 0.4 },
  { count: 10, speed: 1 },
] as const;

function drawStars(ctx: CanvasRenderingContext2D, distance: number, pal: Palette): void {
  LAYERS.forEach((l, n) => {
    ctx.fillStyle = pal.stars[n];
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

/** A boss's hull, as its plan draws it, in the zone's colours (white as it dies). */
function hullSprite(b: Boss, pal: Palette, white: boolean): HTMLCanvasElement {
  return cached(`starrun/boss/${b.plan.id}/${white ? "hit" : pal.hull.join()}`, () => {
    const out = bitmap(b.plan.w, b.plan.h);
    const [h, e, p] = white ? ["#ffffff", "#ffffff", "#ffffff"] : pal.hull;
    draw(out, { rows: b.plan.rows }, { h, e, p });
    return out;
  });
}

function drawBoss(ctx: CanvasRenderingContext2D, s: RunState, b: Boss, pal: Palette): void {
  put(ctx, hullSprite(b, pal, b.phase === "dying" && b.t % 8 < 3), b.x, b.y);
  for (const t of b.turrets) put(ctx, sprite(t.hp > 0 ? "turret" : "wreck", t.flash > 0), b.x + t.dx, b.y + t.dy);
  for (const c of b.cores) {
    const x = Math.round(b.x + c.dx);
    const y = Math.round(b.y + c.dy);
    if (c.hp <= 0) {
      ctx.fillStyle = "#1c1c22";
      ctx.fillRect(x - 2, y - 1, 5, 3);
      continue;
    }
    // The core throbs, faster as the boss weakens.
    const beat = Math.sin(s.t * (0.1 + 0.25 * (1 - bossHealth(b))));
    const hit = c.flash > 0;
    ctx.fillStyle = hit ? "#ffffff" : pal.hull[1];
    ctx.fillRect(x - 3, y - 2, 7, 5);
    ctx.fillRect(x - 2, y - 3, 5, 7);
    ctx.fillStyle = hit ? "#ffffff" : pal.core[0];
    ctx.fillRect(x - 2, y - 2, 5, 5);
    ctx.fillStyle = hit ? "#ffffff" : pal.core[1];
    ctx.fillRect(x - 1, y - 1, beat > 0 ? 3 : 2, beat > 0 ? 3 : 2);
  }
}

export function drawRun(ctx: CanvasRenderingContext2D, s: RunState): void {
  ctx.imageSmoothingEnabled = false;
  const pal = paletteOf(s);
  ctx.fillStyle = pal.space;
  ctx.fillRect(0, 0, SR_W, SR_H);
  drawStars(ctx, s.stars, pal);

  if (s.boss) drawBoss(ctx, s, s.boss, pal);
  for (const r of s.rocks) put(ctx, rockSprite(r.size, r.shape, r.flash > 0, pal), r.x, r.y);
  for (const e of s.enemies) put(ctx, sprite(e.kind, e.flash > 0), e.x, e.y);
  // A perk bobs, and blinks as it nears the bottom.
  for (const p of s.pickups) if (p.y < SR_H - 16 || p.t % 8 < 5) put(ctx, sprite(p.kind === "life" ? "oneup" : p.kind), p.x, p.y + Math.round(Math.sin(p.t * 0.15)));
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
    // A ring round it for each shield, turning.
    ctx.fillStyle = "#7fd1ff";
    for (let n = 0; n < ship.shield; n++) {
      const r = 7 + 2 * n;
      for (let k = 0; k < 12; k++) {
        if ((k + Math.floor(s.t / 6) + n) % 3 === 0) continue;
        const a = (k / 12) * Math.PI * 2 + n;
        ctx.fillRect(Math.round(ship.x + Math.cos(a) * r), Math.round(ship.y + Math.sin(a) * r), 1, 1);
      }
    }
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

  if (s.flash > 0) {
    ctx.fillStyle = `rgba(255, 246, 220, ${(s.flash / 14) * 0.8})`;
    ctx.fillRect(0, 0, SR_W, SR_H);
  }

  // Score, lives and the sector over the top; under the score, what the ship has.
  ctx.drawImage(text(String(s.score), INK), 4, 4);
  const pips = (n: number, x: number, color: string) => {
    ctx.fillStyle = color;
    for (let k = 0; k < n; k++) ctx.fillRect(x + k * 3, 11, 2, 2);
  };
  pips(ship.spread, 4, "#ff8a3d");
  pips(ship.rapid, 15, "#3fcf7f");
  pips(ship.shield, 26, "#7fd1ff");
  if (ship.magnet > 0) {
    ctx.fillStyle = "#b06ce0";
    ctx.fillRect(4, 14, Math.ceil((ship.magnet / (MAGNET_STEPS * 2)) * 30), 1);
  }
  // The boss's health, filling as it comes in.
  if (s.boss && s.boss.phase !== "dying") {
    const full = s.boss.phase === "enter" ? Math.min(1, s.boss.t / 100) : bossHealth(s.boss);
    ctx.fillStyle = "#15131b";
    ctx.fillRect(40, 13, SR_W - 80, 3);
    ctx.fillStyle = pal.core[0];
    ctx.fillRect(40, 13, Math.ceil((SR_W - 80) * full), 3);
  }
  const life = sprite("life");
  for (let n = 0; n < s.lives; n++) ctx.drawImage(life, SR_W - 4 - (n + 1) * (life.width + 2), 4);
  const where = text(`S${s.sector + 1}`, DIM);
  ctx.drawImage(where, Math.round((SR_W - where.width) / 2), 4);

  if (s.phase === "play" && s.banner > 0 && s.banner < BANNER_STEPS - 10 && Math.floor(s.banner / 8) % 4 !== 0) {
    if (s.sector % ZONE_SECTORS === 0) centre(ctx, `ZONE ${s.zone + 1}`, INK, 76);
    centre(ctx, `SECTOR ${s.sector + 1}`, "#ffcf3f", 86);
  }
  if (s.phase === "play" && s.warning > 0 && s.warning < WARNING_STEPS - 10 && Math.floor(s.warning / 10) % 3 !== 0) centre(ctx, "WARNING", "#ff6f91", 100);
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
