// The sketch pad on the phone (step G5): full screen, landscape when the phone
// allows it, drawn with a finger or a pen on the same core as the desktop's
// (`src/sketch/`). "send" stages the PNG like a 📎 pick, so it goes with what you
// say (G2) or with the next message; 📎 and the mic are on the same screen.

import { COLORS, emptyDoc, Sketch, sketchName, TOOLS, type Background, type Tool } from "../sketch/model";
import { Pad } from "../sketch/pad";
import { sketchPng } from "../sketch/render";
import { el } from "./dom";

const TOOL_LABEL: Record<Tool, string> = { pen: "✎", highlighter: "▮", eraser: "⌫", arrow: "➚", text: "T" };

/** One sketch for the page: closing keeps it, so you can come back to it. */
const sketch = new Sketch();
let overlay: HTMLElement | null = null;
let pad: Pad | null = null;
let offChange: (() => void) | null = null;

export interface SketchHooks {
  /** Stage the PNG like a 📎 pick. */
  stage(files: { blob: Blob; name: string }[]): void;
  /** The page's own 📎 and mic buttons, which the pad's forward to. */
  attach: HTMLElement;
  mic: HTMLElement;
}

export const sketchOpen = () => overlay !== null;

export function closeSketch(): void {
  offChange?.();
  offChange = null;
  pad?.destroy();
  pad = null;
  overlay?.remove();
  overlay = null;
  void screen.orientation?.unlock?.();
}

/** Open the pad; on a picture (a drawing to mark up) when given. */
export function openSketch(hooks: SketchHooks, bg?: { background: Background; image: string; size: { width: number; height: number } }): void {
  closeSketch();
  let image: HTMLImageElement | null = null;
  if (bg) sketch.load(emptyDoc(bg.background, bg.size));
  const root = el("div", "duck-sketch");
  const bar = el("div", "bar");
  const canvas = el("canvas");
  root.append(bar, canvas);
  document.body.append(root);
  overlay = root;
  // Landscape gives the pad room; it only works where the page may lock it.
  void (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});

  const p = new Pad(canvas, sketch, { askText: () => window.prompt("Text") });
  pad = p;
  if (bg) {
    image = new Image();
    image.onload = () => p.setImage(image);
    image.src = bg.image;
  }

  const button = (label: string, title: string, onClick: () => void, cls = "") => {
    const b = el("button", cls, label);
    b.type = "button";
    b.title = title;
    b.onclick = onClick;
    return b;
  };
  const paintBar = () => {
    bar.replaceChildren();
    for (const t of TOOLS) bar.append(button(TOOL_LABEL[t], t, () => ((p.tool = t), paintBar()), p.tool === t ? "on" : ""));
    for (const c of COLORS) {
      const b = button("", `colour ${c}`, () => ((p.color = c), paintBar()), `swatch${p.color === c ? " on" : ""}`);
      b.style.background = c;
      bar.append(b);
    }
    bar.append(
      button("↶", "undo", () => sketch.undo()),
      button("↷", "redo", () => sketch.redo()),
      button("clear", "clear", () => sketch.clear()),
      button(sketch.doc.background.kind === "grid" ? "□" : "#", "grid or blank", () => {
        if (sketch.doc.background.kind !== "image") sketch.setBackground({ kind: sketch.doc.background.kind === "grid" ? "blank" : "grid" });
        paintBar();
      }),
    );
    bar.append(el("span", "gap"));
    // The page's own 📎 and mic, forwarded, so talking about the sketch works here.
    bar.append(button("📎", "attach files", () => hooks.attach.click()));
    const mic = button("mic", "hold to talk", () => {}, "mic");
    for (const type of ["pointerdown", "pointerup", "pointercancel", "pointerleave"] as const)
      mic.addEventListener(type, (e) => {
        e.preventDefault();
        hooks.mic.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: e.pointerId, pointerType: e.pointerType }));
      });
    bar.append(mic);
    bar.append(
      button(
        "send",
        "send to Duck: with what you say, or with your next message",
        () =>
          void sketchPng(sketch.doc, image).then((png) => {
            if (!png) return;
            hooks.stage([{ blob: png, name: `${sketchName(sketch.doc.background)}.png` }]);
            sketch.sent();
            closeSketch();
          }),
        "send",
      ),
      button("×", "close (the sketch stays)", closeSketch, "close"),
    );
  };
  offChange = sketch.onChange(paintBar);
  paintBar();
}
