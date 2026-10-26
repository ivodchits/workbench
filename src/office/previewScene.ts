// A sample corner of the office for the preview (office plan OD.3): the Demiurge
// room, the lounge and the kitchen, with a few workers busy in them. Hand-placed —
// the real floor plan is OD.5 — and here to judge whether the cast and the furniture
// belong to the same world.

import { ANIMS, FRAME_H, frame, type Anim, type Dir } from "./art/characters";
import {
  PROPS,
  clockAt,
  floorTile,
  partition,
  partitionSide,
  propFrame,
  type FloorKind,
  type Prop,
  type PropName,
} from "./art/props";
import { cached, frameIn } from "./previewCanvas";
import { ROSTER } from "./roster";

export const SCENE_W = 384;
export const SCENE_H = 208;

const WALL_H = 32;

interface Thing {
  /** Draw order: the bottom edge on the floor. */
  base: number;
  draw: (ctx: CanvasRenderingContext2D, ms: number) => void;
}

/** A prop from the catalogue by name, or a one-off `[id, prop]` (a long partition). */
function propThing(
  name: PropName | [string, Prop],
  x: number,
  y: number,
  colors?: Record<string, string>,
  base?: number,
): Thing {
  const [id, p] = typeof name === "string" ? [name, PROPS[name] as Prop] : name;
  const durations = p.frames.map(() => p.ms ?? 1000);
  const key = colors ? `${id}:${JSON.stringify(colors)}` : id;
  return {
    base: base ?? y + p.h,
    draw: (ctx, ms) => {
      const f = frameIn(durations, ms + x * 37);
      ctx.drawImage(cached(`prop/${key}/${f}`, () => propFrame(p, f, colors)), x, y);
    },
  };
}

function worker(id: string, anim: Anim, dir: Dir, x: number, y: number, base?: number): Thing {
  const w = ROSTER.find((r) => r.id === id)!;
  const durations = ANIMS[anim].frames.map((f) => f.ms);
  return {
    base: base ?? y + FRAME_H,
    draw: (ctx, ms) => {
      const f = frameIn(durations, ms + x * 53);
      const img = cached(`worker/${id}/${anim}/${dir}/${f}`, () => frame(w.look, anim, dir, f));
      if (anim !== "type") {
        ctx.fillStyle = "rgba(30, 24, 40, 0.25)";
        ctx.beginPath();
        ctx.ellipse(x + 8, y + FRAME_H - 1, 6, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.drawImage(img, x, y);
    },
  };
}

/** A desk with its chair and monitor, and optionally someone typing at it. People sit
 *  with their backs to the camera, so you read their screen over their shoulder. */
function workstation(x: number, y: number, monitor: PropName, who?: string): Thing[] {
  const things: Thing[] = [
  propThing("desk", x, y),
  propThing(monitor, x + 9, y - 11, undefined, y + 21),
  propThing("chair", x + 8, y + 15, undefined, y + 26),
];
if (who) things.push(worker(who, "type", "up", x + 8, y - 4, y + 22));
return things;
}

/** The wall clock, showing the time now. */
function clockThing(x: number, y: number): Thing {
return {
  base: 1,
  draw: (ctx) => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    ctx.drawImage(cached(`clock/${h}:${m}`, () => propFrame(clockAt(h, m))), x, y);
  },
};
}

const LOUNGE_X = 180;
const KITCHEN_Y = 132;

function floorAt(x: number, y: number): FloorKind {
if (x < LOUNGE_X - 4) return "demiurge";
return y < KITCHEN_Y ? "wood" : "kitchen";
}

const things: Thing[] = [
  // Back wall decorations stand on the wall, so they sort first.
  ...[16, 96, 320].map((x) => propThing("windowWall", x, 0, undefined, 0)),
  propThing("door", 192, 0, undefined, 0),
  propThing("whiteboard", 56, 6, undefined, 1),
  clockThing(152, 8),

  // Demiurge.
  propThing("tallPlant", 2, 12),
  propThing("bookshelf", 136, 12),
  propThing("cabinet", 120, 20),
  ...workstation(16, 72, "monitorCode", "bram"),
  ...workstation(96, 72, "monitorCode", "kenji"),
  ...workstation(16, 140, "monitorOff"),
  ...workstation(96, 140, "monitorAlert"),
  worker("felix", "wave", "down", 128, 128),
  propThing("plant", 150, 176),
  propThing(["partitionSide10", partitionSide(10)], LOUNGE_X - 6, 36, undefined, 0),

  // Lounge.
  propThing("tvOn", 250, 14),
  worker("theo", "idle", "up", 252, 66, 82),
  worker("oksana", "idle", "up", 272, 66, 82),
  propThing("sofa", 238, 76),
  propThing("beanbagRed", 196, 92),
  propThing("beanbag", 326, 88),
  propThing("plant", 362, 34),
  propThing(["partition5", partition(5)], LOUNGE_X, KITCHEN_Y - 12, { "4": "#f4c06a", "5": "#e98a46", "6": "#c4662a" }),

  // Kitchen.
  propThing("counter", 296, 146),
  propThing("sink", 312, 146),
  propThing("counter", 328, 146),
  propThing("coffeeMachine", 299, 138, undefined, 147),
  propThing("fridge", 348, 134),
  propThing("waterCooler", 268, 146),
  propThing("kicker", 200, 176),
  worker("pip", "idle", "right", 184, 170),
  worker("juno", "idle", "left", 240, 170),
  worker("mira", "idle", "right", 300, 176),
  worker("lola", "idle", "left", 320, 176),
];
things.sort((a, b) => a.base - b.base);

export function drawScene(ctx: CanvasRenderingContext2D, ms: number): void {
  ctx.imageSmoothingEnabled = false;
  for (let ty = WALL_H; ty < SCENE_H; ty += 16) {
    for (let tx = 0; tx < SCENE_W; tx += 16) {
      const kind = floorAt(tx, ty);
      const alt = (tx + ty) / 16 % 2 === 1;
      ctx.drawImage(cached(`floor/${kind}/${alt}`, () => floorTile(kind, alt)), tx, ty);
    }
  }
  for (let tx = 0; tx < SCENE_W; tx += 16) ctx.drawImage(cached("prop/wall/0", () => propFrame(PROPS.wall)), tx, 0);
  for (const thing of things) thing.draw(ctx, ms);
}
