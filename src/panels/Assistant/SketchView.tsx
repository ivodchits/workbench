// The sketch pad (step G5) in the drawer, or popped out into a dock tab: draw with
// the mouse, a pen or a touch screen on white, a grid, a screenshot, a photo, or one
// of Duck's drawings, and send it to Duck. The pad itself is `src/sketch/` (shared
// with the phone); this is its toolbar and its sending.

import { useEffect, useRef, useState } from "react";

import { listMonitors, screenshot } from "../../ipc/screen";
import { COLORS, TOOLS, type Tool } from "../../sketch/model";
import { Pad } from "../../sketch/pad";
import { openPanelBeside } from "../../state/dock";
import {
  closeSketch,
  loadImage,
  reopenSketch,
  sendSketch,
  setBackground,
  setLive,
  sketch,
  useSketchState,
} from "./sketchState";
import { useVoiceState } from "./voiceState";

const TOOL_LABEL: Record<Tool, string> = { pen: "✎", highlighter: "▮", eraser: "⌫", arrow: "➚", text: "T" };
const SIZES = [2, 4, 8] as const;

export function SketchView({ docked }: { docked?: boolean }) {
  const st = useSketchState();
  const canvas = useRef<HTMLCanvasElement>(null);
  const pad = useRef<Pad | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<number>(4);
  const [, bump] = useState(0);
  const [menu, setMenu] = useState<"bg" | "recent" | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    const p = new Pad(canvas.current, sketch, { askText: () => window.prompt("Text") });
    pad.current = p;
    const off = sketch.onChange(() => bump((n) => n + 1));
    return () => {
      off();
      p.destroy();
      pad.current = null;
    };
  }, []);
  useEffect(() => {
    if (pad.current) Object.assign(pad.current, { tool, color, size });
  }, [tool, color, size]);
  // The background picture, whenever it changes.
  useEffect(() => {
    let gone = false;
    if (!st.image) pad.current?.setImage(null);
    else
      void loadImage(st.image).then(
        (img) => !gone && pad.current?.setImage(img),
        () => !gone && pad.current?.setImage(null),
      );
    return () => {
      gone = true;
    };
  }, [st.image]);

  // "Live": the pad goes with each voice turn when it changed since it last went.
  const voice = useVoiceState();
  const talking = voice.phase === "listening" || voice.conversation.phase === "hearing";
  useEffect(() => {
    if (talking && st.live && sketch.dirty && sketch.doc.marks.length) void sendSketch(pad.current?.background ?? null);
  }, [talking, st.live]);

  const shot = async () => {
    setMenu(null);
    try {
      const mons = await listMonitors();
      const main = mons.find((m) => m.main) ?? mons[0];
      const cap = await screenshot(main ? { kind: "monitor", number: main.number } : { kind: "all" });
      const s = cap.shots[0];
      if (s) setBackground({ kind: "image", name: `screenshot ${s.label}` }, `data:image/png;base64,${s.pngBase64}`, { width: s.width, height: s.height });
    } catch (e) {
      window.alert(`No screenshot: ${String(e)}`);
    }
  };
  const pickPhoto = (f: File | undefined) => {
    if (!f) return;
    const url = URL.createObjectURL(f);
    void loadImage(url).then((img) => {
      const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      setBackground({ kind: "image", name: `photo ${f.name}` }, url, { width: img.naturalWidth * k, height: img.naturalHeight * k });
    });
  };
  const popOut = () => {
    openPanelBeside(null, { id: "sketch", component: "sketch", title: "sketch", params: {} });
    closeSketch();
  };

  const bg = sketch.doc.background;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, font: "11px var(--wb-mono)", color: "var(--wb-text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--wb-border)", flexWrap: "wrap", position: "relative" }}>
        {TOOLS.map((t) => (
          <button key={t} type="button" title={t} aria-pressed={tool === t} onClick={() => setTool(t)} style={{ ...chip, ...(tool === t && on) }}>
            {TOOL_LABEL[t]}
          </button>
        ))}
        <span style={{ width: 4 }} />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`colour ${c}`}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
            style={{ width: 16, height: 16, padding: 0, background: c, border: color === c ? "2px solid var(--wb-accent)" : "1px solid var(--wb-border)", cursor: "pointer" }}
          />
        ))}
        <span style={{ width: 4 }} />
        {SIZES.map((s) => (
          <button key={s} type="button" title={`size ${s}`} aria-pressed={size === s} onClick={() => setSize(s)} style={{ ...chip, ...(size === s && on) }}>
            {s === 2 ? "·" : s === 4 ? "•" : "●"}
          </button>
        ))}
        <span style={{ width: 4 }} />
        <button type="button" style={chip} disabled={!sketch.canUndo()} onClick={() => sketch.undo()} title="undo">
          ↶
        </button>
        <button type="button" style={chip} disabled={!sketch.canRedo()} onClick={() => sketch.redo()} title="redo">
          ↷
        </button>
        <button type="button" style={chip} disabled={!sketch.doc.marks.length} onClick={() => sketch.clear()} title="clear">
          clear
        </button>
        <button type="button" style={chip} onClick={() => setMenu(menu === "bg" ? null : "bg")} title="background">
          {bg.kind === "image" ? "▣" : bg.kind === "grid" ? "#" : "□"} ▾
        </button>
        {st.recent.length > 0 && (
          <button type="button" style={chip} onClick={() => setMenu(menu === "recent" ? null : "recent")} title="open a sketch sent earlier">
            open ▾
          </button>
        )}
        <span style={{ flex: 1 }} />
        <label title="send the pad with each voice turn when it changed" style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
          <input type="checkbox" checked={st.live} onChange={(e) => setLive(e.target.checked)} />
          live
        </label>
        <button
          type="button"
          style={{ ...chip, color: "var(--wb-accent)", borderColor: "var(--wb-accent)" }}
          disabled={st.sending || !sketch.doc.marks.length}
          onClick={() => void sendSketch(pad.current?.background ?? null)}
          title={talking ? "goes with what you're saying" : "goes to the message box: add your words and send"}
        >
          {st.sending ? "sending…" : "send to Duck"}
        </button>
        {!docked && (
          <button type="button" style={chip} onClick={popOut} title="open in a tab">
            ⇱
          </button>
        )}
        {!docked && (
          <button type="button" style={{ ...chip, border: "none" }} onClick={closeSketch} aria-label="close the sketch pad">
            ×
          </button>
        )}
        {menu === "bg" && (
          <div style={pop}>
            <button type="button" style={item} onClick={() => (setBackground({ kind: "blank" }, null), setMenu(null))}>
              blank
            </button>
            <button type="button" style={item} onClick={() => (setBackground({ kind: "grid" }, null), setMenu(null))}>
              grid
            </button>
            <button type="button" style={item} onClick={() => void shot()}>
              screenshot
            </button>
            <button type="button" style={item} onClick={() => (photo.current?.click(), setMenu(null))}>
              photo…
            </button>
          </div>
        )}
        {menu === "recent" && (
          <div style={pop}>
            {st.recent.map((r) => (
              <button key={r.name} type="button" style={{ ...item, display: "flex", gap: 6, alignItems: "center" }} onClick={() => (reopenSketch(r), setMenu(null))}>
                {r.thumb && <img src={r.thumb} alt="" style={{ width: 40, height: 28, objectFit: "contain", background: "#fff" }} />}
                {r.name}
              </button>
            ))}
          </div>
        )}
        <input ref={photo} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
      </div>
      {st.error && <div style={{ padding: "2px 8px", color: "var(--wb-needs)" }}>{st.error}</div>}
      <canvas ref={canvas} style={{ flex: 1, minHeight: 0, width: "100%", background: "var(--wb-bg)", cursor: "crosshair" }} />
    </div>
  );
}

/** The pad popped out into a dock tab. */
export default function SketchPanel() {
  return (
    <div style={{ height: "100%", background: "var(--wb-panel)" }}>
      <SketchView docked />
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
  minWidth: 22,
};
const on: React.CSSProperties = { color: "var(--wb-accent)", borderColor: "var(--wb-accent)" };
const pop: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 8,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  background: "var(--wb-panel)",
  border: "1px solid var(--wb-border)",
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  maxHeight: 320,
  overflowY: "auto",
};
const item: React.CSSProperties = { background: "transparent", border: "none", color: "var(--wb-text)", font: "inherit", padding: "4px 10px", textAlign: "left", cursor: "pointer" };
