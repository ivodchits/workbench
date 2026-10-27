// Duck's office for the preview (office plan OD.4): the boss behind a big desk,
// between glass walls, in each of its animations. Waddling takes it out from behind
// the desk for a walk across the carpet.

import { DUCK_ANIMS, DUCK_H, DUCK_W, duckFrame, type DuckAnim, type DuckView } from "./art/duck";
import { PROPS, floorTile, glassSide, propFrame } from "./art/props";
import { cached, frameIn } from "./canvas";

export const DUCK_ROOM_W = 160;
export const DUCK_ROOM_H = 128;

const DESK_X = 56;
const DESK_Y = 62;
const WALK_Y = DUCK_ROOM_H - DUCK_H - 4;
const WALK_FROM = 6;
const WALK_TO = DUCK_ROOM_W - DUCK_W - 6;
const WALK_SPEED = 37;

function prop(ctx: CanvasRenderingContext2D, key: string, make: () => ReturnType<typeof propFrame>, x: number, y: number) {
  ctx.drawImage(cached(key, make), x, y);
}

function duck(ctx: CanvasRenderingContext2D, anim: DuckAnim, view: DuckView, ms: number, x: number, y: number) {
  const frames = DUCK_ANIMS[anim];
  const f = frameIn(frames.map((s) => s.ms), ms);
  ctx.drawImage(cached(`duck/${anim}/${view}/${f}`, () => duckFrame(view, frames[f].pose)), x, y);
}

export function drawDuckRoom(ctx: CanvasRenderingContext2D, ms: number, anim: DuckAnim): void {
  ctx.imageSmoothingEnabled = false;
  for (let y = 32; y < DUCK_ROOM_H; y += 16) {
    for (let x = 0; x < DUCK_ROOM_W; x += 16) {
      const alt = (x + y) / 16 % 2 === 1;
      ctx.drawImage(cached(`floor/boss/${alt}`, () => floorTile("boss", alt)), x, y);
    }
  }
  for (let x = 0; x < DUCK_ROOM_W; x += 16) prop(ctx, "prop/wall/0", () => propFrame(PROPS.wall), x, 0);
  prop(ctx, "prop/windowWall/0", () => propFrame(PROPS.windowWall), 16, 0);
  prop(ctx, "prop/windowWall/0", () => propFrame(PROPS.windowWall), 112, 0);
  prop(ctx, "prop/tallPlant/0", () => propFrame(PROPS.tallPlant), 132, 30);
  prop(ctx, "prop/bookshelf/0", () => propFrame(PROPS.bookshelf), 8, 30);

  const desk = () => prop(ctx, "prop/bossDesk/0", () => propFrame(PROPS.bossDesk), DESK_X, DESK_Y);
  if (anim === "waddle") {
    // There and back across the carpet, turning at each end.
    const span = WALK_TO - WALK_FROM;
    const travelled = ((ms / 1000) * WALK_SPEED) % (span * 2);
    const right = travelled < span;
    const x = WALK_FROM + (right ? travelled : span * 2 - travelled);
    desk();
    duck(ctx, "waddle", right ? "right" : "left", ms, Math.round(x), WALK_Y);
  } else {
    duck(ctx, anim, "down", ms, DESK_X, DESK_Y - 30);
    desk();
  }
  const side = glassSide(6);
  prop(ctx, "prop/glassSide6/0", () => propFrame(side), 0, 32);
  prop(ctx, "prop/glassSide6/0", () => propFrame(side), DUCK_ROOM_W - 4, 32);
}
