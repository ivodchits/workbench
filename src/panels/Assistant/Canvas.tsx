// The canvas (step G3): a drawing Duck had drawn, beside the thread. Pan with a
// drag, zoom with the wheel, double-click to fit; step back through the versions;
// copy it as a PNG, save it, open its source, or pop it out into a dock tab.
//
// The SVG is the engine's render of the worker's source, shown as an `<img>` from a
// data URL: model-written markup never becomes part of this page, so a script in it
// never runs (`src/drawing/render.ts`).

import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { save } from "@tauri-apps/plugin-dialog";

import type { DrawingView } from "../../assistant/protocol";
import { svgSize, svgUrl } from "../../drawing/kinds";
import { toPng } from "../../drawing/render";
import { attachSave } from "../../ipc/assistant";
import { getActiveProject, setActiveProject } from "../../state/activeProject";
import { openPanelBeside } from "../../state/dock";
import { openProjectFile } from "../../state/editors";
import { getRegistry } from "../../state/registry";
import { flash } from "../../util/flash";
import { closeCanvas, connectDuck, loadSvg, openCanvas, requestDrawing, useDuckState } from "./duckState";
import { openSketch } from "./sketchState";

const same = (a: string, b: string) =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Open a version's source in the editor: in the workspace's project ("Duck"),
 *  else the one you're in. */
function openSource(path: string) {
  const workspace = path.replace(/[\\/]tasks[\\/].*$/, "");
  const { projects } = getRegistry();
  const p = projects.find((x) => same(x.rootPath, workspace)) ?? projects.find((x) => x.id === getActiveProject());
  if (!p) return flash("no project to open it in");
  setActiveProject(p.id);
  openProjectFile({ projectId: p.id, rootPath: p.rootPath, label: p.name }, { path, preview: true });
}

/** The drawing on a canvas; `n` null: its newest version. */
export function CanvasView({ drawing, n, onClose, onPick, docked }: {
  drawing: DrawingView;
  n: number | null;
  onClose?: () => void;
  onPick: (n: number) => void;
  /** In a dock tab: no pop-out. */
  docked?: boolean;
}) {
  const duck = useDuckState();
  const version = drawing.versions.find((v) => v.n === n) ?? drawing.versions[drawing.versions.length - 1] ?? null;
  const key = version ? `${drawing.id}:${version.n}` : "";
  const svg = key ? duck.svgs[key] : undefined;
  useEffect(() => {
    if (version) loadSvg(drawing.id, version.n);
  }, [drawing.id, version]);

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const fit = () => {
    const b = box.current?.getBoundingClientRect();
    const i = img.current;
    if (!b || !i?.naturalWidth) return setView({ x: 0, y: 0, k: 1 });
    const k = Math.min(1.5, (b.width - 16) / i.naturalWidth, (b.height - 16) / i.naturalHeight);
    setView({ k, x: (b.width - i.naturalWidth * k) / 2, y: (b.height - i.naturalHeight * k) / 2 });
  };
  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [key]);

  const zoom = (e: React.WheelEvent) => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    const f = Math.exp(-e.deltaY * 0.0015);
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    setView((v) => {
      const k = Math.min(8, Math.max(0.1, v.k * f));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const pan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, v: view };
    const move = (ev: PointerEvent) => setView({ ...start.v, x: start.v.x + ev.clientX - start.x, y: start.v.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ready = svg && !svg.startsWith("!") ? svg : null;
  const copyPng = async () => {
    const png = ready ? await toPng(ready) : null;
    if (!png) return flash("it can't be copied as a PNG");
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      flash("copied as PNG");
    } catch (e) {
      flash(`not copied: ${String(e)}`);
    }
  };
  const saveAs = async () => {
    if (!version) return;
    const refs = [version.png, version.svg].filter((r) => r !== null);
    if (!refs.length) return flash("nothing stored to save");
    const dest = await save({
      defaultPath: refs[0].name,
      filters: refs.map((r) => ({ name: r.name.endsWith(".svg") ? "SVG" : "PNG", extensions: [r.name.split(".").pop() ?? "png"] })),
    });
    if (!dest) return;
    const ref = refs.find((r) => dest.toLowerCase().endsWith(`.${r.name.split(".").pop()}`)) ?? refs[0];
    try {
      await attachSave(ref.id, ref.name, dest);
      flash("saved");
    } catch (e) {
      flash(String(e));
    }
  };
  // Mark it up (G5): the pad opens with this version under it, and what you send
  // is named after the drawing, so Duck changes that one.
  const markUp = async () => {
    const png = ready ? await toPng(ready) : null;
    const size = ready ? svgSize(ready) : null;
    if (!png || !size || !version) return flash("it can't be marked up");
    const k = Math.min(1, 1800 / Math.max(size.width, size.height));
    openSketch({
      background: { kind: "image", name: `drawing ${drawing.id} v${version.n} ${drawing.title}` },
      image: URL.createObjectURL(png),
      size: { width: size.width * k * 2, height: size.height * k * 2 },
    });
    onClose?.();
  };
  const popOut = () => {
    openPanelBeside(null, {
      id: `drawing:${drawing.id}`,
      component: "drawing",
      title: `drawing · ${drawing.title}`,
      params: { drawingId: drawing.id },
    });
    onClose?.();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", font: "11px var(--wb-mono)", color: "var(--wb-text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--wb-border)", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }} title={version?.headline}>
          {drawing.title}
        </span>
        {drawing.versions.map((v) => (
          <button
            key={v.n}
            type="button"
            aria-pressed={v.n === version?.n}
            title={v.headline}
            onClick={() => onPick(v.n)}
            style={{ ...chip, ...(v.n === version?.n && { color: "var(--wb-accent)", borderColor: "var(--wb-accent)" }) }}
          >
            v{v.n}
          </button>
        ))}
        {drawing.pending && (
          <span style={{ color: "var(--wb-working)" }} title={drawing.pending.waiting ?? undefined}>
            {drawing.pending.waiting ? `v${drawing.pending.n} waits` : `drawing v${drawing.pending.n}…`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" style={chip} disabled={!ready} onClick={() => void copyPng()} title="copy as PNG">
          copy
        </button>
        <button type="button" style={chip} disabled={!version} onClick={() => void saveAs()} title="save as…">
          save
        </button>
        <button type="button" style={chip} disabled={!version} onClick={() => version && openSource(version.path)} title={version?.path}>
          source
        </button>
        <button type="button" style={chip} disabled={!ready} onClick={() => void markUp()} title="mark it up on the sketch pad">
          mark up
        </button>
        {!docked && (
          <button type="button" style={chip} onClick={popOut} title="open in a tab">
            ⇱
          </button>
        )}
        {onClose && (
          <button type="button" style={{ ...chip, border: "none" }} onClick={onClose} aria-label="close the canvas">
            ×
          </button>
        )}
      </div>
      <div
        ref={box}
        onWheel={zoom}
        onPointerDown={pan}
        onDoubleClick={fit}
        style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: "var(--wb-bg)", cursor: "grab", touchAction: "none" }}
      >
        {ready ? (
          <img
            ref={img}
            src={svgUrl(ready)}
            alt={version?.headline ?? drawing.title}
            draggable={false}
            onLoad={fit}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transformOrigin: "0 0",
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              background: "#fff",
              boxShadow: "0 1px 6px rgba(0,0,0,0.35)",
              maxWidth: "none",
            }}
          />
        ) : (
          <div style={{ padding: 16, color: svg?.startsWith("!") ? "var(--wb-needs)" : "var(--wb-textFaint)" }}>
            {!version ? (drawing.pending ? "drawing…" : "no version yet") : svg?.startsWith("!") ? svg.slice(1) : "rendering…"}
          </div>
        )}
      </div>
    </div>
  );
}

/** The drawer's canvas: the drawing `duck.canvas` names. */
export function DrawerCanvas() {
  const duck = useDuckState();
  const c = duck.canvas;
  const drawing = c ? duck.drawings[c.id] : undefined;
  if (!c) return null;
  if (!drawing) return <div style={{ padding: 12, color: "var(--wb-textFaint)" }}>loading the drawing…</div>;
  return <CanvasView drawing={drawing} n={c.n} onClose={closeCanvas} onPick={(n) => openCanvas(c.id, n)} />;
}

export interface DrawingPanelParams {
  drawingId: string;
}

/** A drawing popped out into a dock tab. */
export default function DrawingPanel(props: IDockviewPanelProps<DrawingPanelParams>) {
  const { drawingId } = props.params;
  const duck = useDuckState();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    void connectDuck().then(() => requestDrawing(drawingId));
  }, [drawingId]);
  const drawing = duck.drawings[drawingId];
  return (
    <div style={{ height: "100%", background: "var(--wb-panel)" }}>
      {drawing ? <CanvasView drawing={drawing} n={n} onPick={setN} docked /> : <div style={{ padding: 12, color: "var(--wb-textFaint)" }}>loading the drawing…</div>}
    </div>
  );
}

const chip: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "1px 6px",
  cursor: "pointer",
};
