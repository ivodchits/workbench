// The office's furniture and surfaces (office plan OD.3), in the same text format as
// the workers. Regular furniture is built row by row with `row`/`framed`; organic
// shapes (plants, beanbags, the D&D table) come from `blob`; busy surfaces (book
// spines, the TV picture) are generated from a fixed seed.
//
// Everything is drawn in a 3/4 view: a top surface, then a front face, then legs.
// A prop's anchor is its bottom-left corner on the floor, so depth-sorting by that
// edge puts a worker behind a desk and in front of a chair.

import { bitmap, blob, draw, framed, row, seeded, type Bitmap, type ColorMap, type Part } from "./pixels";

export const PROP_COLORS: ColorMap = {
  o: "#2b1e2f", // outline
  k: "#1d1b24", // near black
  z: "#3d3c4a", // dark grey
  Z: "#5a5968",
  a: "#8e8e9e", // grey
  A: "#b9b9c6",
  w: "#f4f1ea", // white
  W: "#dcd7cc",
  d: "#c58c5c", // wood, light → dark
  D: "#9c6a42",
  q: "#6f472b",
  l: "#63b85e", // leaves
  L: "#3f8a44",
  j: "#8fd67a",
  n: "#c8653a", // terracotta
  N: "#9a4a28",
  s: "#262a3d", // screen off
  S: "#3b5fb8", // screen on
  c: "#bfefff", // code
  y: "#ffd75e",
  g: "#7ee08a",
  E: "#ffb43d", // amber
  e: "#6dfc7a", // status LED
  r: "#d94a4a",
  R: "#a83434",
  b: "#4a78d9",
  B: "#3456a8",
  t: "#2fb5b0",
  T: "#228480",
  f: "#3f9a55", // felt
  F: "#2f7a42",
  p: "#fbf7ee", // paper
  P: "#d9cfb8",
  i: "#7a62c4", // sofa
  I: "#5a479a",
  h: "#a9d8ea", // glass
  H: "#e6f6fc",
  x: "#24305c", // window sky (night)
  X: "#cfe3ff", // stars
  u: "#5b6380", // wall
  U: "#4a5170",
  v: "#2f3448", // wall cap
  V: "#3a405a", // baseboard
  Y: "#ffcf3f", // duck yellow, gold
  // Recolourable slots: light, base, dark.
  "4": "#9fb3e8",
  "5": "#6f88d0",
  "6": "#4d63a8",
};

export interface Prop {
  w: number;
  h: number;
  /** Each frame is a stack of parts; most props have one frame. */
  frames: Part[][];
  colors?: Partial<Record<string, string>>;
  /** Milliseconds per frame, for animated props. */
  ms?: number;
}

const one = (rows: string[]): Part[][] => [[{ rows }]];

function prop(rows: string[], extra: Omit<Prop, "w" | "h" | "frames"> = {}): Prop {
  return { w: rows[0].length, h: rows.length, frames: one(rows), ...extra };
}

const repeat = (n: number, line: string): string[] => Array<string>(n).fill(line);

// ── Walls ────────────────────────────────────────────────────────────────────

/** A back-wall tile: cap, face, baseboard. `face` rows are stamped over the face. */
function wallRows(w: number, face: (y: number) => string | null = () => null): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 32; y++) {
    let line: string;
    if (y < 3) line = row(w, "v");
    else if (y === 3 || y === 28 || y === 31) line = row(w, "o");
    else if (y < 6) line = row(w, "U");
    else if (y < 28) line = row(w, "u");
    else line = row(w, "V");
    rows.push(face(y) ?? line);
  }
  return rows;
}

const wall = prop(wallRows(16));

const windowWall = (() => {
  const W = 32;
  const random = seeded(7);
  const stars = new Set<string>();
  for (let i = 0; i < 9; i++) stars.add(`${5 + Math.floor(random() * 22)},${9 + Math.floor(random() * 12)}`);
  return prop(
    wallRows(W, (y) => {
      if (y === 7) return row(W, "u", [3, "o".repeat(26)]);
      if (y === 8 || y === 22) return row(W, "u", [3, "o" + "w".repeat(24) + "o"]);
      if (y > 8 && y < 22) {
        const cells = [...row(W, "u", [3, "ow" + "x".repeat(22) + "wo"])];
        if (y === 15) for (let x = 5; x < 27; x++) cells[x] = "w";
        cells[15] = cells[16] = "w";
        for (let x = 5; x < 27; x++) if (stars.has(`${x},${y}`) && cells[x] === "x") cells[x] = "X";
        // A glint across the panes.
        if (y >= 10 && y <= 13) cells[6 + (y - 10)] = cells[6 + (y - 10)] === "x" ? "H" : cells[6 + (y - 10)];
        return cells.join("");
      }
      if (y === 23) return row(W, "u", [2, "o" + "W".repeat(26) + "o"]);
      if (y === 24) return row(W, "u", [2, "o".repeat(28)]);
      return null;
    }),
  );
})();

const door = prop(
  wallRows(16, (y) => {
    if (y === 6) return row(16, "u", [2, "o".repeat(12)]);
    if (y < 6 || y > 30) return null;
    const rail = y === 9 || y === 17 || y === 19 || y === 28;
    const panel = (y > 9 && y < 17) || (y > 19 && y < 28);
    const inner = rail ? "D" + "q".repeat(8) + "D" : panel ? "Dq" + "D".repeat(6) + "qD" : "D".repeat(10);
    const knob: [number, string][] = y === 18 ? [[11, "E"]] : [];
    return row(16, y >= 28 ? "V" : "u", [2, "o" + inner + "o"], ...knob);
  }),
);

/** A whiteboard hung on the wall (drawn over a wall tile). */
const whiteboard = prop([
  row(32, "o"),
  framed(32, "a"),
  framed(32, "w", [1, "a"], [30, "a"]),
  framed(32, "w", [1, "a"], [30, "a"], [4, "bbbbbbb"], [14, "bb"]),
  framed(32, "w", [1, "a"], [30, "a"], [5, "b"], [11, "b"], [18, "rrrrrr"]),
  framed(32, "w", [1, "a"], [30, "a"], [5, "bbbbbbb"], [18, "r"], [23, "r"]),
  framed(32, "w", [1, "a"], [30, "a"], [8, "b"], [17, "rrr"], [23, "rrr"]),
  framed(32, "w", [1, "a"], [30, "a"], [8, "b"], [16, "r"], [26, "r"]),
  framed(32, "w", [1, "a"], [30, "a"], [6, "bbbbb"], [16, "rrrrrrrrrrr"]),
  framed(32, "w", [1, "a"], [30, "a"]),
  framed(32, "w", [1, "a"], [30, "a"], [4, "ggg"], [8, "gggg"], [13, "gg"]),
  framed(32, "w", [1, "a"], [30, "a"], [4, "gggggg"], [11, "ggg"]),
  framed(32, "w", [1, "a"], [30, "a"], [4, "gg"], [7, "ggggg"], [20, "TTT"]),
  framed(32, "w", [1, "a"], [30, "a"], [19, "T"], [23, "T"]),
  framed(32, "w", [1, "a"], [30, "a"], [20, "TTT"]),
  framed(32, "a"),
  row(32, "o"),
  row(32, ".", [3, "o" + "A".repeat(24) + "o"]),
  row(32, ".", [3, "o".repeat(14) + "r" + "b" + "o".repeat(10)]),
]);

/** The whiteboard on a stand, for a room without a wall to hang it on. The board's
 *  writing area is x 2–29, y 2–14, for drawing on it live. */
const whiteboardStand: Prop = {
  w: 32,
  h: 29,
  frames: [[
    { rows: whiteboard.frames[0][0].rows },
    { y: 19, rows: [...repeat(8, row(32, ".", [4, "oao"], [25, "oao"])), row(32, ".", [2, "ooooooo"], [23, "ooooooo"])] },
  ]],
};

const CLOCK_FACE = [
  "....oooo....",
  "..oowwwwoo..",
  ".owwwwAwwwo.",
  ".owwwwwwwwo.",
  "owwwwwwwwwwo",
  "oAwwwwwwwwAo",
  "owwwwwwwwwwo",
  "owwwwwwwwwwo",
  ".owwwwwwwwo.",
  ".owwwwAwwwo.",
  "..oowwwwoo..",
  "....oooo....",
];

/** The wall clock showing `hours`:`minutes` — hands are drawn, not templated, so it
 *  can show the real time. */
export function clockAt(hours: number, minutes: number): Prop {
  const cells = CLOCK_FACE.map((line) => [...line]);
  const hand = (turns: number, length: number, key: string) => {
    const angle = turns * Math.PI * 2;
    for (let t = 0; t <= length; t += 0.25) {
      const x = Math.floor(6 + Math.sin(angle) * t);
      const y = Math.floor(6 - Math.cos(angle) * t);
      if (cells[y]?.[x] === "w" || cells[y]?.[x] === "A" || cells[y]?.[x] === "z") cells[y][x] = key;
    }
  };
  hand(minutes / 60, 4.2, "z");
  hand(((hours % 12) + minutes / 60) / 12, 2.7, "k");
  cells[6][6] = "r";
  return prop(cells.map((line) => line.join("")));
}

const clock = clockAt(10, 10);

/** A low divider between areas, `tiles` long, seen from the front: top, face.
 *  Recolour 4/5/6 to the room's colour. */
export function partition(tiles: number): Prop {
  const w = tiles * 16;
  return prop([
    row(w, "o"),
    framed(w, "4"),
    framed(w, "4"),
    row(w, "o"),
    ...repeat(7, framed(w, "5")),
    framed(w, "6"),
    row(w, "o"),
  ]);
}

/** The same divider running up the screen, `tiles` long: only its top shows. */
export function partitionSide(tiles: number): Prop {
  return prop(["oooo", ...repeat(tiles * 16 - 2, "o44o"), "oooo"]);
}

/** Duck's glass wall, `tiles` long, facing the viewer. */
export function glass(tiles: number): Prop {
  const w = tiles * 16;
  return prop([
    row(w, "o"),
    framed(w, "A"),
    row(w, "o"),
    ...Array.from({ length: 15 }, (_, i) => {
      const y = i + 3;
      const cells = [...framed(w, "h")];
      for (let x = 1; x < w - 1; x++) if ((x + y) % 13 === 0 || (x + y) % 13 === 1) cells[x] = "H";
      return cells.join("");
    }),
    framed(w, "a"),
    row(w, "o"),
  ]);
}

/** Duck's glass wall running up the screen. */
export function glassSide(tiles: number): Prop {
  return prop(["oooo", ...repeat(tiles * 16 - 2, "oAho"), "oooo"]);
}

// ── Desks ────────────────────────────────────────────────────────────────────

const desk = prop([
  row(32, "o"),
  framed(32, "d", [7, "oooooooooo"]),
  framed(32, "d", [7, "oWAWAWAWAo"]),
  framed(32, "d", [7, "oooooooooo"]),
  framed(32, "d", [3, "DDDD"], [25, "oooo"]),
  framed(32, "d", [25, "orro"], [29, "o"]),
  framed(32, "d", [25, "orro"], [29, "o"]),
  framed(32, "d", [12, "DDDDD"], [25, "oooo"]),
  framed(32, "D"),
  row(32, "o"),
  framed(32, "q"),
  framed(32, "D", [1, "q"], [21, "ooooooooo"]),
  framed(32, "D", [1, "q"], [21, "o"], [24, "aaa"], [29, "o"]),
  framed(32, "D", [1, "q"], [21, "ooooooooo"]),
  framed(32, "D", [1, "q"], [21, "o"], [24, "aaa"], [29, "o"]),
  framed(32, "D", [1, "q"], [21, "ooooooooo"]),
  framed(32, "D", [1, "q"]),
  row(32, "o"),
  row(32, ".", [1, "oqo"], [28, "oqo"]),
  row(32, ".", [1, "oqo"], [28, "oqo"]),
  row(32, ".", [1, "ooo"], [28, "ooo"]),
]);

const chair = prop([
  row(16, ".", [2, "oooooooooooo"]),
  row(16, ".", [1, "obbbbbbbbbbbbo"]),
  ...repeat(6, row(16, ".", [1, "obBBBBBBBBBBBo"])),
  row(16, ".", [1, "oBBBBBBBBBBBBo"]),
  row(16, ".", [2, "oooooooooooo"]),
  row(16, ".", [7, "oo"]),
]);

type Screen = "off" | "code" | "code2" | "alert" | "alert2";

/** What a monitor shows, as marks over its 10×6 screen. */
const SCREENS: Record<Screen, { fill: string; lines: [number, string][][] }> = {
  off: { fill: "s", lines: [[[7, "z"]], [[8, "z"]], [], [], [], []] },
  code: {
    fill: "S",
    lines: [
      [[0, "cccc"], [5, "yy"]],
      [[1, "ggggg"]],
      [[1, "ccc"], [5, "cc"]],
      [[0, "yyy"]],
      [[1, "cccccc"]],
      [[0, "gg"]],
    ],
  },
  code2: {
    fill: "S",
    lines: [
      [[0, "yyy"]],
      [[1, "cc"], [4, "ggg"]],
      [[0, "cccc"]],
      [[1, "ccccc"]],
      [[0, "gg"], [3, "yyy"]],
      [[1, "cccc"]],
    ],
  },
  alert: {
    fill: "E",
    lines: [[[4, "kk"]], [[4, "kk"]], [[4, "kk"]], [[4, "kk"]], [], [[4, "kk"]]],
  },
  // The flash: red, with a white mark so the "!" still reads.
  alert2: {
    fill: "r",
    lines: [[[4, "ww"]], [[4, "ww"]], [[4, "ww"]], [[4, "ww"]], [], [[4, "ww"]]],
  },
};

function monitor(screen: Screen): Prop {
  const { fill, lines } = SCREENS[screen];
  const inner = (y: number) => row(10, fill, ...lines[y]);
  return prop([
    row(14, "o"),
    framed(14, "z"),
    ...Array.from({ length: 6 }, (_, y) => row(14, "z", [0, "o"], [2, inner(y)], [13, "o"])),
    framed(14, "z", [6, "e"]),
    row(14, "o"),
    row(14, ".", [5, "oaao"]),
    row(14, ".", [5, "oaao"]),
    row(14, ".", [3, "oaaaaaao"]),
    row(14, ".", [3, "oooooooo"]),
  ]);
}

/** Duck's desk: dark wood, gold trim, a duck on the front panel. */
const bossDesk = prop([
  row(48, "o"),
  framed(48, "D", [30, "oooooooooooo"]),
  framed(48, "D", [30, "oYkkYkYkkYYo"]),
  framed(48, "D", [6, "pppp"], [30, "oooooooooooo"]),
  framed(48, "D", [5, "pppppP"], [12, "ooo"]),
  framed(48, "D", [6, "PPPP"], [12, "oro"], [15, "o"]),
  framed(48, "D", [12, "ooo"]),
  framed(48, "q"),
  row(48, "Y"),
  row(48, "o"),
  framed(48, "q"),
  framed(48, "q", [22, "YY"]),
  framed(48, "q", [18, "Y"], [21, "YYYE"]),
  framed(48, "q", [18, "YYYYYYY"]),
  framed(48, "q", [19, "YYYYY"]),
  framed(48, "q"),
  framed(48, "q", [2, "Y".repeat(44)]),
  framed(48, "q"),
  row(48, "o"),
  row(48, ".", [2, "oqo"], [43, "oqo"]),
  row(48, ".", [2, "oqo"], [43, "oqo"]),
  row(48, ".", [2, "ooo"], [43, "ooo"]),
]);

const meetingTable = prop([
  row(64, ".", [1, "o".repeat(62)]),
  row(64, ".", [0, "o" + "d".repeat(62) + "o"]),
  framed(64, "d", [8, "oooo"], [40, "ppp"]),
  framed(64, "d", [8, "oSSo"], [24, "ppppP"], [39, "pppPp"]),
  framed(64, "d", [8, "oooo"], [24, "pPppp"], [50, "oo"]),
  framed(64, "d", [50, "oro"]),
  framed(64, "d", [14, "DDDD"], [50, "oo"]),
  framed(64, "D"),
  row(64, ".", [0, "o".repeat(64)]),
  row(64, ".", [3, "oqo"], [58, "oqo"]),
  row(64, ".", [3, "oqo"], [58, "oqo"]),
  row(64, ".", [3, "oqo"], [58, "oqo"]),
  row(64, ".", [3, "ooo"], [58, "ooo"]),
]);

// ── Storage ──────────────────────────────────────────────────────────────────

const cabinet = prop([
  row(14, "o"),
  ...repeat(3, framed(14, "A")),
  row(14, "o"),
  ...[0, 1, 2].flatMap(() => [
    framed(14, "a", [1, "Z"]),
    framed(14, "a", [1, "Z"], [4, "oooooo"]),
    framed(14, "a", [1, "Z"], [4, "owwwwo"]),
    framed(14, "a", [1, "Z"], [4, "oooooo"]),
    framed(14, "a", [1, "Z"]),
    framed(14, "a", [1, "Z"]),
    row(14, "o"),
  ]),
  row(14, ".", [1, "oo"], [11, "oo"]),
]);

const bookshelf = (() => {
  const W = 32;
  const random = seeded(42);
  const spines = "rbtyfiwRBTn";
  const shelf = (): string[] => {
    const lines = repeat(8, framed(W, "D", [2, "q".repeat(28)])).map((l) => [...l]);
    let x = 2;
    while (x < 29) {
      const width = 2 + Math.floor(random() * 2);
      if (random() < 0.12) {
        x += 2;
        continue;
      }
      const height = 5 + Math.floor(random() * 3);
      const color = spines[Math.floor(random() * spines.length)];
      for (let dx = 0; dx < width && x + dx < 30; dx++) {
        for (let y = 8 - height; y < 8; y++) lines[y][x + dx] = dx === width - 1 ? "o" : color;
        lines[8 - height][x + dx] = "o";
      }
      x += width;
    }
    return lines.map((l) => l.join(""));
  };
  return prop([
    row(W, "o"),
    framed(W, "d"),
    framed(W, "d"),
    row(W, "o"),
    ...shelf(),
    framed(W, "D"),
    row(W, "o"),
    ...shelf(),
    framed(W, "D"),
    row(W, "o"),
    ...shelf(),
    framed(W, "D"),
    row(W, "o"),
  ]);
})();

const serverRack = (() => {
  const unit = (lit: boolean, i: number): string[] => {
    const a = lit ? (i % 2 ? "e" : "E") : "z";
    const b = lit ? (i % 3 ? "z" : "e") : "e";
    return [
      framed(16, "k", [2, "zzzzzzzzzzzz"]),
      framed(16, "k", [2, "z"], [3, a], [5, b], [7, "kkkkkk"], [13, "z"]),
      framed(16, "k", [2, "zzzzzzzzzzzz"]),
      framed(16, "k"),
    ];
  };
  const build = (lit: boolean) => [
    row(16, "o"),
    framed(16, "Z"),
    framed(16, "Z"),
    row(16, "o"),
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((i) => unit(lit === (i % 2 === 0), i)),
    row(16, "o"),
    row(16, ".", [1, "oo"], [13, "oo"]),
  ];
  const a = build(true);
  const b = build(false);
  return { w: 16, h: a.length, frames: [[{ rows: a }], [{ rows: b }]], ms: 700 } satisfies Prop;
})();

const trash = prop([
  "oooooooooo",
  "oAAAAAAAAo",
  "oooooooooo",
  ".oaaaaaao.",
  ".oaZaaaao.",
  ".oaZaaaao.",
  ".oaZaaaao.",
  ".oaaaaaao.",
  "..oooooo..",
]);

// ── Plants ───────────────────────────────────────────────────────────────────

const POT = [
  row(16, ".", [3, "oooooooooo"]),
  row(16, ".", [3, "onnnnnnnno"]),
  row(16, ".", [3, "oNNNNNNNNo"]),
  row(16, ".", [4, "onnnnnno"]),
  row(16, ".", [4, "onnnnnno"]),
  row(16, ".", [4, "oNnnnnNo"]),
  row(16, ".", [5, "oNNNNo"]),
  row(16, ".", [5, "oooooo"]),
];

const plant: Prop = {
  w: 16,
  h: 25,
  frames: [[
    { rows: blob(16, 18, [[8, 11, 6.5, 6], [5, 7, 4, 4.5], [11, 6, 4, 4.5], [8, 4, 3.5, 3.5]], "jlL", 0.12) },
    { rows: POT, y: 17 },
  ]],
};

const tallPlant: Prop = {
  w: 16,
  h: 34,
  frames: [[
    { rows: blob(16, 27, [[8, 6, 4, 5], [5, 13, 4, 5], [11, 12, 4, 5], [8, 20, 5, 5.5]], "jlL", 0.12) },
    { rows: POT, y: 26 },
  ]],
};

// ── Kitchen ──────────────────────────────────────────────────────────────────

const counterTop = [
  row(16, "o"),
  ...repeat(5, framed(16, "W")),
  framed(16, "A"),
  row(16, "o"),
];
const counterFront = [
  framed(16, "w"),
  framed(16, "w", [2, "WWWWWWWWWWWW"]),
  ...repeat(3, framed(16, "w", [2, "W"], [13, "W"])),
  framed(16, "w", [2, "W"], [11, "a"], [13, "W"]),
  framed(16, "w", [2, "W"], [11, "a"], [13, "W"]),
  ...repeat(5, framed(16, "w", [2, "W"], [13, "W"])),
  framed(16, "w", [2, "WWWWWWWWWWWW"]),
  framed(16, "W"),
  row(16, "o"),
];

/** A counter section: one cabinet, so a run of them reads as a fitted kitchen. */
const counter = prop([...counterTop, ...counterFront]);

const sink = prop([
  row(16, "o"),
  framed(16, "W", [6, "ozzo"]),
  framed(16, "W", [3, "oooooooooo"]),
  framed(16, "W", [3, "oaAAAAAAao"]),
  framed(16, "W", [3, "oaaaaaaaao"]),
  framed(16, "W", [3, "oooooooooo"]),
  framed(16, "A"),
  row(16, "o"),
  ...counterFront,
]);

const coffeeMachine = prop([
  row(12, "o"),
  framed(12, "Z"),
  framed(12, "z", [2, "okko"], [8, "e"]),
  framed(12, "z", [2, "okko"], [8, "r"]),
  framed(12, "z"),
  framed(12, "z", [2, "oooooooo"]),
  framed(12, "z", [2, "o"], [3, "kkkkkk"], [9, "o"]),
  framed(12, "z", [2, "o"], [3, "kkkkkk"], [9, "o"]),
  framed(12, "z", [2, "o"], [3, "koowok"], [9, "o"]),
  framed(12, "z", [2, "o"], [3, "kowwok"], [9, "o"]),
  framed(12, "z", [2, "oooooooo"]),
  framed(12, "Z"),
  row(12, "o"),
]);

const fridge = prop([
  row(18, "o"),
  framed(18, "W"),
  framed(18, "W"),
  row(18, "o"),
  ...repeat(3, framed(18, "w", [1, "W"])),
  ...repeat(4, framed(18, "w", [1, "W"], [14, "a"])),
  ...repeat(2, framed(18, "w", [1, "W"])),
  row(18, "o"),
  ...repeat(3, framed(18, "w", [1, "W"])),
  ...repeat(6, framed(18, "w", [1, "W"], [14, "a"])),
  framed(18, "w", [1, "W"], [4, "rr"]),
  framed(18, "w", [1, "W"], [4, "rr"], [8, "y"]),
  framed(18, "w", [1, "W"], [7, "yy"]),
  ...repeat(2, framed(18, "w", [1, "W"])),
  framed(18, "w", [1, "W"], [5, "pp"]),
  framed(18, "w", [1, "W"], [5, "pP"]),
  ...repeat(5, framed(18, "w", [1, "W"])),
  framed(18, "W"),
  row(18, "o"),
]);

const waterCooler = prop([
  row(12, ".", [3, "oooooo"]),
  row(12, ".", [2, "ohHhhhho"]),
  ...repeat(5, row(12, ".", [1, "ohHhhhhhho"])),
  row(12, ".", [2, "ohhhhhho"]),
  row(12, ".", [4, "oHHo"]),
  row(12, "o"),
  framed(12, "W"),
  framed(12, "w", [1, "W"]),
  framed(12, "w", [1, "W"]),
  framed(12, "w", [1, "W"], [3, "o"], [8, "o"]),
  framed(12, "w", [1, "W"], [3, "b"], [8, "r"]),
  framed(12, "w", [1, "W"]),
  framed(12, "w", [1, "W"], [2, "oaaaaaao"]),
  framed(12, "w", [1, "W"], [2, "oooooooo"]),
  ...repeat(8, framed(12, "w", [1, "W"])),
  framed(12, "W"),
  row(12, "o"),
]);

const kitchenTable = prop([
  row(32, ".", [2, "o".repeat(28)]),
  row(32, ".", [1, "o" + "d".repeat(28) + "o"]),
  framed(32, "d", [6, "oo"], [20, "oooooo"]),
  framed(32, "d", [6, "or"], [8, "o"], [20, "oyyyyo"]),
  framed(32, "d", [6, "oo"], [20, "oyRyyo"]),
  framed(32, "d", [20, "oooooo"]),
  framed(32, "d", [11, "DDD"]),
  row(32, ".", [1, "o" + "D".repeat(28) + "o"]),
  row(32, ".", [2, "o".repeat(28)]),
  ...repeat(8, row(32, ".", [4, "oqo"], [25, "oqo"])),
  row(32, ".", [4, "ooo"], [25, "ooo"]),
]);

// ── Lounge ───────────────────────────────────────────────────────────────────

/** The sofa from behind: it faces the TV, so you see its back and armrests. */
const sofa = prop([
  row(48, ".", [0, "ooooooo"], [41, "ooooooo"]),
  row(48, ".", [0, "oiiiiio"], [41, "oiiiiio"]),
  row(48, ".", [0, "oiiiiio"], [41, "oiiiiio"]),
  row(48, "o", [0, "oiiiiio"], [41, "oiiiiio"]),
  row(48, "i", [0, "oIIIIIo"], [41, "oIIIIIo"]),
  row(48, "i", [0, "oIIIIIo"], [41, "oIIIIIo"]),
  row(48, "o"),
  ...repeat(3, framed(48, "I")),
  framed(48, "I", [12, "i"], [24, "i"], [36, "i"]),
  ...repeat(5, framed(48, "I")),
  row(48, "o"),
  row(48, ".", [3, "oqo"], [42, "oqo"]),
  row(48, ".", [3, "ooo"], [42, "ooo"]),
]);

/** A tiny platformer for the TV, two frames apart. */
function tvPicture(t: number): string[] {
  const W = 28;
  const H = 13;
  const lines: string[][] = [];
  for (let y = 0; y < H; y++) lines.push([...row(W, "S")]);
  const set = (x: number, y: number, k: string) => {
    const xx = ((x % W) + W) % W;
    if (y >= 0 && y < H) lines[y][xx] = k;
  };
  // Clouds drift, ground and bricks scroll.
  for (const [cx, cy] of [[4, 2], [18, 3]]) {
    const x0 = cx - t;
    for (let dx = 0; dx < 4; dx++) set(x0 + dx, cy, "w");
    for (let dx = 1; dx < 3; dx++) set(x0 + dx, cy - 1, "w");
  }
  for (let x = 0; x < W; x++) {
    set(x, 11, (x + t * 2) % 4 === 0 ? "F" : "f");
    set(x, 12, "q");
  }
  for (const bx of [6, 20]) for (let dx = 0; dx < 4; dx++) set(bx + dx - t * 2, 7, dx % 2 ? "N" : "n");
  set(22 - t * 2, 5, "y");
  // The hero, mid-jump on the second frame.
  const hy = t ? 7 : 8;
  set(9, hy, "r");
  set(10, hy, "r");
  set(9, hy + 1, "p");
  set(10, hy + 1, "p");
  set(9, hy + 2, "B");
  set(10, hy + 2, t ? "S" : "B");
  return lines.map((l) => l.join(""));
}

function tv(picture: string[] | null): string[] {
  const screen = (y: number) => (picture ? picture[y] : row(28, "s", ...(y === 2 ? [[20, "zz"] as [number, string]] : [])));
  return [
    row(36, ".", [2, "o".repeat(32)]),
    row(36, ".", [2, "o" + "k".repeat(30) + "o"]),
    ...Array.from({ length: 13 }, (_, y) => row(36, ".", [2, "ok" + screen(y) + "ko"])),
    row(36, ".", [2, "o" + "k".repeat(14) + "e" + "k".repeat(15) + "o"]),
    row(36, ".", [2, "o".repeat(32)]),
    row(36, ".", [15, "okkkko"]),
    row(36, "o"),
    framed(36, "d", [4, "oooooooo"], [26, "oo"]),
    framed(36, "d", [4, "owwwwweo"], [26, "ob"], [28, "o"]),
    framed(36, "D", [4, "oooooooo"], [26, "oo"]),
    row(36, "o"),
    framed(36, "D", [17, "o"]),
    framed(36, "D", [14, "a"], [17, "o"], [20, "a"]),
    framed(36, "D", [14, "a"], [17, "o"], [20, "a"]),
    framed(36, "D", [17, "o"]),
    row(36, "o"),
  ];
}

const tvOff = prop(tv(null));
const tvOn: Prop = { w: 36, h: tvOff.h, frames: [[{ rows: tv(tvPicture(0)) }], [{ rows: tv(tvPicture(1)) }]], ms: 280 };

const beanbag: Prop = {
  w: 16,
  h: 13,
  frames: [[{ rows: blob(16, 13, [[8, 8, 7, 4.6], [8, 5.5, 5, 3.6]]) }]],
};

const kicker = (() => {
  const W = 40;
  const rods: [number, string, number[]][] = [
    [7, "b", [7]],
    [11, "r", [4, 10]],
    [16, "b", [3, 7, 11]],
    [23, "r", [3, 7, 11]],
    [28, "b", [4, 10]],
    [32, "r", [7]],
  ];
  const lines: string[] = [];
  lines.push(row(W, "o"), framed(W, "D"), framed(W, "D", [2, "o".repeat(36)]));
  for (let y = 3; y <= 14; y++) {
    const goal = y >= 7 && y <= 10;
    const cells = [...framed(W, "D", [2, goal ? "k" : "o"], [3, "f".repeat(34)], [37, goal ? "k" : "o"])];
    cells[19] = cells[20] = "F";
    if (y === 3 || y === 14) for (let x = 3; x < 37; x++) cells[x] = "F";
    for (const [x, team, players] of rods) {
      cells[x] = "a";
      for (const p of players) if (y === p || y === p + 1) {
        cells[x - 1] = team;
        cells[x] = team === "r" ? "R" : "B";
      }
    }
    lines.push(cells.join(""));
  }
  lines.push(framed(W, "D", [2, "o".repeat(36)]), framed(W, "D"), row(W, "o"));
  for (let y = 0; y < 4; y++) lines.push(framed(W, "q", ...rods.map(([x]) => [x, y === 1 ? "A" : "q"] as [number, string])));
  lines.push(row(W, "o"));
  lines.push(row(W, ".", [3, "oqo"], [34, "oqo"]), row(W, ".", [3, "oqo"], [34, "oqo"]), row(W, ".", [3, "ooo"], [34, "ooo"]));
  return prop(lines);
})();

// ── The D&D corner ───────────────────────────────────────────────────────────

const dndTable: Prop = {
  w: 36,
  h: 27,
  frames: [[
    { rows: blob(36, 17, [[18, 8.5, 17, 7.6]], "DqD") },
    {
      x: 8,
      y: 3,
      rows: [
        "oooooooooooooooooo",
        "oppPpppppppppPpppo",
        "opppprrppppppppPpo",
        "oppppppprrppppppPo",
        "opPppppppppprppppo",
        "opppppppppppRRpppo",
        "oppppPpppppppRpppo",
        "oooooooooooooooooo",
      ],
    },
    { x: 4, y: 5, rows: ["ooo", "owo", "ooo"] },
    { x: 4, y: 9, rows: ["ooo", "oro", "ooo"] },
    { x: 29, y: 2, rows: [".y.", "oyo", "owo", "owo", "ooo"] },
    {
      y: 16,
      rows: [
        ...repeat(8, row(36, ".", [15, "oqqqqo"])),
        row(36, ".", [11, "o" + "q".repeat(12) + "o"]),
        row(36, ".", [11, "o".repeat(14)]),
      ],
    },
  ]],
};

// ── Floors ───────────────────────────────────────────────────────────────────

export type FloorKind = "office" | "demiurge" | "tinywizard" | "wood" | "kitchen" | "boss" | "meeting";

/** A 16×16 floor tile in keys 1/2/3, plus its colours; `alt` checkerboards. */
export interface Floor {
  rows: string[];
  colors: Record<"1" | "2" | "3", string>;
  alt?: Record<"1" | "2" | "3", string>;
}

const speckled = (seed: number, density: number): string[] => {
  const random = seeded(seed);
  return Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => {
      const v = random();
      return v < density ? "2" : v > 1 - density / 2 ? "3" : "1";
    }).join(""),
  );
};

export const FLOORS: Record<FloorKind, Floor> = {
  office: {
    rows: Array.from({ length: 16 }, (_, y) =>
      y === 15 ? row(16, "3") : row(16, "1", [15, "3"], ...(y === 4 ? [[9, "2"] as [number, string]] : [])),
    ),
    colors: { "1": "#c3c6cf", "2": "#b9bcc6", "3": "#a9acb8" },
    alt: { "1": "#b9bcc7", "2": "#c3c6cf", "3": "#a9acb8" },
  },
  demiurge: {
    rows: speckled(11, 0.1),
    colors: { "1": "#5d5590", "2": "#544c84", "3": "#6a62a0" },
  },
  tinywizard: {
    rows: speckled(23, 0.1),
    colors: { "1": "#3f7f7c", "2": "#377370", "3": "#4a8e8a" },
  },
  meeting: {
    rows: speckled(37, 0.08),
    colors: { "1": "#4b5878", "2": "#434f6d", "3": "#56648a" },
  },
  boss: {
    rows: speckled(5, 0.08),
    colors: { "1": "#8a3b45", "2": "#7c333d", "3": "#9a4650" },
  },
  wood: {
    rows: Array.from({ length: 16 }, (_, y) => {
      if (y % 4 === 3) return row(16, "3");
      const seam = (Math.floor(y / 4) * 6 + 3) % 16;
      return row(16, "1", [seam, "3"], ...(y % 4 === 1 ? [[(seam + 7) % 15, "2"] as [number, string]] : []));
    }),
    colors: { "1": "#b98a5e", "2": "#a97c52", "3": "#8f6844" },
  },
  kitchen: {
    rows: Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => ((x >> 3) + (y >> 3)) % 2 ? "2" : "1").join("")),
    colors: { "1": "#ebe4d2", "2": "#a3bcb8", "3": "#8fa9a5" },
  },
};

// ── Catalogue ────────────────────────────────────────────────────────────────

export const PROPS = {
  wall,
  windowWall,
  door,
  whiteboard,
  whiteboardStand,
  clock,
  partition: partition(2),
  partitionSide: partitionSide(2),
  glass: glass(2),
  glassSide: glassSide(2),
  desk,
  chair,
  monitorOff: monitor("off"),
  monitorCode: { ...monitor("code"), frames: [...monitor("code").frames, ...monitor("code2").frames], ms: 600 },
  monitorAlert: { ...monitor("alert"), frames: [...monitor("alert").frames, ...monitor("alert2").frames], ms: 450 },
  bossDesk,
  meetingTable,
  cabinet,
  bookshelf,
  serverRack,
  trash,
  plant,
  tallPlant,
  counter,
  sink,
  coffeeMachine,
  fridge,
  waterCooler,
  kitchenTable,
  sofa,
  tvOff,
  tvOn,
  beanbag,
  beanbagRed: { ...beanbag, colors: { "4": "#f08a8a", "5": "#d94a4a", "6": "#a83434" } },
  beanbagYellow: { ...beanbag, colors: { "4": "#ffe28a", "5": "#f4c842", "6": "#cc9e2c" } },
  kicker,
  dndTable,
} satisfies Record<string, Prop>;

export type PropName = keyof typeof PROPS;

/** Draw frame `index` of a prop, with optional colour overrides (room colours). */
export function propFrame(p: Prop, index = 0, colors: Partial<Record<string, string>> = {}): Bitmap {
  const out = bitmap(p.w, p.h);
  const map = { ...PROP_COLORS, ...p.colors, ...colors } as ColorMap;
  for (const part of p.frames[index % p.frames.length]) draw(out, part, map);
  return out;
}

/** Draw a floor tile; `alt` picks the checkerboard partner. */
export function floorTile(kind: FloorKind, alt = false): Bitmap {
  const f = FLOORS[kind];
  const out = bitmap(16, 16);
  draw(out, { rows: f.rows }, alt && f.alt ? f.alt : f.colors);
  return out;
}
