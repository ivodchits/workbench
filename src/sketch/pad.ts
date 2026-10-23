// The sketch pad on a canvas element (step G5): pointer events (pen, touch or
// mouse, with a pen's pressure) into marks, drawn as they're made. The document
// keeps its own size; the canvas shows it fitted and centred, sharp on high-DPI
// screens. Used by the drawer's view and the phone's page alike.

import { drawSketch } from "./render";
import { COLORS, type Mark, type Point, type Sketch, type Tool } from "./model";

/** The eraser's reach, in document pixels. */
const ERASER = 14;

export interface PadOptions {
  /** The words for a text mark at a spot; null cancels. */
  askText(): Promise<string | null> | string | null;
}

export class Pad {
  tool: Tool = "pen";
  color: string = COLORS[0];
  size = 4;
  private image: CanvasImageSource | null = null;
  private live: Mark | null = null;
  private frame = 0;
  private fit = { k: 1, x: 0, y: 0 };
  private offChange: () => void;
  private resize: ResizeObserver;
  private down = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private sketch: Sketch,
    private opts: PadOptions,
  ) {
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    this.offChange = sketch.onChange(() => this.redraw());
    this.resize = new ResizeObserver(() => this.redraw());
    this.resize.observe(canvas);
    this.redraw();
  }

  /** The picture under an `image` background (null: none yet). */
  setImage(image: CanvasImageSource | null): void {
    this.image = image;
    this.redraw();
  }

  get background(): CanvasImageSource | null {
    return this.image;
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.offChange();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
  }

  redraw = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  };

  private paint(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const doc = this.sketch.doc;
    const k = Math.min(w / doc.width, h / doc.height);
    this.fit = { k, x: (w - doc.width * k) / 2, y: (h - doc.height * k) / 2 };
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * this.fit.x, dpr * this.fit.y);
    g.save();
    g.beginPath();
    g.rect(0, 0, doc.width, doc.height);
    g.clip();
    drawSketch(g, doc, this.image, this.live);
    g.restore();
  }

  /** A pointer's spot in document pixels, with its pressure. */
  private at(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return [(e.clientX - r.left - this.fit.x) / this.fit.k, (e.clientY - r.top - this.fit.y) / this.fit.k, pressure];
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const p = this.at(e);
    if (this.tool === "text") {
      void Promise.resolve(this.opts.askText()).then((text) => {
        if (text?.trim()) this.sketch.add({ kind: "text", color: this.color, size: this.size, at: [p[0], p[1]], text: text.trim() });
      });
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.down = true;
    if (this.tool === "eraser") this.sketch.erase([p[0], p[1]], ERASER / Math.max(this.fit.k, 0.25));
    else if (this.tool === "arrow") this.live = { kind: "arrow", color: this.color, size: this.size, from: [p[0], p[1]], to: [p[0], p[1]] };
    else this.live = { kind: this.tool, color: this.color, size: this.size, points: [p] };
    this.redraw();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.down) return;
    const p = this.at(e);
    if (this.tool === "eraser") {
      this.sketch.erase([p[0], p[1]], ERASER / Math.max(this.fit.k, 0.25));
      return;
    }
    const m = this.live;
    if (!m) return;
    if (m.kind === "arrow") this.live = { ...m, to: [p[0], p[1]] };
    else if (m.kind === "pen" || m.kind === "highlighter") {
      // Coalesced events keep a fast pen's curve smooth.
      const pts = (e.getCoalescedEvents?.() ?? [e]).map((x) => this.at(x));
      this.live = { ...m, points: [...m.points, ...pts] };
    }
    this.redraw();
  };

  private onUp = (): void => {
    if (!this.down) return;
    this.down = false;
    const m = this.live;
    this.live = null;
    if (m && !(m.kind === "arrow" && Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) < 4)) this.sketch.add(m);
    this.redraw();
  };
}
