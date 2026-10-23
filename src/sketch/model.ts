// The sketch pad's document (step G5): what you drew, as marks over a background,
// with undo and redo. Plain data, no DOM: the desktop's view and the phone's page
// both draw it (`render.ts`) and drive it (`pad.ts`), and a sent sketch keeps it as
// JSON beside its PNG, so it can be opened again and edited.

export const TOOLS = ["pen", "highlighter", "eraser", "arrow", "text"] as const;
export type Tool = (typeof TOOLS)[number];

export const COLORS = ["#1f2937", "#dc2626", "#2563eb", "#16a34a", "#f59e0b", "#9333ea"] as const;

/** A point: x, y in the document's pixels, and the pen's pressure (0.5 when the
 *  device has none). */
export type Point = [number, number, number];

export type Mark =
  | { kind: "pen" | "highlighter"; color: string; size: number; points: Point[] }
  | { kind: "arrow"; color: string; size: number; from: [number, number]; to: [number, number] }
  | { kind: "text"; color: string; size: number; at: [number, number]; text: string };

export type Background =
  | { kind: "blank" }
  | { kind: "grid" }
  /** A picture under the marks: a screenshot, a photo, or one of Duck's drawings
   *  ("mark up"). `name` says which, for the file's name and Duck. */
  | { kind: "image"; name: string };

export interface SketchDoc {
  v: 1;
  width: number;
  height: number;
  background: Background;
  marks: Mark[];
}

export const DEFAULT_SIZE = { width: 1600, height: 1000 };

export const emptyDoc = (background: Background = { kind: "blank" }, size = DEFAULT_SIZE): SketchDoc => ({
  v: 1,
  width: Math.round(size.width),
  height: Math.round(size.height),
  background,
  marks: [],
});

/** The text a mark takes up, roughly: its box for the eraser. */
function textBox(m: Extract<Mark, { kind: "text" }>) {
  const h = m.size * 4;
  return { x: m.at[0], y: m.at[1] - h, w: m.text.length * h * 0.55, h: h * 1.2 };
}

const distToSegment = (p: [number, number], a: [number, number], b: [number, number]) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/** Whether the eraser at `p` with radius `r` touches `m`. */
export function hits(m: Mark, p: [number, number], r: number): boolean {
  switch (m.kind) {
    case "pen":
    case "highlighter": {
      const reach = r + m.size / 2;
      if (m.points.length === 1) return Math.hypot(p[0] - m.points[0][0], p[1] - m.points[0][1]) <= reach;
      for (let i = 1; i < m.points.length; i++) {
        const a = m.points[i - 1];
        const b = m.points[i];
        if (distToSegment(p, [a[0], a[1]], [b[0], b[1]]) <= reach) return true;
      }
      return false;
    }
    case "arrow":
      return distToSegment(p, m.from, m.to) <= r + m.size;
    case "text": {
      const b = textBox(m);
      return p[0] >= b.x - r && p[0] <= b.x + b.w + r && p[1] >= b.y - r && p[1] <= b.y + b.h + r;
    }
  }
}

/** A sketch with its history: every change makes a new `doc`, and undo / redo step
 *  through them. */
export class Sketch {
  doc: SketchDoc;
  private past: SketchDoc[] = [];
  private future: SketchDoc[] = [];
  /** Changes since it was last sent ("live" sends only a changed pad). */
  dirty = false;
  private listeners = new Set<() => void>();

  constructor(doc: SketchDoc = emptyDoc()) {
    this.doc = doc;
  }

  private commit(next: SketchDoc): void {
    this.past.push(this.doc);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.doc = next;
    this.dirty = true;
    this.changed();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  add(m: Mark): void {
    if ((m.kind === "pen" || m.kind === "highlighter") && m.points.length === 0) return;
    if (m.kind === "text" && !m.text.trim()) return;
    this.commit({ ...this.doc, marks: [...this.doc.marks, m] });
  }

  /** Erase the marks the eraser touches at `p`; whether any went. */
  erase(p: [number, number], r: number): boolean {
    const kept = this.doc.marks.filter((m) => !hits(m, p, r));
    if (kept.length === this.doc.marks.length) return false;
    this.commit({ ...this.doc, marks: kept });
    return true;
  }

  clear(): void {
    if (!this.doc.marks.length) return;
    this.commit({ ...this.doc, marks: [] });
  }

  /** A new background (and size): the marks stay. */
  setBackground(background: Background, size?: { width: number; height: number }): void {
    this.commit({ ...this.doc, background, ...(size && { width: Math.round(size.width), height: Math.round(size.height) }) });
  }

  canUndo = () => this.past.length > 0;
  canRedo = () => this.future.length > 0;

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.doc);
    this.doc = prev;
    this.dirty = true;
    this.changed();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.doc);
    this.doc = next;
    this.dirty = true;
    this.changed();
  }

  /** Start over from `doc` (a sketch opened again), with no history. */
  load(doc: SketchDoc): void {
    this.doc = doc;
    this.past = [];
    this.future = [];
    this.dirty = false;
    this.changed();
  }

  /** It went to Duck: "live" waits for the next change. */
  sent(): void {
    this.dirty = false;
  }

  toJSON(): string {
    return JSON.stringify(this.doc);
  }
}

/** A stored sketch's JSON as a document; null when it isn't one. */
export function parseSketch(json: string): SketchDoc | null {
  try {
    const d = JSON.parse(json) as Partial<SketchDoc>;
    if (d.v !== 1 || !Array.isArray(d.marks) || !(Number(d.width) > 0) || !(Number(d.height) > 0) || !d.background) return null;
    return d as SketchDoc;
  } catch {
    return null;
  }
}

/** The file name a sketch is sent as: a mark-up names the drawing it's on, so Duck
 *  knows which drawing to change. */
export function sketchName(bg: Background, at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  if (bg.kind === "image" && bg.name.startsWith("drawing ")) return `mark-up of ${bg.name.replace(/[\\/:*?"<>|]/g, "")} ${stamp}`;
  return `sketch ${stamp}`;
}
