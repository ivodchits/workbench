// Lupa, the office dog: a golden, short-haired mutt with big upright ears, a white
// blaze down her face, a white chest and socks, and a pink collar with a gold tag. She
// walks about, naps on the floor, fetches the office ball and likes being petted.
//
// One frame size for every pose, `LUPA_W`×`LUPA_H`, her feet on the bottom row. The
// side view is drawn facing right (left is mirrored) from parts — head, body, tail,
// legs — so a pose is where they go; `down` (facing you, sitting or standing), `up`
// (her back) and asleep are whole templates. Keys: `o` outline, `f`/`F` fur and its
// shade, `w` white, `i` inside the ears, `e` eye, `n` nose, `t` tongue, `c` collar,
// `g` its tag, `z`/`Z` the ball and its seam.

import { bitmap, draw, mirrorBitmap, type Bitmap, type ColorMap, type Part } from "./pixels";
import { INK } from "./palette";

export const LUPA_W = 24;
export const LUPA_H = 18;

export type LupaView = "down" | "up" | "left" | "right";

export const LUPA_COLORS: ColorMap = {
  o: INK.o,
  e: INK.e,
  f: "#d9a465",
  F: "#b88145",
  w: "#f3eadb",
  i: "#e9b39c",
  n: "#2b1e2f",
  t: "#e8697f",
  c: "#c93c66",
  g: "#f2c64a",
  z: "#cfe04a",
  Z: "#f4f1ea",
};

const part = (rows: string[], x = 0, y = 0): Part => ({ rows, x, y });

// ── Side, facing right ───────────────────────────────────────────────────────

/** Her head and neck, 11 wide: the ears, the blaze, the eye, the nose. */
const HEAD = part([
  "..o..o.....",
  ".oio.ofo...",
  ".oifoifo...",
  ".offffffo..",
  "offfwfeffo.",
  "offfwwffffo",
  "oFfwwwwfffn",
  "occcwwwwwo.",
  "ocgcwwooo..",
], 13, 0);
/** Eyes shut (a blink, being petted). */
const HEAD_SHUT = part(["ffo"], 18, 4);
/** Her mouth open, panting: running, waiting for a throw. */
const HEAD_PANT = part(["wwwwo.", "wwtto.", "woto.."], 17, 6);

const BODY = part([
  "....ooooooooo..........",
  "...offfffffffffffwwo...",
  "...offfffffffffffwwo...",
  "...offfffffffffffwwo...",
  "...oFffffffffffffwwo...",
  "...oFFfFFFFFFFFFwwo....",
], 0, 8);

const TAIL_UP = part([".o..", ".of.", "..of", "..of"], 0, 5);
const TAIL_WAG = part(["....", "oo..", "ofoo", ".off"], 0, 5);
const TAIL_DOWN = part(["..of", ".of.", ".of.", "..o."], 0, 9);

const LEGS_STAND = part([
  "...ofFo.ofo..ofwo.......",
  "...ofo..ofo..ofwo.......",
  "...owo..owo..owwo.......",
  "...ooo..ooo..oooo.......",
], 0, 14);
const LEGS_STRIDE = part([
  "...ofo..ofo...ofwo......",
  "..ofo....ofo...ofwo.....",
  "..owo....owo...owwo.....",
  "..ooo....ooo...oooo.....",
], 0, 14);
const LEGS_GATHER = part([
  "...oFfo.ofo.ofwo........",
  "....ofo.ofoofwo.........",
  "....owo.owoowwo.........",
  "....ooo.ooooooo.........",
], 0, 14);

/** Where the ball goes in her mouth (its top-left), side on and facing you. */
const BALL_SIDE = { x: 20, y: 6 };
const BALL_DOWN = { x: 10, y: 10 };

// ── Facing you, and from behind ──────────────────────────────────────────────

const FRONT_HEAD = [
  "......o..........o......",
  ".....ofo........ofo.....",
  ".....ofio......oifo.....",
  ".....ofiio....oiifo.....",
  ".....offfoooooofffo.....",
  ".....offfffwwfffffo.....",
  ".....offefwwwwfeffo.....",
  ".....offffwwwwffffo.....",
  ".....oFfwwwnnwwwfFo.....",
  ".....oFwwwowwowwwFo.....",
  "......oFfwwwwwwfFo......",
  "......occcccgcccco......",
];
/** Sitting, facing you: front paws together, haunches out either side. */
const FRONT_SIT = part([
  ...FRONT_HEAD,
  ".....offwwwwwwwwffo.....",
  ".....ofwwwwwwwwwwfo.....",
  "....oFfowwwwwwwwofFo....",
  "....oFfowwo..owwofFo....",
  "....oFFowwo..owwoFFo....",
  "....ooooooo..ooooooo....",
]);
const FRONT_LEGS = [
  ".....offwwwwwwwwffo.....",
  "......ofwwwwwwwwfo......",
  "......owwo....owwo......",
  "......owwo....owwo......",
  "......owwo....owwo......",
  "......oooo....oooo......",
];
const FRONT_STAND = part([...FRONT_HEAD, ...FRONT_LEGS]);
const FRONT_STEP = part([
  ...FRONT_HEAD,
  ...FRONT_LEGS.slice(0, 3),
  "......owwo....owwo......",
  "......oooo....owwo......",
  "..............oooo......",
]);
/** Facing you: eyes shut and happy, tongue out (petted). */
const FRONT_BLINK = part([".....offFfwwwwfFffo....."], 0, 6);
/** Happy: eyes squeezed shut into arcs. */
const FRONT_HAPPY = part([".....offofwwwwfoffo.....", ".....offFfwwwwfFffo....."], 0, 5);
const FRONT_TONGUE = part(["..........otto..........", "...........oo..........."], 0, 10);

const BACK_HEAD = [
  "......o..........o......",
  ".....ofo........ofo.....",
  ".....offo......offo.....",
  ".....offfo....offfo.....",
  ".....offfoooooofffo.....",
  ".....offffffffffffo.....",
  ".....offffffffffffo.....",
  ".....oFfffffffffffo.....",
  ".....oFffffffffffFo.....",
  ".....oFFfffffffffFo.....",
  "......oFFffffffFFo......",
  "......occcccccccco......",
];
const BACK_LEGS = [
  ".....offffFFffffffo.....",
  "......offfFFfffffo......",
  "......offo.FF.offo......",
  "......offo....offo......",
  "......owwo....owwo......",
  "......oooo....oooo......",
];
const BACK_STAND = part([...BACK_HEAD, ...BACK_LEGS]);
const BACK_STEP = part([
  ...BACK_HEAD,
  ...BACK_LEGS.slice(0, 3),
  "......owwo....offo......",
  "......oooo....owwo......",
  "..............oooo......",
]);

// ── Asleep ───────────────────────────────────────────────────────────────────

/** Curled on the floor, head on her paws, ears flopped back, tail round. */
const SLEEP = part([
  ".............o.oo.......",
  "............ofoffo......",
  "....oooooooofffffo......",
  "...offfffffffffffoo.....",
  "..offffffffffffFoffo....",
  ".ofFfffffffffffffffwwn..",
  "ofFFfffffffffcgcwwwwo...",
  "owffFFFFFFFFFwwwwwwo....",
  ".ooooooooooooooooo......",
], 0, 9);
/** Breathing in: the back rises. */
const SLEEP_IN = part(["....oooooooo", "...offffffff"], 0, 10);

// ── Poses ────────────────────────────────────────────────────────────────────

export type LupaPose =
  | "stand"
  | "blink"
  | "wag"
  | "walkA"
  | "walkB"
  | "runA"
  | "runB"
  | "sniffA"
  | "sniffB"
  | "pant"
  | "sit"
  | "sitBlink"
  | "happy"
  | "sleep"
  | "sleepIn";

interface Side {
  legs: Part;
  tail: Part;
  /** The head's nudge (down to sniff). */
  head?: { dx: number; dy: number };
  /** The whole body's (up off the floor, running). */
  dy?: number;
  shut?: boolean;
  pant?: boolean;
}

/** Each pose side on; a pose with no side view (sitting, asleep) falls back to standing. */
const SIDE: Partial<Record<LupaPose, Side>> = {
  stand: { legs: LEGS_STAND, tail: TAIL_UP },
  blink: { legs: LEGS_STAND, tail: TAIL_UP, shut: true },
  wag: { legs: LEGS_STAND, tail: TAIL_WAG },
  walkA: { legs: LEGS_STRIDE, tail: TAIL_UP },
  walkB: { legs: LEGS_GATHER, tail: TAIL_WAG },
  runA: { legs: LEGS_STRIDE, tail: TAIL_WAG, dy: -1, pant: true },
  runB: { legs: LEGS_GATHER, tail: TAIL_UP, pant: true },
  sniffA: { legs: LEGS_STAND, tail: TAIL_UP, head: { dx: 1, dy: 4 } },
  sniffB: { legs: LEGS_STAND, tail: TAIL_WAG, head: { dx: 1, dy: 5 } },
  pant: { legs: LEGS_STAND, tail: TAIL_WAG, pant: true },
  sleep: { legs: LEGS_STAND, tail: TAIL_DOWN },
};

/** Whether a pose is lying down (asleep): no side, front or back of its own. */
const ASLEEP = new Set<LupaPose>(["sleep", "sleepIn"]);

/** Facing you (or from behind), each pose's template and what goes over it. */
function front(pose: LupaPose, back: boolean): Part[] {
  const sit = pose === "sit" || pose === "sitBlink" || pose === "happy" || pose === "pant";
  const step = pose === "walkA" || pose === "runA";
  if (back) return [step ? BACK_STEP : BACK_STAND];
  const base = sit ? FRONT_SIT : step ? FRONT_STEP : FRONT_STAND;
  if (pose === "happy") return [base, FRONT_HAPPY, FRONT_TONGUE];
  if (pose === "sitBlink" || pose === "blink") return [base, FRONT_BLINK];
  if (pose === "pant" || pose === "runA" || pose === "runB") return [base, FRONT_TONGUE];
  return [base];
}

/** One frame of Lupa in `pose` seen from `view`, the ball in her mouth if `ball`. */
export function lupaFrame(pose: LupaPose, view: LupaView, ball = false): Bitmap {
  const out = bitmap(LUPA_W, LUPA_H);
  const put = (p: Part, dx = 0, dy = 0) => draw(out, p, LUPA_COLORS, dx, dy);
  if (ASLEEP.has(pose)) {
    put(SLEEP);
    if (pose === "sleepIn") put(SLEEP_IN);
    return view === "left" ? mirrorBitmap(out) : out;
  }
  if (view === "down" || view === "up") {
    for (const p of front(pose, view === "up")) put(p);
    if (ball && view === "down") put(BALL, BALL_DOWN.x, BALL_DOWN.y);
    return out;
  }
  const s = SIDE[pose] ?? SIDE.stand!;
  const dy = s.dy ?? 0;
  const head = { dx: s.head?.dx ?? 0, dy: (s.head?.dy ?? 0) + dy };
  put(s.tail, 0, dy);
  put(BODY, 0, dy);
  put(s.legs);
  put(HEAD, head.dx, head.dy);
  if (s.shut) put(HEAD_SHUT, head.dx, head.dy);
  if (s.pant && !ball) put(HEAD_PANT, head.dx, head.dy);
  if (ball) put(BALL, BALL_SIDE.x + head.dx, BALL_SIDE.y + head.dy);
  return view === "left" ? mirrorBitmap(out) : out;
}

// ── The ball ─────────────────────────────────────────────────────────────────

/** A tennis ball, 4×4, outlined; in her mouth or on the floor. */
const BALL = part([".oo.", "ozZo", "oZzo", ".oo."]);
export const BALL_W = 4;
export const BALL_H = 4;

export function ballFrame(): Bitmap {
  const out = bitmap(BALL_W, BALL_H);
  draw(out, BALL, LUPA_COLORS);
  return out;
}

/** Every template, for validation. */
export function lupaParts(): [string, Part][] {
  return Object.entries({
    HEAD,
    HEAD_SHUT,
    HEAD_PANT,
    BODY,
    TAIL_UP,
    TAIL_WAG,
    TAIL_DOWN,
    LEGS_STAND,
    LEGS_STRIDE,
    LEGS_GATHER,
    FRONT_SIT,
    FRONT_STAND,
    FRONT_STEP,
    FRONT_HAPPY,
    FRONT_BLINK,
    FRONT_TONGUE,
    BACK_STAND,
    BACK_STEP,
    SLEEP,
    SLEEP_IN,
    BALL,
    HEART,
  });
}

export const LUPA_POSES: readonly LupaPose[] = ["stand", "blink", "wag", "walkA", "walkB", "runA", "runB", "sniffA", "sniffB", "pant", "sit", "sitBlink", "happy", "sleep", "sleepIn"];

// ── Animations ───────────────────────────────────────────────────────────────

export type LupaAnim = "idle" | "walk" | "run" | "sniff" | "sit" | "pant" | "happy" | "sleep";

/** Each animation's frames; `views` are the ways it's drawn (others take the first). */
export const LUPA_ANIMS: Record<LupaAnim, { views: readonly LupaView[]; frames: readonly { pose: LupaPose; ms: number }[] }> = {
  idle: {
    views: ["right", "left", "down", "up"],
    frames: [
      { pose: "stand", ms: 2200 },
      { pose: "blink", ms: 140 },
      { pose: "stand", ms: 1400 },
      { pose: "wag", ms: 260 },
      { pose: "stand", ms: 260 },
      { pose: "wag", ms: 260 },
    ],
  },
  walk: {
    views: ["right", "left", "down", "up"],
    frames: [
      { pose: "walkA", ms: 130 },
      { pose: "stand", ms: 130 },
      { pose: "walkB", ms: 130 },
      { pose: "stand", ms: 130 },
    ],
  },
  run: {
    views: ["right", "left", "down", "up"],
    frames: [
      { pose: "runA", ms: 90 },
      { pose: "runB", ms: 90 },
    ],
  },
  sniff: {
    views: ["right", "left"],
    frames: [
      { pose: "sniffA", ms: 420 },
      { pose: "sniffB", ms: 260 },
      { pose: "sniffA", ms: 300 },
      { pose: "sniffB", ms: 500 },
    ],
  },
  sit: {
    views: ["down"],
    frames: [
      { pose: "sit", ms: 2600 },
      { pose: "sitBlink", ms: 140 },
      { pose: "sit", ms: 1700 },
      { pose: "sitBlink", ms: 140 },
    ],
  },
  /** Sitting, panting, eyes on you: throw it! */
  pant: {
    views: ["down"],
    frames: [
      { pose: "pant", ms: 1800 },
      { pose: "sitBlink", ms: 140 },
    ],
  },
  /** Being petted: eyes squeezed shut, tongue out. */
  happy: {
    views: ["down"],
    frames: [
      { pose: "happy", ms: 360 },
      { pose: "pant", ms: 240 },
    ],
  },
  sleep: {
    views: ["right", "left"],
    frames: [
      { pose: "sleep", ms: 1700 },
      { pose: "sleepIn", ms: 1700 },
    ],
  },
};

/** The view `anim` is drawn in when facing `view`. */
export const lupaView = (anim: LupaAnim, view: LupaView): LupaView => (LUPA_ANIMS[anim].views.includes(view) ? view : LUPA_ANIMS[anim].views[0]);

// ── A heart ──────────────────────────────────────────────────────────────────

const HEART = part([".oo.oo.", "owtotto", "ottttto", ".ottto.", "..oto..", "...o..."]);
export const HEART_W = 7;
export const HEART_H = 6;

/** A heart (a click on Anya, a pet for Lupa). */
export function heartFrame(): Bitmap {
  const out = bitmap(HEART_W, HEART_H);
  draw(out, HEART, { o: INK.o, t: "#ec5a7e", w: "#ffd0dc" });
  return out;
}
