// The sketch pad's document (G5): marks, the eraser, undo and redo, "live"'s dirty
// flag, stored JSON, and the names a sketch is sent under.

import { describe, expect, it } from "vitest";

import { emptyDoc, hits, parseSketch, Sketch, sketchName, type Mark } from "./model";

const pen = (pts: [number, number][], size = 4): Mark => ({ kind: "pen", color: "#000", size, points: pts.map(([x, y]) => [x, y, 0.5]) });

describe("sketch model", () => {
  it("adds marks with undo and redo, and skips empty ones", () => {
    const s = new Sketch();
    s.add(pen([]));
    s.add({ kind: "text", color: "#000", size: 4, at: [10, 10], text: "  " });
    expect(s.doc.marks).toHaveLength(0);
    expect(s.canUndo()).toBe(false);
    s.add(pen([[0, 0], [10, 10]]));
    s.add({ kind: "arrow", color: "#f00", size: 3, from: [0, 0], to: [50, 0] });
    expect(s.doc.marks.map((m) => m.kind)).toEqual(["pen", "arrow"]);
    s.undo();
    expect(s.doc.marks.map((m) => m.kind)).toEqual(["pen"]);
    expect(s.canRedo()).toBe(true);
    s.redo();
    expect(s.doc.marks).toHaveLength(2);
    s.undo();
    s.add(pen([[5, 5]]));
    expect(s.canRedo()).toBe(false);
  });

  it("erases whole marks the eraser touches", () => {
    const s = new Sketch();
    s.add(pen([[0, 0], [100, 0]]));
    s.add({ kind: "arrow", color: "#000", size: 2, from: [0, 100], to: [100, 100] });
    s.add({ kind: "text", color: "#000", size: 5, at: [200, 200], text: "cache" });
    expect(s.erase([50, 50], 10)).toBe(false);
    expect(s.erase([50, 3], 4)).toBe(true);
    expect(s.doc.marks.map((m) => m.kind)).toEqual(["arrow", "text"]);
    expect(hits(s.doc.marks[1], [210, 190], 2)).toBe(true);
    expect(hits(s.doc.marks[1], [400, 190], 2)).toBe(false);
    s.undo();
    expect(s.doc.marks).toHaveLength(3);
  });

  it("is dirty after a change until it's sent, and a clear keeps its background", () => {
    const s = new Sketch(emptyDoc({ kind: "grid" }));
    expect(s.dirty).toBe(false);
    s.add(pen([[1, 1]]));
    expect(s.dirty).toBe(true);
    s.sent();
    expect(s.dirty).toBe(false);
    s.clear();
    expect(s.doc).toMatchObject({ marks: [], background: { kind: "grid" } });
    s.setBackground({ kind: "image", name: "screenshot main" }, { width: 1920.4, height: 1080 });
    expect(s.doc).toMatchObject({ width: 1920, height: 1080, background: { kind: "image" } });
  });

  it("tells its listeners, and loads stored JSON with no history", () => {
    const s = new Sketch();
    let heard = 0;
    const off = s.onChange(() => heard++);
    s.add(pen([[1, 1]]));
    const json = s.toJSON();
    s.clear();
    off();
    s.add(pen([[2, 2]]));
    expect(heard).toBe(2);
    const doc = parseSketch(json)!;
    s.load(doc);
    expect(s.doc.marks).toHaveLength(1);
    expect(s.canUndo()).toBe(false);
    expect(parseSketch("{}")).toBeNull();
    expect(parseSketch("not json")).toBeNull();
  });

  it("names a mark-up after its drawing, so Duck knows which one changes", () => {
    const at = new Date(2026, 9, 23, 15, 4, 5);
    expect(sketchName({ kind: "blank" }, at)).toBe("sketch 2026-10-23-150405");
    expect(sketchName({ kind: "image", name: 'drawing 8f161f4b v2 Phone: prompt "flow"' }, at)).toBe(
      "mark-up of drawing 8f161f4b v2 Phone prompt flow 2026-10-23-150405",
    );
    expect(sketchName({ kind: "image", name: "screenshot main" }, at)).toBe("sketch 2026-10-23-150405");
  });
});
