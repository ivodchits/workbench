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

const SLEEVE = "otto";
const ARM_UP_A = part(2, [".oo.", "osso", "osso", "osso", ...Array<string>(8).fill(SLEEVE)], 12);
const ARM_UP_B = part(3, [".oo.", "osso", "osso", "osso", ...Array<string>(7).fill(SLEEVE)], 12);

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

export type Anim = "idle" | "walk" | "type" | "wave";

/** One frame's pose: which legs and torso, and the extras. */
interface Pose {
  /** None when something hides them (sitting with your back to the camera). */
  legs?: Part;
  torso?: Part;
  arm?: Part;
  blink?: boolean;
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
  wave: {
    dirs: ["down"],
    frames: [
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_A }, side: standSide, ms: 260 },
      { front: { legs: LEGS_FRONT, torso: TORSO_WAVE, arm: ARM_UP_B }, side: standSide, ms: 260 },
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
  const put = (p: Part | null | undefined) => p && draw(out, p, colors, 0, HEADROOM);

  put(pose.legs);
  put(pose.torso ?? TORSO[drawn]);
  if (drawn === "down") put(TOP_TRIM[look.topStyle]);
  put(HEAD[drawn]);
  if (pose.blink) put(BLINK[drawn]);
  if (look.beard) put(BEARD[drawn]);
  put(HAIR[look.hairStyle][drawn]);
  if (look.glasses) put(GLASSES[drawn]);
  if (look.headphones) put(HEADPHONES[drawn]);
  put(pose.arm);

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
      }
    });
  }
  return out;
}
