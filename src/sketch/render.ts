// Drawing a sketch (step G5) on a 2D canvas: the background, then each mark.
// Pen and highlighter strokes go through `perfect-freehand`, which turns the points
// and their pressure into an outline that tapers like ink.

import { getStroke } from "perfect-freehand";

import type { Mark, SketchDoc } from "./model";

const GRID = 40;

/** A stroke outline as a closed path. */
function outline(points: number[][]): Path2D {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

/** Whether a device gave real pressure (else perfect-freehand simulates it). */
const pressured = (points: number[][]) => points.some((p) => p[2] !== 0.5 && p[2] !== 0 && p[2] !== undefined);

export function drawMark(g: CanvasRenderingContext2D, m: Mark): void {
  g.save();
  switch (m.kind) {
    case "pen":
    case "highlighter": {
      const hl = m.kind === "highlighter";
      const stroke = getStroke(m.points, {
        size: hl ? m.size * 4 : m.size,
        thinning: hl ? 0 : 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: !hl && !pressured(m.points),
      });
      g.fillStyle = m.color;
      if (hl) g.globalAlpha = 0.35;
      g.fill(outline(stroke));
      break;
    }
    case "arrow": {
      const [x0, y0] = m.from;
      const [x1, y1] = m.to;
      const a = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(12, m.size * 4);
      g.strokeStyle = m.color;
      g.fillStyle = m.color;
      g.lineWidth = m.size;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1 - Math.cos(a) * head * 0.6, y1 - Math.sin(a) * head * 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
      g.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
      g.closePath();
      g.fill();
      break;
    }
    case "text":
      g.fillStyle = m.color;
      g.font = `${m.size * 4}px "Segoe UI", Arial, sans-serif`;
      g.textBaseline = "alphabetic";
      g.fillText(m.text, m.at[0], m.at[1]);
      break;
  }
  g.restore();
}

/** Draw the whole sketch at the document's size (the caller scales `g`). `image`
 *  is the picture of an `image` background, once loaded. */
export function drawSketch(g: CanvasRenderingContext2D, doc: SketchDoc, image?: CanvasImageSource | null, extra?: Mark | null): void {
  g.save();
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, doc.width, doc.height);
  if (doc.background.kind === "grid") {
    g.strokeStyle = "#e5e7eb";
    g.lineWidth = 1;
    g.beginPath();
    for (let x = GRID; x < doc.width; x += GRID) {
      g.moveTo(x + 0.5, 0);
      g.lineTo(x + 0.5, doc.height);
    }
    for (let y = GRID; y < doc.height; y += GRID) {
      g.moveTo(0, y + 0.5);
      g.lineTo(doc.width, y + 0.5);
    }
    g.stroke();
  } else if (doc.background.kind === "image" && image) g.drawImage(image, 0, 0, doc.width, doc.height);
  g.restore();
  for (const m of doc.marks) drawMark(g, m);
  if (extra) drawMark(g, extra);
}

/** The sketch flattened to a PNG at its own size. */
export function sketchPng(doc: SketchDoc, image?: CanvasImageSource | null): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = doc.width;
  c.height = doc.height;
  const g = c.getContext("2d");
  if (!g) return Promise.resolve(null);
  drawSketch(g, doc, image);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
}
