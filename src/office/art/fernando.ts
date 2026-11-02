// Fernando, the Spanish teacher: a man in a wide straw sombrero (a band in the flag's
// green, white and red), a big black mustache and a striped poncho. He doesn't walk
// about like the workers: he stands in the lounge and you click him for the Spanish
// lessons, the way you click the TV for a game. Half again a worker's width, for the
// sombrero's brim.
//
// One template, facing you, and poses stamped over it: a breath (the body settles a
// pixel), a blink, a mustache twitch, the hat lifted, a raised hand and an open mouth
// for teaching. Keys as the workers' (`o` outline, `e` eye, `m` mouth, `s`/`S` skin,
// `h` hair, `p`/`P` trousers, `k`/`K` boots) plus `y`/`Y` straw, `u` mustache, `g`
// `c` `r` the band, `q`/`Q` the poncho and `v` `a` its stripes.

import { bitmap, draw, type Bitmap, type ColorMap } from "./pixels";
import { CLOTH, HAIR, INK, PANTS, SKIN } from "./palette";

export const FERNANDO_W = 24;
export const FERNANDO_H = 33;
/** A row over the hat, for lifting it. */
const HEADROOM = 1;

const COLORS: ColorMap = {
  o: INK.o,
  e: INK.e,
  m: INK.m,
  c: INK.c,
  s: SKIN.tan.base,
  S: SKIN.tan.shade,
  h: HAIR.black.base,
  u: "#241c22",
  y: "#ecc96a",
  Y: "#bd923f",
  g: "#2f8f4e",
  r: CLOTH.red.base,
  q: "#d9623b",
  Q: "#a8452a",
  v: CLOTH.green.base,
  a: CLOTH.yellow.base,
  p: PANTS.charcoal.base,
  P: PANTS.charcoal.shade,
  k: "#6e4a33",
  K: "#4e3424",
};

/** `s` (an even width) centred in the frame. */
const mid = (s: string): string => {
  const pad = ".".repeat((FERNANDO_W - s.length) / 2);
  return pad + s + pad;
};
const run = (k: string, n: number): string => k.repeat(n);

/** Him, facing you, in body rows (the hat's tip is row 0). */
const BODY = [
  mid("oooo"), //  0 the crown
  mid("oyyyyo"),
  mid("oyyyyyYo"),
  mid("oyyyyyYo"),
  mid("ogcrgcrgco"), //  4 the band
  ".oo....oyyyyyyYYo....oo.", //  5 the brim curls up at its ends
  "o" + run("y", 20) + "YYo",
  ".o" + run("Y", 20) + "o.",
  "....oooohSSSSSShoooo....", //  8 the face, shaded under the brim
  mid("ohssssssho"),
  mid("ohsessesho"), // 10 eyes
  mid("ohssSSssho"),
  mid("osuuuuuuso"), // 12 the mustache
  mid("ouusmmsuuo"),
  mid("ouSSSSuo"), // 14 its ends droop past the chin
  mid("oooooo"),
  mid("oqqqqssqqqqo"), // 16 the poncho, a V at the neck
  mid("oqqqqqooqqqqqo"),
  mid("o" + run("q", 14) + "o"),
  mid("o" + run("v", 16) + "o"), // 19 stripes
  mid("o" + run("c", 16) + "o"),
  mid("o" + run("q", 18) + "o"),
  mid("oQ" + run("q", 16) + "Qo"),
  mid("o" + run("r", 20) + "o"),
  mid("o" + run("a", 20) + "o"),
  mid("o" + run("Q", 20) + "o"), // 25 the hem
  "..q.q.qopPo..oPpoq.q.q..", // 26 fringe, and the legs under it
  mid("opPo..oPpo"),
  mid("opPo..oPpo"),
  mid("okkko..okkko"), // 29 boots
  mid("okkkKo..oKkkko"),
  mid("oooooo..oooooo"),
];

/** Where the upper body ends: a breath moves the rows above, the legs stay put. */
const LEGS_FROM = 26;
const BRIM_TO = 7;

/** A mustache twitch: its ends turn up for a moment. */
const TWITCH: Record<number, string> = {
  12: mid("ouuuuuuuuo"),
  13: mid("osssmmssso"),
  14: mid("oSSSSSSo"),
};

/** The open mouth, under the mustache. */
const TALK: Record<number, string> = {
  13: mid("ouummmmuuo"),
  14: mid("ouSmmSuo"),
};

/** A blink. */
const BLINK: Record<number, string> = {
  10: mid("ohsSssSsho"),
};

/** A hand raised by his head (on your right), the poncho's edge for a sleeve; `wave`
 *  tips it over. Stamped with its top-left at (`HAND_X`, `HAND_Y`). */
const HAND_X = 18;
const HAND_Y = 12;
const HAND = ["..oo.", ".osso", ".osSo", ".oqqo", "oqqo.", "oqo.."];
const WAVE = [".oo..", "osso.", "oSso.", ".oqqo", "oqqo.", "oqo.."];

export interface FernandoPose {
  blink?: boolean;
  twitch?: boolean;
  talk?: boolean;
  /** The body settles a pixel, as on a breath. */
  breath?: boolean;
  /** The sombrero lifted a pixel off his head, in greeting. */
  hatUp?: boolean;
  hand?: "up" | "wave";
}

function stamp(cells: string[][], x: number, y: number, rows: readonly string[]): void {
  rows.forEach((line, r) => {
    [...line].forEach((k, c) => {
      if (k !== "." && cells[y + r]?.[x + c] !== undefined) cells[y + r][x + c] = k;
    });
  });
}

/** Fernando's frame in `pose`, as rows of keys. */
export function fernandoRows(pose: FernandoPose = {}): string[] {
  const body = BODY.map((line, n) => {
    if (pose.blink && BLINK[n]) return BLINK[n];
    if (pose.talk && TALK[n]) return TALK[n];
    if (pose.twitch && TWITCH[n]) return TWITCH[n];
    return line;
  });
  const cells = Array.from({ length: FERNANDO_H }, () => Array.from({ length: FERNANDO_W }, () => "."));
  // Legs first, then the upper body over them, a pixel lower on a breath.
  stamp(cells, 0, HEADROOM + LEGS_FROM, body.slice(LEGS_FROM));
  const drop = pose.breath ? 1 : 0;
  const face = body.slice(BRIM_TO + 1, LEGS_FROM);
  stamp(cells, 0, HEADROOM + BRIM_TO + 1 + drop, face);
  if (pose.hatUp) {
    // His hair shows under the lifted brim.
    stamp(cells, 7, HEADROOM + BRIM_TO + drop, ["ohhhhhhhho"]);
    stamp(cells, 0, HEADROOM - 1 + drop, body.slice(0, BRIM_TO + 1));
  } else {
    stamp(cells, 0, HEADROOM + drop, body.slice(0, BRIM_TO + 1));
  }
  if (pose.hand) stamp(cells, HAND_X, HEADROOM + HAND_Y + drop, pose.hand === "wave" ? WAVE : HAND);
  return cells.map((line) => line.join(""));
}

export function fernandoFrame(pose: FernandoPose = {}): Bitmap {
  const out = bitmap(FERNANDO_W, FERNANDO_H);
  draw(out, { rows: fernandoRows(pose) }, COLORS);
  return out;
}

/** What he's doing: standing about; teaching (his lesson's session is working); or
 *  waiting on you (it needs you). */
export type FernandoAnim = "idle" | "teach" | "ask";

export const FERNANDO_ANIMS: Record<FernandoAnim, { pose: FernandoPose; ms: number }[]> = {
  idle: [
    { pose: {}, ms: 1400 },
    { pose: { breath: true }, ms: 1300 },
    { pose: {}, ms: 1400 },
    { pose: { blink: true }, ms: 120 },
    { pose: {}, ms: 900 },
    { pose: { breath: true }, ms: 1300 },
    { pose: { twitch: true }, ms: 180 },
    { pose: {}, ms: 140 },
    { pose: { twitch: true }, ms: 180 },
    { pose: {}, ms: 1400 },
    { pose: { breath: true }, ms: 1300 },
    { pose: { blink: true }, ms: 120 },
    { pose: {}, ms: 1200 },
    { pose: { hatUp: true }, ms: 700 },
    { pose: {}, ms: 1400 },
    { pose: { breath: true }, ms: 1300 },
  ],
  teach: [
    { pose: { hand: "up", talk: true }, ms: 220 },
    { pose: { hand: "up" }, ms: 160 },
    { pose: { hand: "up", talk: true }, ms: 200 },
    { pose: { hand: "up" }, ms: 380 },
    { pose: { talk: true }, ms: 220 },
    { pose: {}, ms: 200 },
    { pose: { talk: true, breath: true }, ms: 240 },
    { pose: { breath: true }, ms: 600 },
    { pose: { blink: true }, ms: 120 },
  ],
  ask: [
    { pose: { hand: "up" }, ms: 320 },
    { pose: { hand: "wave" }, ms: 320 },
    { pose: { hand: "up" }, ms: 320 },
    { pose: { hand: "wave" }, ms: 320 },
    { pose: { breath: true }, ms: 1200 },
    { pose: { blink: true }, ms: 120 },
    { pose: {}, ms: 900 },
  ],
};

/** For tests: every pose of every animation. */
export function allFernandoPoses(): FernandoPose[] {
  return Object.values(FERNANDO_ANIMS).flatMap((frames) => frames.map((f) => f.pose));
}
