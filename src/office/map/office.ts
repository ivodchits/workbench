// The office floor plan (office plan OD.5), as data: a tile layout for the floors and
// the back wall, the furniture placed on it, the desks, and the named spots people go
// to. `build.ts` turns this into draw lists, a walkability grid and seat/spot lookups.
//
// The canvas is 32×22 tiles of 16px. One open floor: no walls inside, only floors and
// furniture mark the areas. Along the back wall: Demiurge, the hall with the front
// door, Duck's glass office (with the standup table), and the lounge down the right
// side (TV, sofa, kicker, D&D). Below: the open space, TinyWizardRoyale under Duck's
// office, and under that the kitchen and the meeting room, as wide as the lounge.

import type { Dir } from "../art/characters";
import type { FloorKind, PropName } from "../art/props";

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
  "ooooooooooooooo" + "kkkkkkkkkk" + "mmmmmmm",
  "ooooooooooooooo" + "kkkkkkkkkk" + "mmmmmmm",
  "ooooooooooooooo" + "kkkkkkkkkk" + "mmmmmmm",
  "ooooooooooooooo" + "kkkkkkkkkk" + "mmmmmmm",
  "ooooooooooooooo" + "kkkkkkkkkk" + "mmmmmmm",
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
export type PropRef = PropName | { build: "partition" | "partitionSide" | "glass" | "glassSide"; tiles: number };

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

export const PLACEMENTS: Placement[] = [
  // Back wall.
  onWall("windowWall", 24, 0),
  onWall("whiteboard", 64, 6),
  onWall("windowWall", 112, 0),
  onWall("clock", 194, 9),
  onWall("door", 208, 0),
  onWall("windowWall", 288, 0),
  onWall("windowWall", 392, 0),

  // Demiurge: four desks (see DESKS); a bookshelf and a cabinet between it and the
  // open space, a tall plant by the hall.
  at("tallPlant", 176, 12),
  at("bookshelf", 60, 156),
  at("cabinet", 100, 163),
  at("plant", 140, 165),

  // Hall: the server rack by the door.
  at("serverRack", 224, 14),

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
  at("dndTable", 400, 220),
  at("plant", 490, 230),

  // Kitchen, under TinyWizardRoyale: a counter run facing the room.
  at("fridge", 252, 268),
  at("counter", 272, 282),
  at("coffeeMachine", 274, 274, { base: 306 }),
  at("sink", 288, 282),
  at("counter", 304, 282),
  at("counter", 320, 282),
  at("waterCooler", 340, 277),

  // Meeting room, beside the kitchen: a long table for pitching an idea to whoever's free.
  at("meetingTable", 424, 300),
  at("plant", 404, 274),
  at("plant", 494, 274),
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

export type SpotKind = "chat" | "drink" | "sit" | "play" | "meeting" | "pitch" | "dnd" | "browse" | "window";

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
  spot("fridge", "drink", 261, 314, "up"),
  spot("coffee", "drink", 280, 314, "up"),
  spot("sink", "drink", 296, 314, "up"),
  spot("cooler", "chat", 346, 314, "up"),
  spot("cooler-2", "chat", 330, 330, "right"),
  spot("cooler-3", "chat", 362, 330, "left"),
  // Lounge.
  spot("sofa-1", "sit", 462, 92, "up"),
  spot("sofa-2", "sit", 474, 92, "up"),
  spot("sofa-3", "sit", 486, 92, "up"),
  spot("beanbag-1", "sit", 412, 98, "up"),
  spot("beanbag-2", "sit", 428, 130, "up"),
  spot("window-lounge", "window", 408, 48, "up"),
  spot("kicker-w", "play", 432, 182, "right"),
  spot("kicker-e", "play", 488, 182, "left"),
  spot("dnd-w", "dnd", 390, 244, "right"),
  spot("dnd-e", "dnd", 446, 244, "left"),
  spot("dnd-n", "dnd", 418, 228, "down"),
  spot("dnd-s", "dnd", 418, 260, "up"),
  // Meeting room: round the table for a pitch.
  ...[436, 456, 476].map((x, i) => spot(`pitch-n${i + 1}`, "pitch", x, 298, "down")),
  ...[436, 456, 476].map((x, i) => spot(`pitch-s${i + 1}`, "pitch", x, 328, "up")),
  spot("pitch-w", "pitch", 414, 314, "right"),
  spot("pitch-e", "pitch", 498, 314, "left"),
  // Standup, in Duck's office.
  ...[284, 304, 324].map((x, i) => spot(`standup-n${i + 1}`, "meeting", x, 138, "down")),
  ...[284, 304, 324].map((x, i) => spot(`standup-s${i + 1}`, "meeting", x, 168, "up")),
  spot("standup-w", "meeting", 262, 154, "right"),
  spot("standup-e", "meeting", 346, 154, "left"),
  // Elsewhere.
  spot("board-demiurge", "browse", 80, 48, "up"),
  spot("books-demiurge", "browse", 76, 200, "up"),
  spot("books-boss", "browse", 260, 56, "up"),
];

/** Where people come in and leave. */
export const DOOR = { x: 216, y: 40 } as const;

/** Duck's spot behind the boss desk (the duck's top-left corner). */
export const DUCK_AT = { x: 280, y: 62 } as const;
