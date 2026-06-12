// Presets bar (step 3.3) — the title-bar control for the active project's saved
// layout arrangements (design §5 "Layout" menu, §7 layout presets). Each chip is
// a named snapshot of the dock; clicking it (or pressing Ctrl+Shift+<n>) restores
// that arrangement. The "＋" button captures the current dock as a new preset.
//
// Presets are **project-scoped** (see `state/presets`): the bar loads the active
// project's set whenever the selection changes, so the chips — and the number-key
// bindings — always track the project on screen.

import { useEffect, useRef, useState } from "react";
import { useActiveProject } from "../state/activeProject";
import { registerCommand } from "../keyboard/bus";
import {
  applyPreset,
  deletePreset,
  loadPresetsFor,
  renamePreset,
  saveCurrentAsPreset,
  updatePresetLayout,
  usePresets,
} from "../state/presets";

type Mode = { kind: "idle" } | { kind: "save" } | { kind: "rename"; id: string };

function PresetsBar() {
  const activeProjectId = useActiveProject();
  const { presets } = usePresets();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [draft, setDraft] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the bar's chips in sync with the project on screen.
  useEffect(() => {
    void loadPresetsFor(activeProjectId);
  }, [activeProjectId]);

  // `savePreset` command → open the inline save field. No keyboard chord (it
  // collided with the editor's Ctrl+Shift+S Save-All); driven by the ＋ button.
  useEffect(
    () =>
      registerCommand("savePreset", () => {
        if (!activeProjectId) return;
        setDraft("");
        setMode({ kind: "save" });
      }),
    [activeProjectId],
  );

  // Focus + select the inline field whenever an edit mode opens.
  useEffect(() => {
    if (mode.kind !== "idle") {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [mode]);

  const commit = () => {
    if (mode.kind === "save") void saveCurrentAsPreset(draft);
    else if (mode.kind === "rename") void renamePreset(mode.id, draft);
    setMode({ kind: "idle" });
    setDraft("");
  };

  const cancel = () => {
    setMode({ kind: "idle" });
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // No project selected → nothing to save against; keep the bar empty/quiet.
  if (!activeProjectId) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        font: "11px var(--wb-mono)",
        maxWidth: "60%",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--wb-textFaint)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
        layout
      </span>

      <div style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
        {presets.map((p, i) => {
          if (mode.kind === "rename" && mode.id === p.id) {
            return (
              <input
                key={p.id}
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={cancel}
                style={fieldStyle}
              />
            );
          }
          const num = i < 9 ? i + 1 : null;
          const isHover = hovered === p.id;
          return (
            <span
              key={p.id}
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered((h) => (h === p.id ? null : h))}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 6px",
                border: "1px solid var(--wb-border)",
                background: isHover ? "var(--wb-sel)" : "transparent",
                color: "var(--wb-textDim2)",
                whiteSpace: "nowrap",
                cursor: "pointer",
                maxWidth: 160,
              }}
            >
              <button
                type="button"
                onClick={() => applyPreset(p.id)}
                onDoubleClick={() => {
                  setDraft(p.name);
                  setMode({ kind: "rename", id: p.id });
                }}
                title={
                  `apply layout preset "${p.name}"` +
                  (num ? ` (Ctrl+Shift+${num})` : "") +
                  " · double-click to rename"
                }
                style={chipButtonStyle}
              >
                {num && <span style={{ color: "var(--wb-textFaint)" }}>{num}</span>}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              </button>
              {isHover && (
                <>
                  <button
                    type="button"
                    onClick={() => void updatePresetLayout(p.id)}
                    title="overwrite with the current arrangement"
                    style={iconButtonStyle}
                  >
                    ⟳
                  </button>
                  <button
                    type="button"
                    onClick={() => void deletePreset(p.id)}
                    title="delete this preset"
                    style={iconButtonStyle}
                  >
                    ✕
                  </button>
                </>
              )}
            </span>
          );
        })}

        {mode.kind === "save" ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={cancel}
            placeholder="preset name"
            style={fieldStyle}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setMode({ kind: "save" });
            }}
            title="save the current arrangement as a preset"
            style={{ ...iconButtonStyle, padding: "2px 6px", border: "1px solid var(--wb-border)" }}
          >
            ＋
          </button>
        )}
      </div>
    </div>
  );
}

const chipButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: "none",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  padding: 0,
  maxWidth: 140,
  overflow: "hidden",
};

const iconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wb-textFaint)",
  font: "11px var(--wb-mono)",
  cursor: "pointer",
  padding: "0 2px",
  lineHeight: 1,
};

const fieldStyle: React.CSSProperties = {
  background: "var(--wb-bg)",
  border: "1px solid var(--wb-borderActive)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "2px 6px",
  width: 120,
  outline: "none",
};

export default PresetsBar;
