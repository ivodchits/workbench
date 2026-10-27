// The office floor plan (office plan OD.5), as data: a tile layout for the floors and
// the back wall, the furniture placed on it, the desks, and the named spots people go
// to. `build.ts` turns this into draw lists, a walkability grid and seat/spot lookups.
//
// The canvas is 32×22 tiles of 16px. One open floor: no walls inside, only floors and
// furniture mark the areas. Along the back wall: Demiurge, the hall with the front
// door, Duck's glass office (with the standup table), and the lounge down the right
// side (TV, sofa, kicker, D&D). Below: the open space, TinyWizardRoyale under Duck's
// office, and under that the meeting room and the kitchen, as wide as the lounge.

import type { Dir } from "../art/characters";
import { glassRun, type FloorKind, type PropName } from "../art/props";

export const TILE = 16;
export const MAP_W = 32;
export const MAP_H = 22;

/** One character per tile. `W` is the back wall; the rest are floors. */
export const LAYOUT = [
  "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
  "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "dddddddddddd" + "hhh" + "bbbbbbbb" + "lllllllll",
  "ooooooooooooooo" + "tttttttt" + "lllllllll",
  "ooooooooooooooo" + "tttttttt" + "lllllllll",
  "ooooooooooooooo" + "tttttttt" + "lllllllll",
  "ooooooooooooooo" + "tttttttt" + "lllllllll",
  "ooooooooooooooo" + "tttttttt" + "lllllllll",
  "ooooooooooooooo" + "mmmmmmmm" + "kkkkkkkkk",
  "ooooooooooooooo" + "mmmmmmmm" + "kkkkkkkkk",
  "ooooooooooooooo" + "mmmmmmmm" + "kkkkkkkkk",
  "ooooooooooooooo" + "mmmmmmmm" + "kkkkkkkkk",
  "ooooooooooooooo" + "mmmmmmmm" + "kkkkkkkkk",
];

export type Room = "demiurge" | "hall" | "boss" | "tinywizard" | "kitchen" | "meeting" | "open" | "lounge";

export const ROOM_OF: Record<string, Room> = {
  d: "demiurge",
  h: "hall",
  b: "boss",
  t: "tinywizard",
  k: "kitchen",
  m: "meeting",
  o: "open",
  l: "lounge",
};

export const FLOOR_OF: Record<Room, FloorKind> = {
  demiurge: "demiurge",
  hall: "office",
  boss: "boss",
  tinywizard: "tinywizard",
  kitchen: "kitchen",
  meeting: "meeting",
  open: "office",
  lounge: "wood",
};

/** A prop from the catalogue, or a built-to-length one (dividers, glass). */
export type PropRef =
  | PropName
  | { build: "partition" | "partitionSide" | "glass" | "glassSide"; tiles: number }
  | { build: "glassRun" | "glassRunSide"; px: number };

export interface Placement {
  prop: PropRef;
  /** Top-left corner, in pixels. */
  x: number;
  y: number;
  /** Draw-order edge, when it isn't the prop's bottom (things hung on a wall). */
  base?: number;
  /** How deep the prop sits on the floor, up from its bottom, in pixels; 0 = not in the way. */
  foot?: number;
  colors?: Record<string, string>;
}

const at = (prop: PropRef, x: number, y: number, extra: Omit<Placement, "prop" | "x" | "y"> = {}): Placement => ({
  prop,
  x,
  y,
  ...extra,
});
/** Hung on the back wall: drawn just after it, never in anyone's way. */
const onWall = (prop: PropRef, x: number, y: number): Placement => at(prop, x, y, { base: 1, foot: 0 });

const BACK = 32; // where the back wall meets the floor

const ROOMS_SPLIT = 272; // where TinyWizardRoyale and the lounge end, the meeting room and the kitchen begin
const GLASS_H = glassRun(16).h;

/** Glass round the rooms on the right, with empty doorways: across, under
 *  TinyWizardRoyale and the lounge (doorways at x 328 and 464); up, between the left and
 *  the right rooms (doorways at y 216 and 304). The glass up stops at the top of the
 *  glass across and carries on below it. */
const GLASS: Placement[] = [
  ...([[240, 328], [360, 464], [496, 512]] as const).map(([x0, x1]) =>
    at({ build: "glassRun", px: x1 - x0 }, x0, ROOMS_SPLIT - GLASS_H, { foot: 6 }),
  ),
  ...([[192, 216], [232, ROOMS_SPLIT - GLASS_H + 1], [ROOMS_SPLIT, 304], [320, 352]] as const).map(([y0, y1]) =>
    at({ build: "glassRunSide", px: y1 - y0 }, 366, y0),
  ),
];

/** Everything in the office. */
export function placements(): Placement[] {
  return [...PLACEMENTS, ...GLASS];
}

const PLACEMENTS: Placement[] = [
  // Back wall.
  onWall("windowWall", 24, 0),
  onWall("whiteboard", 64, 6),
  onWall("windowWall", 112, 0),
  onWall("clock", 194, 9),
  onWall("door", 208, 0),
  onWall("windowWall", 288, 0),
  onWall("windowWall", 392, 0),

  // Demiurge: four desks (see DESKS); a bookshelf and a cabinet between it and the
  // open space, the server rack in the corner, a tall plant by the hall.
  at("tallPlant", 176, 12),
  at("bookshelf", 60, 156),
  at("cabinet", 100, 163),
  at("plant", 140, 165),
  at("serverRack", 4, 150),

  // Duck's glass office: the boss desk under the window, a bookshelf, and the standup
  // table in front of the desk, so the morning standup happens in front of the boss.
  at("bookshelf", 244, 12),
  at("tallPlant", 346, 12),
  at("bossDesk", 280, 92),
  at("meetingTable", 272, 140),
  at({ build: "glassSide", tiles: 10 }, 238, BACK),
  at({ build: "glassSide", tiles: 10 }, 366, BACK),
  at({ build: "glass", tiles: 3 }, 240, 172, { foot: 8 }),
  at({ build: "glass", tiles: 3 }, 320, 172, { foot: 8 }),

  // Lounge, the whole right side down to the kitchen: the TV on the back wall, the
  // sofa facing it, beanbags, the kicker and the D&D table.
  at("tallPlant", 372, 12),
  at("tvOn", 456, 14),
  at("tallPlant", 494, 12),
  at("sofa", 450, 76),
  at("beanbagRed", 404, 88),
  at("beanbagYellow", 420, 120),
  at("kicker", 440, 160),
  at("dndTable", 400, 206),
  at("plant", 494, 200),

  // Meeting room, under TinyWizardRoyale: a long table for pitching an idea to whoever's
  // free, and a whiteboard to draw the discussion on.
  at("whiteboardStand", 248, 272),
  at("meetingTable", 288, 306),

  // Kitchen, beside it and as wide as the lounge: a counter run along the glass.
  at("fridge", 380, 249),
  at("counter", 400, 263),
  at("coffeeMachine", 402, 255, { base: 287 }),
  at("sink", 416, 263),
  at("counter", 432, 263),
  at("counter", 448, 263),
  at("waterCooler", 468, 258),
  at("plant", 494, 261),
];

export interface DeskSpec {
  room: Room;
  /** The desk's top-left corner. */
  x: number;
  y: number;
}

const grid = (room: Room, xs: number[], ys: number[]): DeskSpec[] =>
  ys.flatMap((y) => xs.map((x) => ({ room, x, y })));

/** Every desk, in each room's seating order (home desks fill from the first). The open
 *  space has two spare desks for workers borrowed by a team whose room is full. */
export const DESKS: DeskSpec[] = [
  ...grid("demiurge", [24, 112], [60, 116]),
  ...grid("tinywizard", [256, 312], [216]),
  ...grid("open", [12, 68, 124, 180], [228, 292]),
];

export type SpotKind = "chat" | "drink" | "sit" | "play" | "meeting" | "pitch" | "dnd" | "browse" | "window" | "plant" | "stroll";

export interface SpotSpec {
  id: string;
  kind: SpotKind;
  /** Where the feet go, in pixels. */
  x: number;
  y: number;
  dir: Dir;
}

const spot = (id: string, kind: SpotKind, x: number, y: number, dir: Dir): SpotSpec => ({ id, kind, x, y, dir });

/** Places to be when not at a desk. */
export const SPOTS: SpotSpec[] = [
  // Kitchen.
  spot("fridge", "drink", 389, 298, "up"),
  spot("coffee", "drink", 408, 298, "up"),
  spot("sink", "drink", 424, 298, "up"),
  spot("cooler", "chat", 474, 298, "up"),
  spot("cooler-2", "chat", 458, 314, "right"),
  spot("cooler-3", "chat", 490, 314, "left"),
  // Lounge.
  spot("sofa-1", "sit", 462, 92, "up"),
  spot("sofa-2", "sit", 474, 92, "up"),
  spot("sofa-3", "sit", 486, 92, "up"),
  spot("beanbag-1", "sit", 412, 98, "up"),
  spot("beanbag-2", "sit", 428, 130, "up"),
  spot("window-lounge", "window", 408, 48, "up"),
  spot("kicker-w", "play", 432, 182, "right"),
  spot("kicker-e", "play", 488, 182, "left"),
  spot("dnd-w", "dnd", 390, 230, "right"),
  spot("dnd-e", "dnd", 446, 230, "left"),
  spot("dnd-n", "dnd", 418, 214, "down"),
  spot("dnd-s", "dnd", 418, 246, "up"),
  // Meeting room: round the table for a pitch.
  ...[300, 320, 340].map((x, i) => spot(`pitch-n${i + 1}`, "pitch", x, 304, "down")),
  ...[300, 320, 340].map((x, i) => spot(`pitch-s${i + 1}`, "pitch", x, 334, "up")),
  spot("pitch-w", "pitch", 278, 322, "right"),
  spot("pitch-e", "pitch", 358, 322, "left"),
  spot("pitch-board", "pitch", 264, 312, "right"),
  // Standup, in Duck's office.
  ...[284, 304, 324].map((x, i) => spot(`standup-n${i + 1}`, "meeting", x, 138, "down")),
  ...[284, 304, 324].map((x, i) => spot(`standup-s${i + 1}`, "meeting", x, 168, "up")),
  spot("standup-w", "meeting", 262, 154, "right"),
  spot("standup-e", "meeting", 346, 154, "left"),
  // Elsewhere.
  spot("board-demiurge", "browse", 80, 48, "up"),
  spot("books-demiurge", "browse", 76, 200, "up"),
  spot("books-boss", "browse", 260, 56, "up"),
  spot("rack", "browse", 12, 194, "up"),
  spot("cabinet", "browse", 107, 200, "up"),
  // For idle workers (O2.1): the windows, the plants, and places a stroll ends at.
  spot("window-demiurge", "window", 40, 46, "up"),
  spot("window-demiurge-2", "window", 128, 46, "up"),
  spot("plant-demiurge-tall", "plant", 168, 50, "right"),
  spot("plant-demiurge", "plant", 130, 186, "right"),
  spot("plant-lounge-tall", "plant", 384, 50, "up"),
  spot("plant-lounge", "plant", 484, 218, "right"),
  spot("plant-kitchen", "plant", 492, 292, "up"),
  spot("stroll-hall", "stroll", 216, 120, "down"),
  spot("stroll-open", "stroll", 120, 262, "down"),
  spot("stroll-tinywizard", "stroll", 300, 258, "down"),
  spot("stroll-lounge", "stroll", 440, 140, "down"),
];

/** Where people come in and leave. */
export const DOOR = { x: 216, y: 40 } as const;

/** Duck's spot behind the boss desk (the duck's top-left corner). */
export const DUCK_AT = { x: 280, y: 62 } as const;
