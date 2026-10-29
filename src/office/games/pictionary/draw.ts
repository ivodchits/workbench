// Whiteboard Pictionary's picture (office plan O5.4): the whiteboard in its frame, Duck
// beside it with the round's guesses under it, what Duck says, and a row of buttons
// (the markers, undo, clear, give up) or the line you type your guess on. The board's
// strokes are painted onto their own canvas, again only when they change; that canvas
// is what the office's whiteboard shows.

import { textBitmap, textWidth } from "../../art/font";
import { DUCK_ANIMS, duckFrame, type DuckAnim } from "../../art/duck";
import { cached, frameIn } from "../../canvas";
import { STEP_MS } from "../game";
import { BOARD_H, BOARD_W, INK, PAPER, paintStrokes } from "./board";
import {
  BOARD_X,
  BOARD_Y,
  BAR_Y,
  blanks,
  buttons,
  MENU_CHOICES,
  PIC_H,
  PIC_W,
  ROUND_STEPS,
  SAYS_STEPS,
  type PictState,
} from "./pictionary";

const ROOM = "#2b2735";
const FRAME = "#a7adb6";
const LIGHT = "#ebe6f3";
const MUTED = "#a39bb4";
const SAYS = "#ffe08a";
const BUTTON = "#3a3446";
const GOOD = "#5fd38a";
const BAD = "#ff7a7a";
const COLUMN_X = BOARD_X + BOARD_W + 4;
const COLUMN_W = PIC_W - COLUMN_X - 4;
/** Guesses listed under Duck, the latest. */
const LISTED = 9;

const text = (s: string, color: string) => cached(`pict/${color}/${s}`, () => textBitmap(s, color));

/** `s` cut to `w` pixels, with "…" when it's cut. */
export function fitText(s: string, w: number): string {
  if (textWidth(s) <= w) return s;
  let out = s;
  while (out && textWidth(`${out}…`) > w) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function write(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string): number {
  if (!s) return x;
  ctx.drawImage(text(s, color), x, y);
  return x + textWidth(s);
}

const centred = (ctx: CanvasRenderingContext2D, s: string, y: number, color: string) =>
  write(ctx, s, BOARD_X + Math.round((BOARD_W - textWidth(s)) / 2), y, color);

/** Which board each canvas last showed. */
const painted = new WeakMap<HTMLCanvasElement, string>();

function paintBoard(board: HTMLCanvasElement, s: PictState): void {
  const key = `${s.round}:${s.ink}:${s.strokes.length}`;
  if (painted.get(board) === key) return;
  painted.set(board, key);
  const g = board.getContext("2d")!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, BOARD_W, BOARD_H);
  paintStrokes(g, s.strokes);
}

function duckAnim(s: PictState): DuckAnim {
  if (s.phase === "picking" || (s.phase === "you" && s.asking)) return "think";
  if (s.clock - s.saidAt < SAYS_STEPS) return "speak";
  if (s.phase === "duck" && s.pen && s.pen.i < s.pen.strokes.length) return "waddle";
  return "idle";
}

function drawDuck(ctx: CanvasRenderingContext2D, s: PictState): void {
  const frames = DUCK_ANIMS[duckAnim(s)];
  const n = frameIn(
    frames.map((f) => f.ms),
    s.clock * STEP_MS,
  );
  const pose = frames[n].pose;
  const bmp = cached(`pict-duck/${JSON.stringify(pose)}`, () => duckFrame("down", pose));
  ctx.drawImage(bmp, COLUMN_X + Math.round((COLUMN_W - bmp.width) / 2), BOARD_Y - 2);
}

const clockText = (steps: number) => {
  const secs = Math.max(0, Math.ceil(steps / 60));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
};

function topBar(ctx: CanvasRenderingContext2D, s: PictState): void {
  const score = `SCORE ${s.wins}/${s.played}`;
  let right = PIC_W - 4 - textWidth(score);
  write(ctx, score, right, 3, MUTED);
  if (s.phase === "you" || s.phase === "duck") {
    const left = ROUND_STEPS - s.t;
    const clock = clockText(left);
    right -= textWidth(clock) + 8;
    write(ctx, clock, right, 3, left < 15 * 60 ? BAD : LIGHT);
  }
  const room = right - 8 - BOARD_X;
  switch (s.phase) {
    case "menu":
      write(ctx, "WHITEBOARD PICTIONARY", BOARD_X, 3, LIGHT);
      return;
    case "you":
      write(ctx, s.word.toUpperCase(), write(ctx, "DRAW: ", BOARD_X, 3, MUTED), 3, SAYS);
      return;
    case "picking":
      write(ctx, "DUCK IS PICKING A WORD...", BOARD_X, 3, MUTED);
      return;
    case "duck":
      write(ctx, fitText(blanks(s), room - 28), write(ctx, "GUESS: ", BOARD_X, 3, MUTED), 3, SAYS);
      return;
    case "over":
      if (s.word) write(ctx, s.word.toUpperCase(), write(ctx, "IT WAS: ", BOARD_X, 3, MUTED), 3, SAYS);
      return;
  }
}

function menu(ctx: CanvasRenderingContext2D, s: PictState): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_H);
  centred(ctx, "WHO DRAWS?", BOARD_Y + 30, INK.black);
  for (const b of buttons(s)) {
    const on = b.id === s.choice;
    ctx.fillStyle = on ? SAYS : "#e2ddd2";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    centred(ctx, MENU_CHOICES.find((c) => c.id === b.id)?.label ?? b.label, b.y + 5, on ? INK.black : "#5a5566");
  }
  centred(ctx, "DUCK ASKS CLAUDE A FEW TIMES A ROUND", BOARD_Y + BOARD_H - 14, "#8a8496");
}

function banner(ctx: CanvasRenderingContext2D, s: PictState): void {
  // Low on the board, so the drawing stays in sight.
  const y = BOARD_Y + BOARD_H - 34;
  ctx.fillStyle = "rgba(43, 39, 53, 0.88)";
  ctx.fillRect(BOARD_X + 16, y, BOARD_W - 32, 30);
  const head = s.won ? (s.mode === "you" ? "DUCK GOT IT!" : "YOU GOT IT!") : s.word ? "NOBODY GOT IT" : "NO ROUND";
  centred(ctx, head, y + 7, s.won ? GOOD : BAD);
  if (s.word) centred(ctx, s.word.toUpperCase(), y + 18, SAYS);
}

function guessList(ctx: CanvasRenderingContext2D, s: PictState): void {
  if (s.phase === "menu" || s.phase === "picking") return;
  let y = BOARD_Y + 50;
  write(ctx, s.mode === "you" ? "DUCK SAID" : "YOU SAID", COLUMN_X, y, MUTED);
  y += 9;
  for (const g of s.guesses.slice(-LISTED)) {
    write(ctx, fitText(g, COLUMN_W - 6), COLUMN_X + 6, y, LIGHT);
    ctx.fillStyle = BAD;
    ctx.fillRect(COLUMN_X + 1, y + 2, 3, 1);
    y += 7;
  }
}

function bottomBar(ctx: CanvasRenderingContext2D, s: PictState): void {
  const bs = buttons(s);
  if (s.phase === "menu") return;
  for (const b of bs) {
    if (!b.label) {
      // A marker: its colour, ringed when it's the one in hand.
      const color = INK[b.id as keyof typeof INK];
      if (b.id === s.marker) {
        ctx.fillStyle = SAYS;
        ctx.fillRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
      }
      ctx.fillStyle = PAPER;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = color;
      ctx.fillRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      continue;
    }
    ctx.fillStyle = BUTTON;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    write(ctx, b.label, b.x + 4, b.y + 4, LIGHT);
  }
  if (s.phase === "duck") {
    const end = (bs[0]?.x ?? PIC_W) - 4;
    ctx.fillStyle = "#1d1a25";
    ctx.fillRect(BOARD_X, BAR_Y, end - BOARD_X, 13);
    const caret = s.clock % 40 < 22 ? "_" : "";
    const typed = s.typed || caret ? `${s.typed}${caret}` : "";
    const x = write(ctx, "YOU: ", BOARD_X + 4, BAR_Y + 4, MUTED);
    write(ctx, fitText(typed, end - x - 4), x, BAR_Y + 4, LIGHT);
  }
}

export function drawPict(ctx: CanvasRenderingContext2D, s: PictState, board: HTMLCanvasElement): void {
  ctx.fillStyle = ROOM;
  ctx.fillRect(0, 0, PIC_W, PIC_H);
  topBar(ctx, s);
  ctx.fillStyle = FRAME;
  ctx.fillRect(BOARD_X - 2, BOARD_Y - 2, BOARD_W + 4, BOARD_H + 4);
  paintBoard(board, s);
  ctx.drawImage(board, BOARD_X, BOARD_Y);
  if (s.phase === "menu") menu(ctx, s);
  if (s.phase === "over") banner(ctx, s);
  drawDuck(ctx, s);
  guessList(ctx, s);
  write(ctx, fitText(s.says, PIC_W - 8), BOARD_X, BOARD_Y + BOARD_H + 5, SAYS);
  bottomBar(ctx, s);
}
