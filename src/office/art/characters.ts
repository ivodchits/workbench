// The workers' bodies (office plan OD.2). One set of templates, layered and recoloured
// per worker: legs, torso, top trim, head, beard, hair, glasses, headphones, a raised
// arm. A frame is 16×26; the templates are written in "body rows" where the top of
// the head is row 1, and drawn `HEADROOM` rows lower so hair can rise above it.
//
// Keys: `o` outline, `e`/`w` eye and its highlight, `r` blush, `m` mouth, `c` white
// trim — fixed (palette `INK`). Per worker: `s`/`S` skin, `h`/`H` hair, `t`/`T` top,
// `p`/`P` trousers, `b` shoes, `k`/`K` headphones. Lowercase is the base, uppercase
// the shade.

import { bitmap, draw, mirrorBitmap, type Bitmap, type ColorMap, type Part } from "./pixels";
import { GEAR, INK, type Swatch } from "./palette";

export const FRAME_W = 16;
export const FRAME_H = 26;
const HEADROOM = 2;

export type Dir = "down" | "up" | "left" | "right";
/** The directions templates are drawn for; `left` is `right` mirrored. */
type DrawnDir = "down" | "up" | "right";

export type HairStyle = "short" | "long" | "bob" | "ponytail" | "curly" | "buzz";
export type TopStyle = "tee" | "collar" | "hoodie" | "stripes";

export interface Look {
  skin: Swatch;
  hair: Swatch;
  hairStyle: HairStyle;
  top: Swatch;
  topStyle: TopStyle;
  pants: Swatch;
  shoes: string;
  glasses?: boolean;
  beard?: boolean;
  /** Headphones, in this colour. */
  headphones?: Swatch;
  /** Rosy cheeks. */
  blush?: boolean;
}

const part = (y: number, rows: string[], x = 0): Part => ({ rows, x, y });

// ── Heads ────────────────────────────────────────────────────────────────────

const HEAD: Record<DrawnDir, Part> = {
  down: part(1, [
    "....oooooooo....",
    "...osssssssso...",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osswesswesso..",
    "..osseesseesso..",
    "..osrssssssrso..",
    "..ossssmmsssso..",
    "..oSssssssssSo..",
    "...oSSSSSSSSo...",
    "....oooooooo....",
  ]),
  up: part(1, [
    "....oooooooo....",
    "...osssssssso...",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..oSssssssssSo..",
    "...oSSSSSSSSo...",
    "....oooooooo....",
  ]),
  right: part(1, [
    "....oooooooo....",
    "...osssssssso...",
    "..osssssssssso..",
    "..osssssssssso..",
    "..osssssssssso..",
    "..o" + "ssssssswes" + "o..",
    "..o" + "ssssSssees" + "o..",
    "..o" + "ssssSsrsss" + "o..",
    "..o" + "ssssssssms" + "o..",
    "..oSssssssssSo..",
    "...oSSSSSSSSo...",
    "....oooooooo....",
  ]),
};

/** Closed eyes, drawn over the face for a blink. */
const BLINK: Partial<Record<DrawnDir, Part>> = {
  down: part(6, [
    "..osssssssssso..",
    "..ossoossoosso..",
  ]),
  right: part(6, [
    "..o" + "ssssssssss" + "o..",
    "..o" + "ssssSssoos" + "o..",
  ]),
};

// ── Bodies ───────────────────────────────────────────────────────────────────

const TORSO: Record<DrawnDir, Part> = {
  down: part(13, [
    "...otttttttto...",
    "..otttttttttto..",
    "..otTttttttTto..",
    "..otTttttttTto..",
    "..osTttttttTso..",
  ]),
  up: part(13, [
    "...otttttttto...",
    "..otttttttttto..",
    "..otTttttttTto..",
    "..otTttttttTto..",
    "..osTttttttTso..",
  ]),
  right: part(13, [
    "....otttttto....",
    "....otttttto....",
    "....ottTTtto....",
    "....ottTTtto....",
    "....ottsstto....",
  ]),
};

const LEGS_FRONT = part(18, [
  "...oppppppppo...",
  "...oppppppppo...",
  "...opppoopppo...",
  "...oppo..oppo...",
  "...obbo..obbo...",
  "...oooo..oooo...",
]);

const LEGS_FRONT_STEP_L = part(18, [
  "...oppppppppo...",
  "...oppppppppo...",
  "...opppoopppo...",
  "...obbo..oppo...",
  "...oooo..obbo...",
  ".........oooo...",
]);

const LEGS_FRONT_STEP_R = part(18, [
  "...oppppppppo...",
  "...oppppppppo...",
  "...opppoopppo...",
  "...oppo..obbo...",
  "...obbo..oooo...",
  "...oooo.........",
]);

const LEGS_SIDE = part(18, [
  "....oppppppo....",
  "....oppppppo....",
  ".....oppppo.....",
  ".....oppppo.....",
  ".....obbbbbo....",
  ".....ooooooo....",
]);

const LEGS_SIDE_STRIDE_A = part(18, [
  "....oppppppo....",
  "....oppppppo....",
  "....oppppppo....",
  "...oPPo.oppo....",
  "..obbo..obbbo...",
  "..oooo..ooooo...",
]);

const LEGS_SIDE_STRIDE_B = part(18, [
  "....oppppppo....",
  "....oppppppo....",
  "....oppppppo....",
  "...oppo.oPPo....",
  "..obbo..obbbo...",
  "..oooo..ooooo...",
]);

/** Seated, facing you: thighs toward the viewer, feet below. */
const LEGS_SEATED = part(18, [
  "...oppppppppo...",
  "..oppppppppppo..",
  "..oPPPPPPPPPPo..",
  "...obbo..obbo...",
  "...oooo..oooo...",
]);

const TORSO_TYPE_A = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTttttttTto..",
  "..otTttttttTto..",
  "..ottssttsstto..",
]);

const TORSO_TYPE_B = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTttttttTto..",
  "..otTssttttTto..",
  "..otTttttsstto..",
]);

/** Typing seen from behind: the hands are hidden, the elbows bob. */
const TORSO_TYPE_BACK_A = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTttttttTto..",
  ".ottTttttttTtto.",
  "..otTttttttTto..",
]);

const TORSO_TYPE_BACK_B = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTttttttTto..",
  "..otTttttttTto..",
  ".ottTttttttTtto.",
]);

/** The right arm is up, so that side of the torso has no hand. */
const TORSO_WAVE = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTtttttttto..",
  "..otTtttttttto..",
  "..osTttttttto...",
]);

/** Both hands up, so neither side of the torso has a hand. */
const TORSO_CHEER = part(13, [
  "...otttttttto...",
  "..otttttttttto..",
  "..otTttttttTto..",
  "..otTttttttTto..",
  "...otttttttto...",
]);

const SLEEVE = "otto";
const ARM_UP_A = part(2, [".oo.", "osso", "osso", "osso", ...Array<string>(8).fill(SLEEVE)], 12);
const ARM_UP_B = part(3, [".oo.", "osso", "osso", "osso", ...Array<string>(7).fill(SLEEVE)], 12);
const ARMS_UP: Part = { ...ARM_UP_A, rows: ARM_UP_A.rows.map((r) => r + "........" + r), x: 0 };

/** A hand over the face, the forearm down to the right shoulder. */
const ARM_FACEPALM = part(5, [
  ".......ossso....",
  ".......osssso...",
  ".......osssso...",
  "........osso....",
  "........otto....",
  ".........otto...",
  ".........otto...",
  "..........otto..",
  "..........otto..",
]);

// A mug of coffee: white, with coffee on top (`m`).
const MUG_HOLD: Record<"down" | "right", Part> = {
  down: part(15, ["oooo.", "ommo.", "occso", "occso", "oooo."], 11),
  right: part(15, [".oooo", ".ommo", "socco", "socco", ".oooo"], 10),
};
const MUG_SIP: Record<"down" | "right", Part> = {
  down: part(8, [
    "oooo....",
    "ommo....",
    "occsoo..",
    "occssto.",
    "oooootto",
    "....otto",
  ], 6),
  right: part(7, [
    "...oooo",
    "...ommo",
    "...occo",
    "..ossco",
    ".ottooo",
    ".otto..",
    ".otto..",
  ], 9),
};

// Work seen from behind (office plan O1.4). A newspaper held up hides the face; from
// behind its top shows over the bowed head and its edges either side, the hands on them. `n` is the
// paper, `N` the print.
const NEWSPAPER = (print: readonly string[]): Part =>
  part(-2, ["oooooooooooooooo", ...print.map((p) => `o${p}o`), "oooooooooooooooo"]);
const NEWSPAPER_A = NEWSPAPER([
  "nNNNNNnnNNNNNn",
  "nnnnnnnnnnnnnn",
  "nNNnnnnnnnnNNn",
  "nNNnnnnnnnnNNn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
  "nnnnnnnnnnnnnn",
  "nNNnnnnnnnnNNn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
  "nNNnnnnnnnnNNn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
]);
const NEWSPAPER_B = NEWSPAPER([
  "nNNNNnnNNNNNNn",
  "nnnnnnnnnnnnnn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
  "nnnnnnnnnnnnnn",
  "nNNnnnnnnnnNNn",
  "nNNnnnnnnnnNNn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
  "nnnnnnnnnnnnnn",
  "nNNnnnnnnnnNNn",
  "nnnnnnnnnnnnnn",
  "NNnnnnnnnnnnNN",
]);
const PAPER_HANDS_A = part(8, [".so..........os.", ".so..........os."]);
const PAPER_HANDS_B = part(9, [".so..........os.", ".so..........os."]);
/** A sheet held up off to one side, lower than a newspaper: white, fine print. */
const DOCUMENT = part(5, [
  "...........ooooo",
  "...........occco",
  "...........oNcco",
  "...........occco",
  "...........oNNco",
  "...........occco",
  "...........oNcco",
  "...........occco",
  "...........ooooo",
], 0);
const DOCUMENT_HAND = part(10, ["............oso."]);

/** A hand up at the whiteboard, from behind: the marker moves across. */
const ARM_BOARD_A = ARM_UP_A;
const ARM_BOARD_B: Part = { ...ARM_UP_B, x: 11 };
const ARM_BOARD_C: Part = { ...ARM_UP_A, x: 11 };

/** A sheet of paper going into the cabinet, by one hand or the other. */
const FILE_SHEET_R = part(10, ["...........oooo.", "...........occo.", "...........occo.", "...........oooo."]);
const FILE_SHEET_L = part(10, [".oooo...........", ".occo...........", ".occo...........", ".oooo..........."]);

/** A drop of sweat by the head, falling. */
const SWEAT_A = part(3, [".o.", "odo", "odo", ".o."]);
const SWEAT_B = part(5, [".o.", "odo", "odo", ".o."]);

/** Leaning back with the hands behind the head, from behind: the arms frame it, the
 *  hands across the back of it. */
const HANDS_BEHIND_HEAD = part(2, [
  ".oo..........oo.",
  "otto........otto",
  "otso........osto",
  "otsossssssssosto",
  "oto.oooooooo.oto",
  "oto..........oto",
  "oto..........oto",
  "oto..........oto",
  "otto........otto",
  ".otto......otto.",
  "..oo........oo..",
]);
/** One hand still behind the head, the other bringing the mug up. */
const SIP_BEHIND_HEAD = part(2, [
  ".oo.............",
  "otto............",
  "otso............",
  "otsossssso..oooo",
  "oto.oooooo..occo",
  "oto.........occo",
  "oto........osooo",
  "oto........osso.",
  "otto......ottto.",
  ".otto.....otto..",
  "..oo......ooo...",
]);

/** Trim over the front of the top. */
const TOP_TRIM: Record<TopStyle, Part | null> = {
  tee: null,
  collar: part(13, [
    "......c..c......",
    ".......cc.......",
  ]),
  hoodie: part(13, [
    "...oTTTTTTTTo...",
    "......c..c......",
    "......c..c......",
  ]),
  stripes: part(14, [
    "...TTTTTTTTTT...",
    "................",
    "....TTTTTTTT....",
  ]),
};

// ── Hair ─────────────────────────────────────────────────────────────────────

const HAIR: Record<HairStyle, Record<DrawnDir, Part>> = {
  short: {
    down: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohHhhHhhHhho..",
      "..ohHH....HHho..",
      "..oh........ho..",
    ]),
    up: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohHhhhhhhHho..",
      "..ohhhhhhhhhho..",
      "..ohhhHhhHhhho..",
      "..ohhhhhhhhhho..",
      "..oHhhhhhhhhHo..",
      "..oHHHHHHHHHHo..",
    ]),
    right: part(0, [
      "....oooooo......",
      "...ohhhhhhoo....",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhHHo..",
      "..ohhhhhhH......",
      "..ohhhhH........",
      "..ohhhH.........",
      "..oHhH..........",
      "...oo...........",
    ]),
  },
  long: {
    down: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohHhhHhhHhho..",
      ".ohhHH....HHhho.",
      ".ohh........hho.",
      ".ohh........hho.",
      ".ohH........Hho.",
      ".ohh........hho.",
      ".ohh........hho.",
      ".ohH........Hho.",
      ".ohho......ohho.",
      ".oHHo......oHHo.",
      "..oo........oo..",
    ]),
    up: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      ".ohhhhhhhhhhhho.",
      ".ohhHhhhhhhHhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhhhHhhHhhhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhHhhhhhhHhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhhHhhhhHhhho.",
      ".ohhhhhhhhhhhho.",
      ".oHhhhhhhhhhhHo.",
      "..oooooooooooo..",
    ]),
    right: part(0, [
      "....oooooo......",
      "...ohhhhhhoo....",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhHHo..",
      ".ohhhhhhhH......",
      ".ohhhhhH........",
      ".ohhhhH.........",
      ".ohhhhH.........",
      ".ohHhhH.........",
      ".ohhhhH.........",
      ".ohhhhH.........",
      ".ohhhho.........",
      ".oHHHo..........",
      "..ooo...........",
    ]),
  },
  bob: {
    down: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohhHhhhhHhho..",
      ".ohHhhHhhHhhHho.",
      ".ohh........hho.",
      ".ohh........hho.",
      ".ohH........Hho.",
      ".ohh........hho.",
      ".ohhH......Hhho.",
      "..ooo......ooo..",
    ]),
    up: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      ".ohhHhhhhhhHhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhhhHhhHhhhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhhhhhhhhhhho.",
      ".ohhHhhhhhhHhho.",
      ".oHhhhhhhhhhhHo.",
      "..oooooooooooo..",
    ]),
    right: part(0, [
      "....oooooo......",
      "...ohhhhhhoo....",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhHHo..",
      ".ohhhhhhhhhhh...",
      ".ohhhhhH........",
      ".ohhhhhH........",
      ".ohhhhhH........",
      ".ohHhhhH........",
      ".oHhhhho........",
      "..ooooo.........",
    ]),
  },
  ponytail: {
    down: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohhhhhHhhhho..",
      "..ohhhhH...Hho..",
      "..oh........ho..",
    ]),
    up: part(0, [
      ".....oooooo.....",
      "...oohhhhhhoo...",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      "..ohHhhhhhhHho..",
      "..ohhhhhhhhhho..",
      "..ohhhHhhHhhho..",
      "..ohhhhHHhhhho..",
      "..oHhhhhhhhhHo..",
      "..oHHHHccHHHHo..",
      "......ohho......",
      "......ohho......",
      "......ohHo......",
      "......oHHo......",
      ".......oo.......",
    ]),
    right: part(0, [
      "....oooooo......",
      "...ohhhhhhoo....",
      "..ohhhhhhhhhho..",
      "..ohhhhhhhhhho..",
      ".occhhhhhhhHHo..",
      "ohhhhhhhhH......",
      "ohhohhhH........",
      "ohHohhH.........",
      "oHooHhH.........",
      ".o.oo...........",
    ]),
  },
  curly: {
    down: part(-2, [
      "....oooooooo....",
      "..oohhhhhhhhoo..",
      ".ohhhHhhhhHhhho.",
      "ohhHhhhhhhhhHhho",
      "ohhhhhHhhHhhhhho",
      "ohHhhhhhhhhhhHho",
      "ohhhHhhhhhhHhhho",
      "ohhHH......HHhho",
      "ohhh........hhho",
      ".ohh........hho.",
      ".oHh........hHo.",
      "..oo........oo..",
    ]),
    up: part(-2, [
      "....oooooooo....",
      "..oohhhhhhhhoo..",
      ".ohhhHhhhhHhhho.",
      "ohhHhhhhhhhhHhho",
      "ohhhhhHhhHhhhhho",
      "ohHhhhhhhhhhhHho",
      "ohhhHhhhhhhHhhho",
      "ohhhhhhHhhhhhhho",
      "ohhHhhhhhhhhHhho",
      ".ohhhhHhhHhhhho.",
      ".oHhhhhhhhhhhHo.",
      "..oooooooooooo..",
    ]),
    right: part(-2, [
      "....oooooooo....",
      "..oohhhhhhhhoo..",
      ".ohhhHhhhhHhhho.",
      "ohhHhhhhhhhhHhho",
      "ohhhhhHhhHhhhhho",
      "ohHhhhhhhhhhhHho",
      "ohhhHhhhhhhHhhho",
      "ohhhhhhhH.......",
      "ohhhhhhH........",
      "ohhHhhhH........",
      ".oHhhhH.........",
      "..ooooo.........",
    ]),
  },
  buzz: {
    down: part(1, [
      "....oooooooo....",
      "...ohhhhhhhho...",
      "..ohHhHhhHhHho..",
      "..oh........ho..",
    ]),
    up: part(1, [
      "....oooooooo....",
      "...ohhhhhhhho...",
      "..ohHhhhhhhHho..",
      "..ohhhHhhHhhho..",
      "..ohHhhhhhhHho..",
      "..ohhhhhhhhhho..",
      "..oHhHhhHhHhHo..",
    ]),
    right: part(1, [
      "....oooooooo....",
      "...ohhhhhhhho...",
      "..ohhhhhhhhHHo..",
      "..ohhhhH........",
      "..ohhhH.........",
      "..oHhH..........",
      "..oHH...........",
    ]),
  },
};

// ── Accessories ──────────────────────────────────────────────────────────────

const GLASSES: Partial<Record<DrawnDir, Part>> = {
  // Lenses over the top row of the eyes, rims down the sides: a frame round both
  // eye rows reads as a visor at this size.
  down: part(6, [
    "....oggooggo....",
    "....o......o....",
  ]),
  right: part(6, [
    ".......oooggo...",
    ".........o..o...",
  ]),
};

const BEARD: Partial<Record<DrawnDir, Part>> = {
  down: part(9, [
    ".....hh..hh.....",
    "..ohhhhhhhhhho..",
    "...ohhhhhhhho...",
    "....oooooooo....",
  ]),
  right: part(9, [
    ".........hhh....",
    ".......hhhhhho..",
    "........ohhhho..",
    "....oooooooo....",
  ]),
};

const HEADPHONES: Record<DrawnDir, Part> = {
  down: part(-1, [
    "....oooooooo....",
    "...okkkkkkkko...",
    "..ok........ko..",
    ".ok..........ko.",
    ".ok..........ko.",
    ".ok..........ko.",
    "okko........okko",
    "oKko........okKo",
    "oKko........okKo",
    ".oo..........oo.",
  ]),
  up: part(-1, [
    "....oooooooo....",
    "...okkkkkkkko...",
    "..ok........ko..",
    ".ok..........ko.",
    ".ok..........ko.",
    ".ok..........ko.",
    "okko........okko",
    "oKko........okKo",
    "oKko........okKo",
    ".oo..........oo.",
  ]),
  right: part(-1, [
    "......ooo.......",
    ".....okko.......",
    ".....oko........",
    ".....oko........",
    ".....oko........",
    ".....oko........",
    "....okkko.......",
    "....oKkKo.......",
    "....oKkKo.......",
    ".....ooo........",
  ]),
};

// ── Animations ───────────────────────────────────────────────────────────────

export type Anim =
  | "idle"
  | "walk"
  | "type"
  | "typeFast"
  | "wave"
  | "fret"
  | "drink"
  | "sleep"
  | "cheer"
  | "facepalm"
  | "newspaper"
  | "document"
  | "board"
  | "tinker"
  | "file"
  | "relax"
  | "coffee";

/** One frame's pose: which legs and torso, and the extras. */
interface Pose {
  /** None when something hides them (sitting with your back to the camera). */
  legs?: Part;
  torso?: Part;
  arm?: Part;
  /** Something held, drawn last (a mug). */
  held?: Part;
  /** Something in front of them that the body hides, drawn first (a newspaper, seen
   *  from behind). */
  behind?: Part;
  blink?: boolean;
  /** Whole-body nudge (a hop), and the head's own on top (a nod, a slump). */
  dy?: number;
  headDy?: number;
  /** The arm moves with the head (a hand on the face). */
  armWithHead?: boolean;
}

interface AnimDef {
  /** Directions it has; others fall back to `down`. */
  dirs: readonly Dir[];
  /** Per frame: the pose for the front view, the side view, and the back view when
   *  it differs from the front. */
  frames: readonly { front: Pose; side: Pose; back?: Pose; ms: number }[];
}

const stand: Pose = { legs: LEGS_FRONT };
const standSide: Pose = { legs: LEGS_SIDE };

export const ANIMS: Record<Anim, AnimDef> = {
  idle: {
    dirs: ["down", "up", "left", "right"],
    frames: [
      { front: stand, side: standSide, ms: 2400 },
      { front: { ...stand, blink: true }, side: { ...standSide, blink: true }, ms: 140 },
      { front: stand, side: standSide, ms: 1600 },
      { front: { ...stand, blink: true }, side: { ...standSide, blink: true }, ms: 140 },
    ],
  },
  walk: {
    dirs: ["down", "up", "left", "right"],
    frames: [
      { front: { legs: LEGS_FRONT_STEP_L }, side: { legs: LEGS_SIDE_STRIDE_A }, ms: 160 },
      { front: stand, side: standSide, ms: 160 },
      { front: { legs: LEGS_FRONT_STEP_R }, side: { legs: LEGS_SIDE_STRIDE_B }, ms: 160 },
      { front: stand, side: standSide, ms: 160 },
    ],
  },
  type: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED, torso: TORSO_TYPE_A }, back: { torso: TORSO_TYPE_BACK_A }, side: standSide, ms: 170 },
      { front: { legs: LEGS_SEATED, torso: TORSO_TYPE_B }, back: { torso: TORSO_TYPE_BACK_B }, side: standSide, ms: 170 },
      { front: { legs: LEGS_SEATED, torso: TORSO_TYPE_A }, back: { torso: TORSO_TYPE_BACK_A }, side: standSide, ms: 170 },
      {
        front: { legs: LEGS_SEATED, torso: TORSO_TYPE_B, blink: true },
        back: { torso: TORSO_TYPE_BACK_B },
        side: standSide,
        ms: 140,
      },
    ],
  },
  /** Typing with subagents out: the same, twice as fast. */
  typeFast: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED, torso: TORSO_TYPE_A }, back: { torso: TORSO_TYPE_BACK_A }, side: standSide, ms: 85 },
      { front: { legs: LEGS_SEATED, torso: TORSO_TYPE_B }, back: { torso: TORSO_TYPE_BACK_B }, side: standSide, ms: 85 },
    ],
  },
  wave: {
    dirs: ["down"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_A }, side: standSide, ms: 260 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_B }, side: standSide, ms: 260 },
    ],
  },
  /** Waving harder, sweating: you've kept them waiting. */
  fret: {
    dirs: ["down"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_A, held: SWEAT_A }, side: standSide, ms: 180 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_B, held: SWEAT_B }, side: standSide, ms: 180 },
    ],
  },
  /** Seated with a newspaper up; now and then a page turns. */
  newspaper: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_TYPE_BACK_A, behind: NEWSPAPER_A, held: PAPER_HANDS_A, headDy: 2 }, side: standSide, ms: 2600 },
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_TYPE_BACK_A, behind: NEWSPAPER_B, held: PAPER_HANDS_B, headDy: 2 }, side: standSide, ms: 500 },
    ],
  },
  /** Seated, reading a sheet held up to one side; the head follows the lines. */
  document: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_WAVE, behind: DOCUMENT, held: DOCUMENT_HAND }, side: standSide, ms: 1800 },
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_WAVE, behind: DOCUMENT, held: DOCUMENT_HAND, headDy: 1 }, side: standSide, ms: 1200 },
    ],
  },
  /** At the whiteboard, from behind: writing across it. */
  board: {
    dirs: ["up"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_BOARD_A }, side: standSide, ms: 300 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_BOARD_B }, side: standSide, ms: 300 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_BOARD_C }, side: standSide, ms: 300 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_BOARD_B }, side: standSide, ms: 300 },
      { front: { legs: LEGS_FRONT }, side: standSide, ms: 900 },
    ],
  },
  /** At the server rack, from behind: hands busy, head down, shifting about. */
  tinker: {
    dirs: ["up"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_A, headDy: 1 }, side: standSide, ms: 240 },
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_B, headDy: 1 }, side: standSide, ms: 240 },
      { front: { legs: LEGS_FRONT_STEP_L, torso: TORSO_TYPE_BACK_A }, side: standSide, ms: 400 },
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_B, headDy: 1 }, side: standSide, ms: 240 },
    ],
  },
  /** At the filing cabinet, from behind: a sheet at a time going in. */
  file: {
    dirs: ["up"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_A, held: FILE_SHEET_R }, side: standSide, ms: 350 },
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_B, headDy: 1 }, side: standSide, ms: 250 },
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_B, held: FILE_SHEET_L }, side: standSide, ms: 350 },
      { front: { legs: LEGS_FRONT, torso: TORSO_TYPE_BACK_A, headDy: 1 }, side: standSide, ms: 250 },
    ],
  },
  /** Leaning back at the desk, hands behind the head. */
  relax: {
    dirs: ["down", "up"],
    frames: [{ front: { legs: LEGS_SEATED }, back: { torso: TORSO_CHEER, held: HANDS_BEHIND_HEAD }, side: standSide, ms: 4000 }],
  },
  /** Leaning back with a coffee: now and then a sip. */
  coffee: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_CHEER, held: HANDS_BEHIND_HEAD }, side: standSide, ms: 3200 },
      { front: { legs: LEGS_SEATED }, back: { torso: TORSO_CHEER, held: SIP_BEHIND_HEAD, headDy: -1 }, side: standSide, ms: 1400 },
    ],
  },
  /** Standing with a mug; now and then a sip. From behind, only the elbow shows. */
  drink: {
    dirs: ["down", "up", "left", "right"],
    frames: [
      {
        front: { ...stand, torso: TORSO_WAVE, held: MUG_HOLD.down },
        side: { ...standSide, held: MUG_HOLD.right },
        back: stand,
        ms: 1800,
      },
      {
        front: { ...stand, torso: TORSO_WAVE, held: MUG_SIP.down, blink: true },
        side: { ...standSide, held: MUG_SIP.right, blink: true },
        back: { ...stand, torso: TORSO_TYPE_BACK_A },
        ms: 900,
      },
      {
        front: { ...stand, torso: TORSO_WAVE, held: MUG_HOLD.down },
        side: { ...standSide, held: MUG_HOLD.right },
        back: stand,
        ms: 1400,
      },
    ],
  },
  /** Asleep: at the desk (from behind), slumped over the keyboard; on the sofa
   *  (facing you), eyes shut and nodding. The Zzz are drawn over the head. */
  sleep: {
    dirs: ["down", "up"],
    frames: [
      { front: { legs: LEGS_SEATED, blink: true, headDy: 1 }, back: { torso: TORSO_TYPE_BACK_A, headDy: 3 }, side: standSide, ms: 1500 },
      { front: { legs: LEGS_SEATED, blink: true, headDy: 2 }, back: { torso: TORSO_TYPE_BACK_A, headDy: 2 }, side: standSide, ms: 1500 },
    ],
  },
  /** Both arms up, hopping. */
  cheer: {
    dirs: ["down"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_CHEER, arm: ARMS_UP }, side: standSide, ms: 200 },
      { front: { legs: LEGS_FRONT, torso: TORSO_CHEER, arm: ARMS_UP, dy: -2 }, side: standSide, ms: 200 },
    ],
  },
  /** A hand over the face, the head sinking into it. */
  facepalm: {
    dirs: ["down"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_FACEPALM, blink: true }, side: standSide, ms: 700 },
      {
        front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_FACEPALM, blink: true, headDy: 1, armWithHead: true },
        side: standSide,
        ms: 1100,
      },
    ],
  },
};

// ── Composition ──────────────────────────────────────────────────────────────

export function colorsOf(look: Look): ColorMap {
  const gear = look.headphones ?? GEAR.slate;
  return {
    ...INK,
    r: look.blush ? INK.r : look.skin.base,
    s: look.skin.base,
    S: look.skin.shade,
    h: look.hair.base,
    H: look.hair.shade,
    t: look.top.base,
    T: look.top.shade,
    p: look.pants.base,
    P: look.pants.shade,
    b: look.shoes,
    k: gear.base,
    K: gear.shade,
  };
}

/** Draw one frame of `anim` facing `dir`. */
export function frame(look: Look, anim: Anim, dir: Dir, index: number): Bitmap {
  const def = ANIMS[anim];
  const facing = def.dirs.includes(dir) ? dir : "down";
  const drawn: DrawnDir = facing === "left" ? "right" : facing;
  const step = def.frames[index % def.frames.length];
  const pose = drawn === "right" ? step.side : drawn === "up" ? (step.back ?? step.front) : step.front;
  const colors = colorsOf(look);
  const out = bitmap(FRAME_W, FRAME_H);
  const body = HEADROOM + (pose.dy ?? 0);
  const head = body + (pose.headDy ?? 0);
  const put = (p: Part | null | undefined, dy = body) => p && draw(out, p, colors, 0, dy);

  put(pose.behind);
  put(pose.legs);
  put(pose.torso ?? TORSO[drawn]);
  if (drawn === "down") put(TOP_TRIM[look.topStyle]);
  put(HEAD[drawn], head);
  if (pose.blink) put(BLINK[drawn], head);
  if (look.beard) put(BEARD[drawn], head);
  put(HAIR[look.hairStyle][drawn], head);
  if (look.glasses) put(GLASSES[drawn], head);
  if (look.headphones) put(HEADPHONES[drawn], head);
  put(pose.arm, pose.armWithHead ? head : body);
  put(pose.held, body);

  return facing === "left" ? mirrorBitmap(out) : out;
}

/** Every template, for validation. */
export function allParts(): [string, Part][] {
  const out: [string, Part][] = [];
  const add = (label: string, p: Part | null | undefined) => p && out.push([label, p]);
  for (const [d, p] of Object.entries(HEAD)) add(`head.${d}`, p);
  for (const [d, p] of Object.entries(BLINK)) add(`blink.${d}`, p);
  for (const [d, p] of Object.entries(TORSO)) add(`torso.${d}`, p);
  for (const [s, p] of Object.entries(TOP_TRIM)) add(`top.${s}`, p);
  for (const [s, dirs] of Object.entries(HAIR)) {
    for (const [d, p] of Object.entries(dirs)) add(`hair.${s}.${d}`, p);
  }
  for (const [d, p] of Object.entries(GLASSES)) add(`glasses.${d}`, p);
  for (const [d, p] of Object.entries(BEARD)) add(`beard.${d}`, p);
  for (const [d, p] of Object.entries(HEADPHONES)) add(`headphones.${d}`, p);
  for (const [a, def] of Object.entries(ANIMS)) {
    def.frames.forEach((f, i) => {
      for (const view of ["front", "side", "back"] as const) {
        const pose = f[view];
        if (!pose) continue;
        add(`${a}.${i}.${view}.legs`, pose.legs);
        add(`${a}.${i}.${view}.torso`, pose.torso);
        add(`${a}.${i}.${view}.arm`, pose.arm);
        add(`${a}.${i}.${view}.held`, pose.held);
        add(`${a}.${i}.${view}.behind`, pose.behind);
      }
    });
  }
  return out;
}
