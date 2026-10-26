// What floats over the workers (office plan O1.1): name tags with the rail's status
// glyph, the status icons over a head, and speech bubbles. All of it pixel art, drawn in
// the font from font.ts so it scales with the scene.

import { FONT_H, drawText, textWidth } from "./font";
import { INK, STATUS } from "./palette";
import { bitmap, draw, type Bitmap, type ColorMap } from "./pixels";

/** The rail's phases, as a name tag shows them. */
export type TagGlyph = "working" | "needs" | "done" | "idle" | "ended";

/** 5×5, in the status colour `c`: ◐ ● ○ · –. */
const TAG_GLYPHS: Record<TagGlyph, readonly string[]> = {
  working: [".ccc.", "cc..c", "cc..c", "cc..c", ".ccc."],
  needs: [".ccc.", "ccccc", "ccccc", "ccccc", ".ccc."],
  done: [".ccc.", "c...c", "c...c", "c...c", ".ccc."],
  idle: [".....", ".....", "..c..", ".....", "....."],
  ended: [".....", ".....", ".ccc.", ".....", "....."],
};

const TAG_COLOR: Record<TagGlyph, string> = {
  working: STATUS.working,
  needs: STATUS.needs,
  done: STATUS.done,
  idle: STATUS.idle,
  ended: STATUS.ended,
};

/** A rectangle `w`×`h`, outlined in `e` with its corners cut, filled with `f`. */
function box(w: number, h: number): string[] {
  return Array.from({ length: h }, (_, y) => {
    const edge = y === 0 || y === h - 1;
    return [...Array(w)]
      .map((_, x) => {
        const side = x === 0 || x === w - 1;
        if (edge && side) return ".";
        return edge || side ? "e" : "f";
      })
      .join("");
  });
}

/** A name tag: the worker's name in white on a dark pill rimmed in their shirt
 *  colour, with the status glyph in front when there is one. */
export function nameTag(name: string, rim: string, glyph: TagGlyph | null): Bitmap {
  const lead = glyph ? 5 + 2 : 0;
  const w = 1 + 2 + lead + textWidth(name) + 2 + 1;
  const h = 1 + 1 + FONT_H + 1 + 1;
  const out = bitmap(w, h);
  draw(out, { rows: box(w, h) }, { e: rim, f: STATUS.dark });
  if (glyph) draw(out, { rows: TAG_GLYPHS[glyph] }, { c: TAG_COLOR[glyph] }, 3, 2);
  drawText(out, name, 3 + lead, 2, "#ffffff");
  return out;
}

/** What a head can have over it. `needs`, `question` and `escalated` are bubbles in
 *  the plan; as icons they're the compact form, for a crowded room. */
export type Overhead = "working" | "needs" | "question" | "escalated" | "stuck" | "done";

const ICON_RING = ["..ooo..", ".occco.", "occccco", "occccco", "occccco", ".occco.", "..ooo.."];

/** The white symbol inside each icon, with its top-left. */
const ICON_MARK: Record<Overhead, readonly [number, number, readonly string[]]> = {
  working: [1, 1, ["ww...", "www..", "www..", "www..", "ww..."]],
  needs: [3, 1, ["w", "w", "w", ".", "w"]],
  question: [2, 1, ["ww.", "..w", ".w.", "...", ".w."]],
  escalated: [3, 1, ["w", "w", "w", ".", "w"]],
  stuck: [1, 3, ["w.w.w"]],
  done: [1, 2, ["....w", "w..w.", ".ww.."]],
};

const ICON_FILL: Record<Overhead, string> = {
  working: STATUS.working,
  needs: STATUS.needs,
  question: STATUS.needs,
  escalated: STATUS.alert,
  stuck: STATUS.idle,
  done: STATUS.done,
};

export const ICON_SIZE = 7;

/** A 7×7 round badge: the status colour, outlined, with a white symbol. */
export function statusIcon(kind: Overhead): Bitmap {
  const out = bitmap(ICON_SIZE, ICON_SIZE);
  draw(out, { rows: ICON_RING }, { o: INK.o, c: ICON_FILL[kind] });
  const [x, y, rows] = ICON_MARK[kind];
  draw(out, { rows, x, y }, { w: "#ffffff" });
  return out;
}

export type BubbleTone = "say" | "needs" | "alert";

const BUBBLE: Record<BubbleTone, ColorMap> = {
  say: { e: INK.o, f: STATUS.paper, t: INK.o },
  needs: { e: INK.o, f: STATUS.needs, t: "#ffffff" },
  alert: { e: INK.o, f: STATUS.alert, t: "#ffffff" },
};

/** Lines of at most `max` pixels, broken between words (a word longer than that
 *  gets a line of its own). */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Bubble text wraps at this width. */
export const BUBBLE_TEXT_W = 72;
/** The tail below the box, which points at the speaker's head. */
export const BUBBLE_TAIL = 2;

/** A speech bubble with its tail at the bottom centre: the tail's tip is at
 *  (floor(w / 2), h - 1). */
export function speechBubble(text: string, tone: BubbleTone = "say"): Bitmap {
  const lines = wrap(text, BUBBLE_TEXT_W);
  const textW = Math.max(...lines.map(textWidth));
  const w = 1 + 2 + textW + 2 + 1;
  const boxH = 1 + 2 + lines.length * (FONT_H + 1) - 1 + 2 + 1;
  const out = bitmap(w, boxH + BUBBLE_TAIL);
  const colors = BUBBLE[tone];
  const cx = Math.floor(w / 2);
  const rows = box(w, boxH);
  // Open the bottom edge where the tail leaves it.
  rows[boxH - 1] = rows[boxH - 1].slice(0, cx) + "f" + rows[boxH - 1].slice(cx + 1);
  rows.push(".".repeat(cx - 1) + "efe" + ".".repeat(w - cx - 2));
  rows.push(".".repeat(cx) + "e" + ".".repeat(w - cx - 1));
  draw(out, { rows }, colors);
  lines.forEach((line, i) => {
    const x = 3 + Math.floor((textW - textWidth(line)) / 2);
    drawText(out, line, x, 3 + i * (FONT_H + 1), colors.t);
  });
  return out;
}
