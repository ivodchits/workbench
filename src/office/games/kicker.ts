// The kicker (office plan O5.2): table football seen from above, you (blue) against the
// computer (red), first to five, your end of the table drawn at random and swapped every
// rematch. Each side has four rods (goalie 1,
// defence 2, midfield 5, attack 3) and you hold two at a time, one per hand (pad.ts's
// left and right), each moved along your rods on its own; the hands never cross, the
// left one's rod always left of the right one's. Up and down slides a rod, left and
// right swings its men that way on a spring (toward the other goal kicks); a foot hits the
// ball with the speed it really has, so a swing from back is a shot and a still foot a
// wall. Swung far either way the feet lift and the ball rolls under. The computer
// plays all four of its rods, a touch slower and late on where the ball is going.
// A ball that stops out of everyone's reach is served again.

import { textBitmap } from "../art/font";
import { cached } from "../canvas";
import type { GameDef } from "./game";
import type { Pad } from "./pad";

export const KICKER_W = 200;
export const KICKER_H = 134;
/** The playing field, inside the walls; the goals are gaps in its ends. */
export const FIELD = { x: 12, y: 20, w: 176, h: 96 };
export const GOAL_H = 32;
export const MID_Y = FIELD.y + FIELD.h / 2;
export const BALL_R = 2;
export const FOOT_R = 2;
/** From the rod to the foot: how far a swing reaches forward or back. */
export const LEG = 9;
/** Swung past this (radians) the feet are off the table. */
export const LIFT = 1;
const SWING = 1.4;
/** Rod slide, px a step at full push, for you and for the computer. */
const SLIDE = 2.2;
const CPU_SLIDE = 1.5;
/** How far back the computer winds up, of a full swing: short of lifting its feet. */
const WIND = 0.6;
const SLIDE_ACCEL = 0.45;
const SPRING = 0.12;
const DAMP = 0.45;
const MAX_SPIN = 0.5;
const BALL_MAX = 5;
const ROLL = 0.994;
const WALL_BOUNCE = 0.75;
const FOOT_BOUNCE = 0.5;
/** Ball moves per step, so a fast ball doesn't pass through a foot. */
const SUBSTEPS = 4;
export const TO_WIN = 5;
export const SERVE_STEPS = 40;
export const GOAL_STEPS = 75;
export const DEAD_STEPS = 180;
const DEAD_SPEED = 0.15;

/** 0 is you, 1 the computer. */
export type Side = 0 | 1;
export const GOALIE = 0;
export const DEFENCE = 1;
export const MIDFIELD = 2;
export const ATTACK = 3;

const MEN = [1, 2, 5, 3];
const GAP = [0, 36, 18, 30];
const travel = (kind: number) => (kind === GOALIE ? GOAL_H / 2 + 6 : (FIELD.h - (MEN[kind] - 1) * GAP[kind]) / 2 - FOOT_R - 1);
/** The rods left to right, by end (0 the side defending the left goal, 1 the right) and kind. */
const ORDER: readonly (readonly [number, number])[] = [
  [0, GOALIE],
  [0, DEFENCE],
  [1, ATTACK],
  [0, MIDFIELD],
  [1, MIDFIELD],
  [0, ATTACK],
  [1, DEFENCE],
  [1, GOALIE],
];

export interface Rod {
  side: Side;
  kind: number;
  x: number;
  /** The way it attacks: -1 left, 1 right. */
  dir: number;
  men: number;
  gap: number;
  travel: number;
  /** Slide from the middle, and its speed. */
  pos: number;
  vel: number;
  /** Swing in radians, forward positive, and its speed. */
  th: number;
  spin: number;
  /** Both as they were before this step, for the feet's speed. */
  lastPos: number;
  lastTh: number;
  /** The computer's kick: winding up, then swinging through. */
  kick: { move: "rest" | "wind" | "swing"; t: number };
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface KickerState {
  rods: Rod[];
  ball: Ball;
  score: [number, number];
  /** You defend the right goal (else the left). */
  right: boolean;
  /** Your hands' rods, left then right, as places along your rods left to right
   * (`placeOf`); the left always the lower. */
  hands: [number, number];
  phase: "serve" | "play" | "goal" | "over";
  /** Steps left of a serve or a goal's pause. */
  timer: number;
  paused: boolean;
  /** The rod that last touched the ball. */
  touch: { side: Side; kind: number } | null;
  /** Steps the ball has lain still. */
  still: number;
  serves: number;
  /** Where each side thinks the ball is, late, and how far off it aims. */
  seen: [number, number];
  miss: [number, number];
  seed: number;
  /** Start and the hands' moves as they were, so a press counts once. */
  held: { start: boolean; left: number; right: number };
  gamepad: boolean;
}

export const manY = (rod: Rod, n: number, pos = rod.pos) => MID_Y + pos + (n - (rod.men - 1) / 2) * rod.gap;
export const footX = (rod: Rod, th = rod.th) => rod.x + rod.dir * LEG * Math.sin(th);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Mulberry32, kept in the state so a game replays the same. */
function random(s: KickerState): number {
  s.seed = (s.seed + 0x6d2b79f5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A new game; you defend the `right` goal or the left, by chance if not said. */
export function kickerState(seed = Date.now(), right?: boolean): KickerState {
  const gap = FIELD.w / ORDER.length;
  const s: KickerState = {
    rods: [],
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    score: [0, 0],
    right: true,
    hands: [0, 0],
    phase: "serve",
    timer: 0,
    paused: false,
    touch: null,
    still: 0,
    serves: 0,
    seen: [MID_Y, MID_Y],
    miss: [0, 0],
    seed,
    held: { start: false, left: 0, right: 0 },
    gamepad: false,
  };
  s.right = right ?? random(s) < 0.5;
  s.rods = ORDER.map(([end, kind], n) => ({
    side: (end === 1) === s.right ? 0 : 1,
    kind,
    x: FIELD.x + gap * (n + 0.5),
    dir: end === 1 ? -1 : 1,
    men: MEN[kind],
    gap: GAP[kind],
    travel: travel(kind),
    pos: 0,
    vel: 0,
    th: 0,
    spin: 0,
    lastPos: 0,
    lastTh: 0,
    kick: { move: "rest", t: 0 },
  }));
  // From the right the right hand starts on the goalie, the left on midfield; mirrored
  // from the left.
  s.hands = s.right ? [placeOf(s, MIDFIELD), placeOf(s, GOALIE)] : [placeOf(s, GOALIE), placeOf(s, MIDFIELD)];
  serve(s);
  return s;
}

/** The ball to the middle of a side wall, top and bottom in turn, rolling in shortly. */
function serve(s: KickerState): void {
  const top = s.serves++ % 2 === 0;
  s.ball = { x: FIELD.x + FIELD.w / 2, y: top ? FIELD.y + BALL_R + 1 : FIELD.y + FIELD.h - BALL_R - 1, vx: 0, vy: 0 };
  s.phase = "serve";
  s.timer = SERVE_STEPS;
  s.still = 0;
  s.touch = null;
}

export const rodOf = (s: KickerState, side: Side, kind: number) => s.rods.find((r) => r.side === side && r.kind === kind)!;

/** Moves a rod a step: `slide` and `swing` -1 to 1, the slide up to `top` px a step. */
function drive(rod: Rod, slide: number, swing: number, top: number): void {
  rod.lastPos = rod.pos;
  rod.lastTh = rod.th;
  rod.vel += clamp(slide * top - rod.vel, -SLIDE_ACCEL, SLIDE_ACCEL);
  rod.pos += rod.vel;
  if (Math.abs(rod.pos) > rod.travel) {
    rod.pos = Math.sign(rod.pos) * rod.travel;
    rod.vel = 0;
  }
  rod.spin = clamp(rod.spin + SPRING * (swing * SWING - rod.th) - DAMP * rod.spin, -MAX_SPIN, MAX_SPIN);
  rod.th += rod.spin;
  if (Math.abs(rod.th) > SWING) {
    rod.th = Math.sign(rod.th) * SWING;
    rod.spin = 0;
  }
}

/** How the computer works a rod this step: lines a man up with where it thinks the
 * ball will be, kicks one in front of it, lifts for one coming through from behind,
 * and keeps off one lying behind. */
export function autoRod(s: KickerState, rod: Rod): { slide: number; swing: number } {
  const b = s.ball;
  const aim = s.seen[rod.side] + s.miss[rod.side];
  let best = { pos: 0, cost: Infinity };
  for (let n = 0; n < rod.men; n++) {
    const want = aim - manY(rod, n, 0);
    const pos = clamp(want, -rod.travel, rod.travel);
    const cost = Math.abs(want - pos) * 10 + Math.abs(pos - rod.pos);
    if (cost < best.cost) best = { pos, cost };
  }
  const toward = (pos: number) => clamp((pos - rod.pos) / (CPU_SLIDE * 3), -1, 1);
  const ahead = (b.x - rod.x) * rod.dir;
  const reach = LEG + FOOT_R + BALL_R;
  const touching = FOOT_R + BALL_R + 1;
  const nearest = Array.from({ length: rod.men }, (_, n) => manY(rod, n) - b.y).reduce((a, d) => (Math.abs(d) < Math.abs(a) ? d : a));
  const level = Math.abs(nearest) < touching;
  const slow = Math.hypot(b.vx, b.vy) < 1.5;
  const sidestep = toward(rod.pos + Math.sign(nearest || 1) * (touching + 1 - Math.abs(nearest)));
  const k = rod.kick;
  if (k.move === "wind" && --k.t <= 0) Object.assign(k, { move: "swing", t: 10 });
  else if (k.move === "swing" && k.t > 0) k.t--;
  const up = rod.th > LIFT - 0.1;
  if ((k.move === "swing" && k.t <= 0) || (k.move === "rest" && up)) {
    // Raised feet stay up over a ball: coming down on it they'd knock it home. A ball
    // lying there is stepped round first.
    if (level && ahead > -2 && ahead < reach + 2) return { slide: slow ? sidestep : 0, swing: 1 };
    k.move = "rest";
  }
  const slide = toward(best.pos);
  if (k.move !== "rest") return { slide, swing: k.move === "wind" ? -WIND : 1 };
  if (s.phase !== "play" || !level) return { slide, swing: 0 };
  // Not at one coming in fast: a wind-up then is a gap; it just blocks. And only from
  // behind the ball, or the wind-up itself knocks it back.
  const coming = b.vx * rod.dir < -1;
  if (!coming && ahead > 0.5 && ahead < reach && rod.th < 0.15) {
    Object.assign(k, { move: "wind", t: 7 });
    s.miss[rod.side] = (random(s) - 0.5) * 6;
    return { slide, swing: -WIND };
  }
  // A ball from its own men behind, going forward: let it through. One lying behind
  // can't be reached without knocking it home, so the man steps off it.
  const behind = ahead < -0.5 && ahead > -(LEG + 6);
  if (behind && b.vx * rod.dir > 0.3) return { slide, swing: 1 };
  if (behind) return { slide: sidestep, swing: 0 };
  return { slide, swing: 0 };
}

/** Bounces the ball off a point (a foot or a post) moving at (vx, vy). */
/** `side` is the way to push a ball dead on the point. */
function hit(b: Ball, x: number, y: number, vx: number, vy: number, r: number, bounce: number, side: number): boolean {
  let dx = b.x - x;
  let dy = b.y - y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  if (d < 1e-6) [dx, dy] = [side, 0];
  else [dx, dy] = [dx / d, dy / d];
  b.x = x + dx * r;
  b.y = y + dy * r;
  const vn = (b.vx - vx) * dx + (b.vy - vy) * dy;
  if (vn < 0) {
    b.vx -= (1 + bounce) * vn * dx;
    b.vy -= (1 + bounce) * vn * dy;
  }
  return true;
}

/** Keeps the ball off the walls and posts; the side that scored, if it went in (`left`
 * scoring in the left goal). */
function walls(b: Ball, left: Side): Side | null {
  const top = FIELD.y + BALL_R;
  const bottom = FIELD.y + FIELD.h - BALL_R;
  if (b.y < top) {
    b.y = top;
    b.vy = Math.abs(b.vy) * WALL_BOUNCE;
  } else if (b.y > bottom) {
    b.y = bottom;
    b.vy = -Math.abs(b.vy) * WALL_BOUNCE;
  }
  // Each end: its wall, the side that scores in its goal, and which way is in.
  for (const [x, side, inward] of [
    [FIELD.x, left, 1],
    [FIELD.x + FIELD.w, left === 0 ? 1 : 0, -1],
  ] as const) {
    for (const y of [MID_Y - GOAL_H / 2, MID_Y + GOAL_H / 2]) hit(b, x, y, 0, 0, BALL_R, WALL_BOUNCE, inward);
    const out = (x - b.x) * inward;
    if (Math.abs(b.y - MID_Y) < GOAL_H / 2) {
      if (out > BALL_R * 2) return side;
      if (out > 0) b.y = clamp(b.y, MID_Y - GOAL_H / 2 + BALL_R, MID_Y + GOAL_H / 2 - BALL_R);
    } else if (out > -BALL_R) {
      b.x = x + BALL_R * inward;
      b.vx = Math.abs(b.vx) * WALL_BOUNCE * inward;
    }
  }
  return null;
}

/** Moves the ball a step through the feet that are down; the side that scored, if any. */
function roll(s: KickerState): Side | null {
  const b = s.ball;
  for (let n = 1; n <= SUBSTEPS; n++) {
    const t = n / SUBSTEPS;
    b.x += b.vx / SUBSTEPS;
    b.y += b.vy / SUBSTEPS;
    for (const rod of s.rods) {
      const th = rod.lastTh + (rod.th - rod.lastTh) * t;
      if (Math.abs(th) >= LIFT) continue;
      const pos = rod.lastPos + (rod.pos - rod.lastPos) * t;
      const vx = footX(rod) - footX(rod, rod.lastTh);
      const vy = rod.pos - rod.lastPos;
      for (let m = 0; m < rod.men; m++) {
        if (hit(b, footX(rod, th), manY(rod, m, pos), vx, vy, BALL_R + FOOT_R, FOOT_BOUNCE, rod.dir)) s.touch = { side: rod.side, kind: rod.kind };
      }
    }
    const scored = walls(b, s.right ? 0 : 1);
    if (scored !== null) return scored;
  }
  const speed = Math.hypot(b.vx, b.vy);
  const k = (speed > BALL_MAX ? BALL_MAX / speed : 1) * ROLL;
  b.vx *= k;
  b.vy *= k;
  return null;
}

/** A kind's place along your rods left to right: goalie first from the left goal,
 * attack first from the right. */
export const placeOf = (s: KickerState, kind: number) => (s.right ? ATTACK - kind : kind);

/** Moves each hand along a press, never onto or past the other hand. */
function moveHands(s: KickerState, pad: Pad | null): void {
  const [l, r] = s.hands;
  const left = pad?.move.left ?? 0;
  const right = pad?.move.right ?? 0;
  if (left && left !== s.held.left) s.hands[0] = clamp(l + left, 0, r - 1);
  if (right && right !== s.held.right) s.hands[1] = clamp(r + right, l + 1, ATTACK);
  s.held.left = left;
  s.held.right = right;
}

/** One step: `pad` works your two rods; with none the computer plays your side too. */
export function stepKicker(s: KickerState, pad: Pad | null): void {
  s.gamepad = pad ? !!pad.gamepad : s.gamepad;
  const start = !!pad?.start && !s.held.start;
  s.held.start = !!pad?.start;
  if (start) {
    if (s.phase === "over") {
      // The rematch at the other end.
      Object.assign(s, kickerState(s.seed, !s.right), { gamepad: s.gamepad, held: s.held });
      return;
    }
    s.paused = !s.paused;
  }
  if (s.paused || s.phase === "over") return;
  moveHands(s, pad);

  const b = s.ball;
  for (const side of [0, 1] as const) s.seen[side] += (b.y + b.vy * 6 - s.seen[side]) * 0.15;
  for (const rod of s.rods) {
    if (rod.side === 1 || !pad) {
      const { slide, swing } = autoRod(s, rod);
      drive(rod, slide, swing, CPU_SLIDE);
    } else {
      const at = s.hands.indexOf(placeOf(s, rod.kind));
      const hand = at === 0 ? pad.left : at === 1 ? pad.right : null;
      drive(rod, hand?.y ?? 0, (hand?.x ?? 0) * rod.dir, SLIDE);
    }
  }

  if (s.phase === "serve") {
    if (--s.timer > 0) return;
    s.phase = "play";
    b.vx = (random(s) - 0.5) * 0.8;
    b.vy = (b.y < MID_Y ? 1 : -1) * (0.9 + random(s) * 0.6);
    return;
  }
  if (s.phase === "goal") {
    if (--s.timer > 0) return;
    if (Math.max(...s.score) >= TO_WIN) s.phase = "over";
    else serve(s);
    return;
  }
  const scored = roll(s);
  if (scored !== null) {
    s.score[scored]++;
    s.phase = "goal";
    s.timer = GOAL_STEPS;
    return;
  }
  s.still = Math.hypot(b.vx, b.vy) < DEAD_SPEED ? s.still + 1 : 0;
  if (s.still > DEAD_STEPS) serve(s);
}

const COLORS = {
  bg: "#15131b",
  wood: "#4a3226",
  field: "#2e6a3c",
  line: "#4b8a59",
  goal: "#0d0c11",
  rod: "#8a8f99",
  ball: "#f4f1ea",
  shadow: "#1e4a29",
  text: "#ebe6f3",
  muted: "#a39bb4",
  hands: ["#ffcf3f", "#7fd1ff"],
  team: [
    { body: "#4f8fe0", foot: "#2a5596", up: "#9cc4f5" },
    { body: "#e0544f", foot: "#93302d", up: "#f5a3a0" },
  ],
} as const;

const text = (s: string, color: string) => cached(`game-text/${color}/${s}`, () => textBitmap(s, color));

function drawKicker(ctx: CanvasRenderingContext2D, s: KickerState): void {
  const fill = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const { x: fx, y: fy, w: fw, h: fh } = FIELD;
  fill(COLORS.bg, 0, 0, KICKER_W, KICKER_H);
  fill(COLORS.wood, fx - 4, fy - 4, fw + 8, fh + 8);
  fill(COLORS.goal, fx - 6, MID_Y - GOAL_H / 2, fw + 12, GOAL_H);
  fill(COLORS.field, fx, fy, fw, fh);
  fill(COLORS.line, fx + fw / 2, fy, 1, fh);
  ctx.strokeStyle = COLORS.line;
  ctx.strokeRect(fx + fw / 2 - 11.5, MID_Y - 11.5, 24, 24);
  ctx.strokeRect(fx - 0.5, MID_Y - GOAL_H / 2 - 6.5, 14, GOAL_H + 14);
  ctx.strokeRect(fx + fw - 13.5, MID_Y - GOAL_H / 2 - 6.5, 14, GOAL_H + 14);

  for (const rod of s.rods) {
    const hand = rod.side === 0 ? s.hands.indexOf(placeOf(s, rod.kind)) : -1;
    fill(COLORS.rod, rod.x, fy - 8, 1, fh + 16);
    // The handle, on its own side of the table, sliding with the rod.
    const hy = rod.side === 0 ? fy + fh + 5 : fy - 11;
    fill(hand >= 0 ? COLORS.hands[hand] : COLORS.rod, rod.x - 1, hy + Math.round(rod.pos / 4), 3, 6);
    if (hand >= 0) ctx.drawImage(text(hand === 0 ? "L" : "R", COLORS.hands[hand]), Math.round(rod.x) - 1, fy + fh + 13);
  }
  const b = s.ball;
  if (s.phase !== "goal") {
    fill(COLORS.shadow, b.x - 1, b.y, 3, 3);
    fill(COLORS.ball, b.x - 2, b.y - 1, 4, 2);
    fill(COLORS.ball, b.x - 1, b.y - 2, 2, 4);
  }
  for (const rod of s.rods) {
    const team = COLORS.team[rod.side];
    const up = Math.abs(rod.th) >= LIFT;
    const lean = (footX(rod) - rod.x) * 0.35;
    for (let n = 0; n < rod.men; n++) {
      const y = manY(rod, n);
      const foot = footX(rod);
      fill(team.foot, Math.min(rod.x, foot), y - 0.5, Math.abs(foot - rod.x) + 1, 1);
      fill(up ? team.up : team.foot, foot - 1, y - 1, 3, 3);
      fill(team.body, rod.x + lean - 1, y - 2, 3, 5);
    }
  }

  const you = text("YOU", COLORS.team[0].body);
  const cpu = text("CPU", COLORS.team[1].body);
  // Each name and score over its own end.
  const [l, r] = s.right ? [cpu, you] : [you, cpu];
  const tally = s.right ? `${s.score[1]} - ${s.score[0]}` : `${s.score[0]} - ${s.score[1]}`;
  const score = text(tally, COLORS.text);
  ctx.drawImage(l, fx, 2);
  ctx.drawImage(r, fx + fw - r.width, 2);
  ctx.drawImage(score, Math.round((KICKER_W - score.width) / 2), 2);

  const start = s.gamepad ? "START" : "ENTER";
  const lines =
    s.phase === "over"
      ? [s.score[0] > s.score[1] ? "YOU WIN!" : "CPU WINS", `${start}: PLAY AGAIN`]
      : s.paused
        ? ["PAUSED", `${start}: GO ON`]
        : s.phase === "goal"
          ? [s.timer > GOAL_STEPS / 3 ? "GOAL!" : tally]
          : [];
  if (lines.length) {
    const bitmaps = lines.map((l) => text(l, COLORS.text));
    const w = Math.max(...bitmaps.map((t) => t.width)) + 12;
    const h = lines.length * 8 + 7;
    fill(COLORS.bg, (KICKER_W - w) / 2, MID_Y - h / 2, w, h);
    bitmaps.forEach((t, n) => ctx.drawImage(t, Math.round((KICKER_W - t.width) / 2), Math.round(MID_Y - h / 2 + 4 + n * 8)));
  }
}

export const kickerGame: GameDef = {
  title: "Kicker",
  help:
    "two rods at once — left hand WASD, the d-pad or left stick, Q/E or LB/LT to change rod; right hand IJKL (or arrows), " +
    "A/B/X/Y or right stick, U/O or RT/RB to change rod · up/down slides, left/right swings (toward their goal kicks) · " +
    "Enter or Start: pause · Esc or Back: close",
  make() {
    const s = kickerState();
    return { w: KICKER_W, h: KICKER_H, step: (pad) => stepKicker(s, pad), draw: (ctx) => drawKicker(ctx, s) };
  },
};
