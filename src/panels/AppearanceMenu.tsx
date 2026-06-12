// Appearance menu (step 3.9) — the status-bar control for the three look-and-feel
// options: the active **theme preset**, the **CRT overlay** toggle, and the global
// **font scale**. Replaces the static "muted dark" label that sat in the status bar.
// The trigger shows the active theme; clicking it opens a small popover (upward,
// since the status bar hugs the bottom). All changes route through the appearance
// store, which persists them and fans them out to chrome / terminals / editors.

import { useEffect, useRef, useState } from "react";
import { THEMES } from "../theme";
import { runCommand } from "../keyboard/bus";
import {
  resetFontScale,
  setFontScale,
  setThemeId,
  toggleCrt,
  useCrt,
  useFontScale,
  useThemeId,
} from "../state/appearance";

function AppearanceMenu() {
  const themeId = useThemeId();
  const crt = useCrt();
  const fontScale = useFontScale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const activeLabel = THEMES.find((t) => t.id === themeId)?.label ?? themeId;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="appearance — theme, CRT, font size"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color: "var(--wb-accent)",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{ color: "var(--wb-accent)" }}>◑</span>
        {activeLabel}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 22,
            left: 0,
            zIndex: 200,
            minWidth: 196,
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: "8px 0",
            font: "11px var(--wb-mono)",
          }}
        >
          <SectionLabel>theme</SectionLabel>
          {THEMES.map((t) => (
            <Row key={t.id} onClick={() => setThemeId(t.id)}>
              <Swatch color={t.tokens.accent} />
              <span style={{ color: "var(--wb-text)", flex: 1 }}>{t.label}</span>
              {t.id === themeId && <span style={{ color: "var(--wb-accent)" }}>✓</span>}
            </Row>
          ))}

          <Divider />
          <Row onClick={() => toggleCrt()}>
            <span style={{ color: crt ? "var(--wb-accent)" : "var(--wb-textFaint)" }}>
              {crt ? "▣" : "▢"}
            </span>
            <span style={{ color: "var(--wb-text)", flex: 1 }}>CRT overlay</span>
          </Row>

          <Divider />
          <SectionLabel>font size</SectionLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 12px 2px",
            }}
          >
            <StepButton label="smaller" onClick={() => setFontScale(fontScale - 0.1)}>
              −
            </StepButton>
            <button
              type="button"
              onClick={() => resetFontScale()}
              title="reset to 100%"
              style={{
                flex: 1,
                background: "transparent",
                border: "1px solid var(--wb-border)",
                color: "var(--wb-textDim2)",
                font: "11px var(--wb-mono)",
                cursor: "pointer",
                padding: "2px 0",
              }}
            >
              {Math.round(fontScale * 100)}%
            </button>
            <StepButton label="larger" onClick={() => setFontScale(fontScale + 0.1)}>
              +
            </StepButton>
          </div>
          <div
            style={{
              color: "var(--wb-textFaint)",
              padding: "4px 12px 0",
              fontSize: 10,
            }}
          >
            tip: Ctrl + mouse wheel
          </div>

          <Divider />
          <Row
            onClick={() => {
              setOpen(false);
              runCommand("openKeymapEditor");
            }}
          >
            <span style={{ color: "var(--wb-textFaint)" }}>⌨</span>
            <span style={{ color: "var(--wb-text)", flex: 1 }}>keyboard shortcuts…</span>
          </Row>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "var(--wb-textFaint)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontSize: 9.5,
        padding: "2px 12px 4px",
      }}
    >
      {children}
    </div>
  );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
        cursor: "pointer",
        background: hover ? "var(--wb-sel)" : "transparent",
      }}
    >
      {children}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 11,
        height: 11,
        flex: "0 0 11px",
        background: color,
        border: "1px solid rgba(0,0,0,0.4)",
      }}
    />
  );
}

function StepButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 22,
        background: "transparent",
        border: "1px solid var(--wb-border)",
        color: "var(--wb-text)",
        font: "12px var(--wb-mono)",
        cursor: "pointer",
        padding: "1px 0",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />;
}

export default AppearanceMenu;
