// Pictionary's whiteboard (office plan O5.4): strokes in marker colours, drawn as the
// office draws, in whole pixels, and the picture Duck is shown to guess from: the
// same strokes larger and smooth, on white, as a PNG.

import { DRAW_H, DRAW_W, type DuckStroke, type Marker } from "../../../remote/pictionary";

/** The board's writing area, in game pixels. */
export const BOARD_W = 180;
export const BOARD_H = 120;
/** A marker's tip, in board pixels. */
export const TIP = 2;

export const INK: Readonly<Record<Marker, string>> = {
  black: "#22202a",
  red: "#d23b3b",
  blue: "#2f62d0",
  green: "#2f9e4f",
};
export const PAPER = "#f4f1ea";

/** A stroke on the board: its marker and the points it goes through, in board pixels. */
export interface Stroke {
  color: Marker;
  points: [number, number][];
}

/** Duck's strokes, from its board's units to this one's. */
export function fromDuck(strokes: readonly DuckStroke[]): Stroke[] {
  const kx = (BOARD_W - 1) / DRAW_W;
  const ky = (BOARD_H - 1) / DRAW_H;
  return strokes.map((s) => ({ color: s.color, points: s.points.map(([x, y]) => [x * kx, y * ky] as [number, number]) }));
}

/** How far a stroke goes, in board pixels. */
export function lengthOf(points: readonly [number, number][]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return n;
}

/** The pixels a line from `a` to `b` covers, each once (Bresenham). */
export function linePixels(a: [number, number], b: [number, number]): [number, number][] {
  let [x0, y0] = [Math.round(a[0]), Math.round(a[1])];
  const [x1, y1] = [Math.round(b[0]), Math.round(b[1])];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out: [number, number][] = [];
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Paints `strokes` onto `ctx` in whole pixels, the board's top-left at (0, 0). */
export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[]): void {
  const half = Math.floor(TIP / 2);
  for (const s of strokes) {
    ctx.fillStyle = INK[s.color];
    const pts = s.points.length === 1 ? [s.points[0], s.points[0]] : s.points;
    for (let i = 1; i < pts.length; i++) {
      for (const [x, y] of linePixels(pts[i - 1], pts[i])) ctx.fillRect(x - half, y - half, TIP, TIP);
    }
  }
}

/** How much larger than the board Duck sees it. */
export const PICTURE_SCALE = 4;

/** The board as Duck sees it: the strokes larger and smooth on white, a PNG in base64. */
export function boardPng(strokes: readonly Stroke[]): string {
  const c = document.createElement("canvas");
  c.width = BOARD_W * PICTURE_SCALE;
  c.height = BOARD_H * PICTURE_SCALE;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = TIP * PICTURE_SCALE * 1.2;
  for (const s of strokes) {
    g.strokeStyle = INK[s.color];
    g.beginPath();
    s.points.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, (x + 0.5) * PICTURE_SCALE, (y + 0.5) * PICTURE_SCALE));
    if (s.points.length === 1) g.lineTo((s.points[0][0] + 0.5) * PICTURE_SCALE + 0.1, (s.points[0][1] + 0.5) * PICTURE_SCALE);
    g.stroke();
  }
  return c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
