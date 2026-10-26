// The office's lettering (office plan O1.1): a 5 px tall pixel font for name tags and
// speech bubbles, so text scales with the scene like everything else instead of being
// a browser font blurred between pixels. Capitals only; lower case is drawn as upper.
// Most letters are 3 wide, M and W 5, N 4; one pixel between letters.

import { bitmap, draw, type Bitmap, type ColorMap } from "./pixels";

export const FONT_H = 5;

const G = (...rows: string[]) => rows;

/** Each glyph's rows, `o` for ink. */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: G(".o.", "o.o", "ooo", "o.o", "o.o"),
  B: G("oo.", "o.o", "oo.", "o.o", "oo."),
  C: G(".oo", "o..", "o..", "o..", ".oo"),
  D: G("oo.", "o.o", "o.o", "o.o", "oo."),
  E: G("ooo", "o..", "oo.", "o..", "ooo"),
  F: G("ooo", "o..", "oo.", "o..", "o.."),
  G: G(".oo", "o..", "o.o", "o.o", ".oo"),
  H: G("o.o", "o.o", "ooo", "o.o", "o.o"),
  I: G("ooo", ".o.", ".o.", ".o.", "ooo"),
  J: G("..o", "..o", "..o", "o.o", ".o."),
  K: G("o.o", "o.o", "oo.", "o.o", "o.o"),
  L: G("o..", "o..", "o..", "o..", "ooo"),
  M: G("o...o", "oo.oo", "o.o.o", "o...o", "o...o"),
  N: G("o..o", "oo.o", "o.oo", "o..o", "o..o"),
  O: G(".o.", "o.o", "o.o", "o.o", ".o."),
  P: G("oo.", "o.o", "oo.", "o..", "o.."),
  Q: G(".o.", "o.o", "o.o", "oo.", ".oo"),
  R: G("oo.", "o.o", "oo.", "o.o", "o.o"),
  S: G(".oo", "o..", ".o.", "..o", "oo."),
  T: G("ooo", ".o.", ".o.", ".o.", ".o."),
  U: G("o.o", "o.o", "o.o", "o.o", "ooo"),
  V: G("o.o", "o.o", "o.o", "o.o", ".o."),
  W: G("o...o", "o...o", "o.o.o", "oo.oo", "o...o"),
  X: G("o.o", "o.o", ".o.", "o.o", "o.o"),
  Y: G("o.o", "o.o", ".o.", ".o.", ".o."),
  Z: G("ooo", "..o", ".o.", "o..", "ooo"),
  "0": G("ooo", "o.o", "o.o", "o.o", "ooo"),
  "1": G(".o.", "oo.", ".o.", ".o.", "ooo"),
  "2": G("oo.", "..o", ".o.", "o..", "ooo"),
  "3": G("oo.", "..o", ".o.", "..o", "oo."),
  "4": G("o.o", "o.o", "ooo", "..o", "..o"),
  "5": G("ooo", "o..", "oo.", "..o", "oo."),
  "6": G(".oo", "o..", "ooo", "o.o", "ooo"),
  "7": G("ooo", "..o", ".o.", ".o.", ".o."),
  "8": G("ooo", "o.o", "ooo", "o.o", "ooo"),
  "9": G("ooo", "o.o", "ooo", "..o", "oo."),
  "!": G("o", "o", "o", ".", "o"),
  "?": G("oo.", "..o", ".o.", "...", ".o."),
  ".": G(".", ".", ".", ".", "o"),
  ",": G("..", "..", "..", ".o", "o."),
  "'": G("o", "o", ".", ".", "."),
  "-": G("...", "...", "ooo", "...", "..."),
  ":": G(".", "o", ".", "o", "."),
  "/": G("..o", "..o", ".o.", "o..", "o.."),
  "…": G(".....", ".....", ".....", ".....", "o.o.o"),
  " ": G("..", "..", "..", "..", ".."),
};

/** The glyph for `ch`; anything the font lacks shows as `?` rather than breaking a bubble. */
function glyph(ch: string): readonly string[] {
  return GLYPHS[ch.toUpperCase()] ?? GLYPHS["?"];
}

/** Width of `text` in pixels. */
export function textWidth(text: string): number {
  const chars = [...text];
  return chars.reduce((w, ch) => w + glyph(ch)[0].length, 0) + Math.max(0, chars.length - 1);
}

/** Paint `text` onto `out` with its top-left at (x, y), in `color`. */
export function drawText(out: Bitmap, text: string, x: number, y: number, color: string): void {
  const colors: ColorMap = { o: color };
  for (const ch of text) {
    const rows = glyph(ch);
    draw(out, { rows }, colors, x, y);
    x += rows[0].length + 1;
  }
}

/** `text` on its own, transparent around the letters. */
export function textBitmap(text: string, color: string): Bitmap {
  const out = bitmap(Math.max(1, textWidth(text)), FONT_H);
  drawText(out, text, 0, 0, color);
  return out;
}
