// What a game in the overlay is (office plan O5.1), and the pad test, one of the TV
// console's cartridges (O5.3a): a dot steered round a field, with lamps for the
// buttons held and the controller in use, to try the input.

import { textBitmap } from "../art/font";
import { cached } from "../canvas";
import type { Pad } from "./pad";

export interface Game {
  /** The picture's size in game pixels; the overlay scales it up by whole pixels. It
   *  may change (the console takes a cartridge's size), and the overlay follows. */
  readonly w: number;
  readonly h: number;
  /** What to press now, when it isn't the def's (the console's cartridge's). */
  readonly help?: string;
  /** The score so far, for the best the console keeps. */
  readonly score?: number;
  /** One fixed step (`STEP_MS`) with the pad as it is now. */
  step(pad: Pad): void;
  draw(ctx: CanvasRenderingContext2D): void;
  /** Esc or Back was pressed: true when the game took it (the console goes back to its
   *  menu); otherwise the overlay closes. */
  back?(): boolean;
  /** Lets go of whatever it holds; the overlay is closing. */
  stop?(): void;
}

export interface GameDef {
  title: string;
  /** What to press, under the picture. */
  help: string;
  make(): Game;
}

/** Milliseconds per game step: 60 a second. */
export const STEP_MS = 1000 / 60;

export interface TestState {
  x: number;
  y: number;
  /** Where the dot has been, oldest first. */
  trail: { x: number; y: number }[];
  pad: Pad | null;
}

export const TEST_W = 160;
export const TEST_H = 120;
/** The field inside the frame, and how far the dot goes a step at full push. */
const FIELD = { x: 4, y: 14, w: TEST_W - 8, h: TEST_H - 30 };
const SPEED = 1.2;
const TRAIL = 40;

export const testState = (): TestState => ({ x: FIELD.x + FIELD.w / 2, y: FIELD.y + FIELD.h / 2, trail: [], pad: null });

/** Moves the dot by the pad, inside the field. */
export function stepTest(s: TestState, pad: Pad): void {
  const fast = pad.b ? 2 : 1;
  s.x = Math.max(FIELD.x, Math.min(FIELD.x + FIELD.w - 1, s.x + pad.x * SPEED * fast));
  s.y = Math.max(FIELD.y, Math.min(FIELD.y + FIELD.h - 1, s.y + pad.y * SPEED * fast));
  const last = s.trail[s.trail.length - 1];
  if (!last || Math.round(last.x) !== Math.round(s.x) || Math.round(last.y) !== Math.round(s.y)) s.trail.push({ x: s.x, y: s.y });
  if (s.trail.length > TRAIL) s.trail.splice(0, s.trail.length - TRAIL);
  s.pad = pad;
}

const text = (s: string, color: string) => cached(`game-text/${color}/${s}`, () => textBitmap(s, color));

/** The test game, called `title`, its dot in `color`. */
export function testGame(title: string, color: string): GameDef {
  return {
    title,
    help: "arrows or WASD, or a gamepad: steer · Z or A: light · X or B: faster · Esc or Back: close",
    make() {
      const s = testState();
      return {
        w: TEST_W,
        h: TEST_H,
        step: (pad) => stepTest(s, pad),
        draw(ctx) {
          ctx.fillStyle = "#15131b";
          ctx.fillRect(0, 0, TEST_W, TEST_H);
          ctx.drawImage(text(title.toUpperCase(), "#ebe6f3"), 4, 4);
          ctx.strokeStyle = "#342e42";
          ctx.strokeRect(FIELD.x - 0.5, FIELD.y - 0.5, FIELD.w + 1, FIELD.h + 1);
          s.trail.forEach((p, n) => {
            ctx.globalAlpha = (n + 1) / (s.trail.length + 1) / 2;
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
          });
          ctx.globalAlpha = 1;
          const lit = s.pad?.a;
          ctx.fillStyle = lit ? "#ffffff" : color;
          const r = lit ? 2 : 1;
          ctx.fillRect(Math.round(s.x) - r, Math.round(s.y) - r, 2 * r + 1, 2 * r + 1);
          // A lamp for each button, and which controller.
          const y = TEST_H - 12;
          let x = 4;
          for (const [name, on] of [
            ["A", s.pad?.a],
            ["B", s.pad?.b],
            ["START", s.pad?.start],
          ] as const) {
            const label = text(name, on ? "#15131b" : "#a39bb4");
            ctx.fillStyle = on ? "#ffcf3f" : "#1f1c28";
            ctx.fillRect(x, y, label.width + 4, 9);
            ctx.drawImage(label, x + 2, y + 2);
            x += label.width + 7;
          }
          const by = s.pad?.gamepad ? "GAMEPAD" : "KEYBOARD";
          const who = text(by, "#6b6380");
          ctx.drawImage(who, TEST_W - 4 - who.width, y + 2);
        },
      };
    },
  };
}
