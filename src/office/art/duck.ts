// Duck, the boss (office plan OD.4): a huge rubber duck, three times a worker's
// width, in sunglasses and a red bow tie. Unlike the workers it is round, so it's generated rather than templated:
// the body and head are `blob` ellipses (lit from the top left, outlined), and the
// eyes, beak, cheeks and wing are stamped on top. That keeps the curves smooth and
// lets the poses (blink, look up, open beak, waddle) be parameters, not drawings.

import { bitmap, blob, draw, mirrorBitmap, type Bitmap, type ColorMap, type Ellipse } from "./pixels";

export const DUCK_W = 48;
export const DUCK_H = 48;

const COLORS: ColorMap = {
  o: "#2b1e2f",
  l: "#fff3a8", // yellow, light → dark
  y: "#ffd23f",
  d: "#e7a42a",
  n: "#ff8a3d", // beak
  N: "#d9622a",
  k: "#6b2a2a", // inside the beak
  e: "#1d1622",
  w: "#ffffff",
  b: "#d43a3a", // bow tie
  B: "#9a2530",
};

export type DuckView = "down" | "up" | "right" | "left";
export type Eyes = "open" | "closed" | "up";

export interface DuckPose {
  eyes?: Eyes;
  beakOpen?: boolean;
  /** Whole-duck nudge, for bobbing and waddling. */
  dx?: number;
  dy?: number;
}

interface Shape {
  body: Ellipse;
  head: Ellipse;
  tail?: Ellipse;
}

const SHAPES: Record<"down" | "up" | "right", Shape> = {
  down: { body: [24, 34, 20, 12.5], head: [24, 16, 12, 11.5] },
  up: { body: [24, 34, 20, 12.5], head: [24, 16, 12, 11.5], tail: [24, 24, 5, 4] },
  right: { body: [21, 34, 18.5, 12], head: [29, 16, 11, 11], tail: [6, 25, 5, 4.5] },
};

const inside = ([cx, cy, rx, ry]: Ellipse, x: number, y: number, grow = 0) =>
  ((x + 0.5 - cx) / (rx + grow)) ** 2 + ((y + 0.5 - cy) / (ry + grow)) ** 2 <= 1;

/** Stamp `rows` with its top-left at (x, y); `.` leaves what's there. */
function stamp(cells: string[][], x: number, y: number, rows: readonly string[]): void {
  rows.forEach((line, r) => {
    [...line].forEach((k, c) => {
      if (k !== "." && cells[y + r]?.[x + c] !== undefined) cells[y + r][x + c] = k;
    });
  });
}

/** A stamp: rows of keys with their top-left corner. */
type Stamp = readonly [x: number, y: number, rows: readonly string[]];

/** Everything that makes Duck's face: eyes per mood, beak shut and open, extras. The
 *  front view has a left and a right eye (the right is the left mirrored). In
 *  sunglasses the "eyes" are the lenses: the glint moves instead of the eyes. */
interface Face {
  eyes: Record<Eyes, readonly string[]>;
  eyeAt: readonly [left: readonly [number, number], right: readonly [number, number]];
  beak: { shut: Stamp; open: Stamp };
  extras?: readonly Stamp[];
  side: {
    eyes: Record<Eyes, readonly string[]>;
    eyeAt: readonly [number, number];
    beak: { shut: Stamp; open: Stamp };
    extras?: readonly Stamp[];
  };
}

const mirrorRows = (rows: readonly string[]) => rows.map((r) => [...r].reverse().join(""));

/** Sunglasses and a red bow tie: unreadable, in charge. */
const FACE: Face = {
  eyes: {
    open: ["oooooooo", "oweeeeeo", "oeweeeeo", ".oeeeeo."],
    closed: ["oooooooo", "oeeeeeeo", "oeeeeeeo", ".oeeeeo."],
    up: ["oooooooo", "oeeweeeo", "oeeeweeo", ".oeeeeo."],
  },
  eyeAt: [[14, 10], [26, 10]],
  beak: {
    shut: [19, 18, [".oooooooo.", "onnnnnnnno", "onnnnnnnNo", "oNNNNNNooo", ".oooooo..."]],
    open: [19, 18, [".oooooooo.", "onnnnnnnno", "oNkkkkkkNo", "oNkkkkkkNo", ".oNNNNNNo.", "..oooooo.."]],
  },
  extras: [
    [22, 10, ["oooo"]],
    [20, 25, ["oo.....oo", "obbooobbo", "obbbBbbbo", "obbooobbo", "oo.....oo"]],
  ],
  side: {
    eyes: {
      open: [".oweeeo", ".oeweeo", "..oeeo."],
      closed: [".oeeeeo", ".oeeeeo", "..oeeo."],
      up: [".oeweeo", ".oeeweo", "..oeeo."],
    },
    eyeAt: [29, 11],
    beak: {
      shut: [37, 16, [".ooooo....", "onnnnnoo..", "onnnnnnnoo", "oNNNNNNNNo", ".ooooooo.."]],
      open: [37, 16, [".ooooo....", "onnnnnoo..", "oNkkkknnoo", "oNkkkkNNNo", ".oNNNNoo..", "..oooo...."]],
    },
    extras: [[23, 10, ["oooooooooooooo"]], [25, 26, ["obbo", "oBBo", "obbo"]]],
  },
};

/** The body and head of each view, shaded and creased: the same under every pose. */
const bodies = new Map<"down" | "up" | "right", readonly string[]>();

function body(view: "down" | "up" | "right"): readonly string[] {
  let rows = bodies.get(view);
  if (rows) return rows;
  const shape = SHAPES[view];
  const parts: Ellipse[] = [shape.body, shape.head, ...(shape.tail ? [shape.tail] : [])];
  const cells = blob(DUCK_W, DUCK_H, parts, "lyd").map((line) => [...line]);

  // The crease where the head sits on the body.
  for (let y = Math.ceil(shape.head[1]); y < DUCK_H; y++) {
    for (let x = 0; x < DUCK_W; x++) {
      if (cells[y][x] === "o" || cells[y][x] === ".") continue;
      if (inside(shape.body, x, y) && inside(shape.head, x, y, 0.8) && !inside(shape.head, x, y)) cells[y][x] = "d";
    }
  }
  rows = cells.map((line) => line.join(""));
  bodies.set(view, rows);
  return rows;
}

function duckCells(view: "down" | "up" | "right", pose: DuckPose, face: Face): string[][] {
  const cells = body(view).map((line) => [...line]);

  const eyes = pose.eyes ?? "open";
  const put = ([x, y, rows]: Stamp) => stamp(cells, x, y, rows);
  if (view === "down") {
    // Wings: a darker arc on each side of the body.
    for (const [x, y] of [[7, 31], [7, 32], [8, 33], [9, 34], [39, 31], [39, 32], [38, 33], [37, 34]]) cells[y][x] = "d";
    const [[lx, ly], [rx, ry]] = face.eyeAt;
    put([lx, ly, face.eyes[eyes]]);
    put([rx, ry, mirrorRows(face.eyes[eyes])]);
    face.extras?.forEach(put);
    put(pose.beakOpen ? face.beak.open : face.beak.shut);
  } else if (view === "right") {
    // The wing: an outlined teardrop on the body's side.
    stamp(cells, 13, 30, [
      "..ddddd...",
      ".dyyyyydd.",
      "dyyyyyyyyd",
      ".ddyyyyyd.",
      "...ddddd..",
    ]);
    face.side.extras?.forEach(put);
    const [x, y] = face.side.eyeAt;
    put([x, y, face.side.eyes[eyes]]);
    put(pose.beakOpen ? face.side.beak.open : face.side.beak.shut);
  }
  const dx = pose.dx ?? 0;
  const dy = pose.dy ?? 0;
  if (!dx && !dy) return cells;
  const moved = cells.map((line) => line.map(() => "."));
  for (let y = 0; y < DUCK_H; y++) {
    for (let x = 0; x < DUCK_W; x++) {
      const k = cells[y][x];
      if (k !== "." && moved[y + dy]?.[x + dx] !== undefined) moved[y + dy][x + dx] = k;
    }
  }
  return moved;
}

/** Duck facing `view` in `pose`. */
export function duckFrame(view: DuckView, pose: DuckPose = {}): Bitmap {
  const drawn = view === "left" ? "right" : view;
  const out = bitmap(DUCK_W, DUCK_H);
  draw(out, { rows: duckCells(drawn, pose, FACE).map((line) => line.join("")) }, COLORS);
  return view === "left" ? mirrorBitmap(out) : out;
}

export type DuckAnim = "idle" | "think" | "speak" | "waddle";

export const DUCK_ANIMS: Record<DuckAnim, { pose: DuckPose; ms: number }[]> = {
  idle: [
    { pose: {}, ms: 900 },
    { pose: { dy: 1 }, ms: 900 },
    { pose: {}, ms: 900 },
    { pose: { eyes: "closed" }, ms: 130 },
    { pose: { dy: 1 }, ms: 900 },
  ],
  think: [
    { pose: { eyes: "up" }, ms: 700 },
    { pose: { eyes: "up", dy: 1 }, ms: 700 },
    { pose: { eyes: "up", dx: 1 }, ms: 700 },
    { pose: { eyes: "up", dx: 1, dy: 1 }, ms: 700 },
  ],
  speak: [
    { pose: { beakOpen: true }, ms: 150 },
    { pose: {}, ms: 130 },
    { pose: { beakOpen: true }, ms: 180 },
    { pose: {}, ms: 110 },
    { pose: { beakOpen: true, dy: 1 }, ms: 160 },
    { pose: {}, ms: 320 },
  ],
  waddle: [
    { pose: { dx: -1 }, ms: 150 },
    { pose: { dy: -1 }, ms: 150 },
    { pose: { dx: 1 }, ms: 150 },
    { pose: { dy: -1 }, ms: 150 },
  ],
};

/** For tests: every pose of every animation in every view. */
export function allDuckFrames(): Bitmap[] {
  const views: DuckView[] = ["down", "up", "right", "left"];
  return Object.values(DUCK_ANIMS).flatMap((frames) => frames.flatMap(({ pose }) => views.map((v) => duckFrame(v, pose))));
}
