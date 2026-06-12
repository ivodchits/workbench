// Keymap editor (step 3.10) — the remap UI (design §5.y "bindings should be
// remappable"). Lists every binding grouped by scope; for each you can record a new
// chord, unbind it, or reset it to the shipped default. Overrides persist to prefs
// (`keymap.ts`) and apply live — the palette and all listeners read the active map.
//
// Recording a chord: the row enters a one-shot "listening" state that suspends the
// global key dispatch (`setKeymapCapturing`) and installs a capture-phase window
// listener, so pressing e.g. Ctrl+Shift+K records the chord instead of firing the
// kill-instance action. `eventToChord` canonicalizes the press; Esc cancels.
//
// Guardrails on a new chord:
//   • global-scope chords must stay in the terminal's "command space" (Alt, or
//     Ctrl+Shift, or Ctrl+<non-printing>) so a remap can't swallow a control key
//     mid-session — `isSafeGlobalChord`. Rail keys (only live while the non-text
//     rail is focused) have no such limit.
//   • a chord already used by another binding in the same scope is rejected with a
//     pointer to the conflicting action (first-match-wins would otherwise shadow it).

import { useEffect, useState, type CSSProperties } from "react";

import Modal from "./InstanceManager/Modal";
import { GLYPH } from "../theme";
import { registerCommand } from "../keyboard/bus";
import {
  chordConflict,
  eventToChord,
  isSafeGlobalChord,
  resetAllBindings,
  resetBinding,
  setBindingChord,
  setKeymapCapturing,
  useBindings,
  type Binding,
  type Scope,
} from "../keyboard/keymap";
import { KeyCap } from "./CommandPalette";

/** Always-mounted host: opens the editor on the `openKeymapEditor` command. */
export default function KeymapEditorHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => registerCommand("openKeymapEditor", () => setOpen(true)), []);
  if (!open) return null;
  return <KeymapEditor onClose={() => setOpen(false)} />;
}

const SCOPE_TITLE: Record<Scope, string> = {
  global: "global — work from anywhere",
  rail: "instance rail — while the rail is focused",
};

function KeymapEditor({ onClose }: { onClose: () => void }) {
  const bindings = useBindings();
  // Which binding is currently recording, and the last rejection message.
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const global = bindings.filter((b) => b.scope === "global");
  const rail = bindings.filter((b) => b.scope === "rail");

  // The one-shot capture: while a row listens, swallow the next chord here.
  useEffect(() => {
    if (!listeningId) return;
    const binding = bindings.find((b) => b.id === listeningId);
    if (!binding) return;
    setKeymapCapturing(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      // Esc cancels recording (without binding Esc); modifiers held alone wait.
      if (e.key === "Escape") {
        setListeningId(null);
        return;
      }
      const chord = eventToChord(e);
      if (chord === null) return; // a lone modifier — keep waiting for the full chord
      if (binding.scope === "global" && !isSafeGlobalChord(chord)) {
        setError("global shortcuts must use Alt, or Ctrl+Shift, or Ctrl with a non-letter key");
        return;
      }
      const clash = chordConflict(chord, binding.scope, binding.id);
      if (clash) {
        setError(`already bound to "${clash.title}" — reset that first`);
        return;
      }
      setBindingChord(binding.id, chord);
      setError(null);
      setListeningId(null);
    };

    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      setKeymapCapturing(false);
    };
  }, [listeningId, bindings]);

  const beginListen = (id: string) => {
    setError(null);
    setListeningId(id);
  };

  return (
    <Modal title="keyboard shortcuts" onClose={onClose} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ font: "11px var(--wb-mono)", color: "var(--wb-textDim2)", flex: 1 }}>
            {listeningId
              ? "press a key combination… (Esc to cancel)"
              : "click a shortcut to record a new key"}
          </span>
          <button onMouseDown={(e) => { e.preventDefault(); resetAllBindings(); setError(null); }} style={buttonStyle}>
            reset all
          </button>
        </div>

        {error && (
          <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-needs)" }}>
            {GLYPH.warn} {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "60vh", overflowY: "auto" }}>
          <Section title={SCOPE_TITLE.global} bindings={global} listeningId={listeningId} onListen={beginListen} />
          <Section title={SCOPE_TITLE.rail} bindings={rail} listeningId={listeningId} onListen={beginListen} />
        </div>
      </div>
    </Modal>
  );
}

function Section({
  title,
  bindings,
  listeningId,
  onListen,
}: {
  title: string;
  bindings: Binding[];
  listeningId: string | null;
  onListen: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...labelStyle, color: "var(--wb-accent)" }}>{title}</span>
      {bindings.map((b) => (
        <BindingRow key={b.id} binding={b} listening={b.id === listeningId} onListen={() => onListen(b.id)} />
      ))}
    </div>
  );
}

function BindingRow({
  binding,
  listening,
  onListen,
}: {
  binding: Binding;
  listening: boolean;
  onListen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const changed = binding.chord !== binding.defaultChord;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 8px",
        background: hover ? "var(--wb-sel)" : "transparent",
        border: "1px solid transparent",
        borderColor: listening ? "var(--wb-borderActive)" : "transparent",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, font: "12px var(--wb-mono)", color: "var(--wb-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {binding.title}
        {changed && <span title="changed from default" style={{ color: "var(--wb-accent)", marginLeft: 6 }}>•</span>}
      </span>

      {/* The chord, clickable to re-record. */}
      <button
        onMouseDown={(e) => { e.preventDefault(); onListen(); }}
        title="record a new shortcut"
        style={{
          ...chordButtonStyle,
          minWidth: 96,
          justifyContent: "flex-end",
          borderColor: listening ? "var(--wb-borderActive)" : "var(--wb-border)",
        }}
      >
        {listening ? (
          <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-accent)" }}>press keys…</span>
        ) : binding.chord ? (
          <KeyCap chord={binding.chord} />
        ) : (
          <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", fontStyle: "italic" }}>unbound</span>
        )}
      </button>

      {/* Unbind + reset, shown on hover (or while listening) so the row stays calm. */}
      <span style={{ display: "inline-flex", gap: 2, width: 44, justifyContent: "flex-end", visibility: hover || listening ? "visible" : "hidden" }}>
        {binding.chord && (
          <IconButton title="unbind" onClick={() => setBindingChord(binding.id, "")}>✕</IconButton>
        )}
        {changed && (
          <IconButton title="reset to default" onClick={() => resetBinding(binding.id)}>↺</IconButton>
        )}
      </span>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      tabIndex={-1}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--wb-textFaint)",
        font: "12px var(--wb-mono)",
        cursor: "pointer",
        padding: "2px 4px",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

const labelStyle: CSSProperties = {
  font: "600 10px var(--wb-mono)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--wb-textDim2)",
  padding: "2px 0",
};

const buttonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "4px 10px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11,
  cursor: "pointer",
};

const chordButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "var(--wb-bg)",
  border: "1px solid var(--wb-border)",
  padding: "3px 7px",
  cursor: "pointer",
};
