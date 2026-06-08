// Panel — the box-drawing chrome primitive (§5.x). A thin square-cornered border
// with a terminal-style title chip that *breaks* the top edge, e.g.
// `╭─ console · invoice-fix ─────╮`. No rounded corners, shadows, or gradients.
// Every dockable panel (Console, Shell, Editor, …) wraps its body in this so the
// whole app reads as one continuous terminal surface.

import type { CSSProperties, ReactNode } from "react";
import { GLYPH } from "./glyphs";

interface PanelProps {
  /** Title shown in the chip on the top border (uppercased by the chrome). */
  title: ReactNode;
  /** Optional content pinned to the top-right border (status, badges, actions). */
  right?: ReactNode;
  /** Render the title in the accent color (e.g. the focused console). */
  accent?: boolean;
  /** Panel body. */
  children?: ReactNode;
  /** Style overrides for the outer frame (sizing, flex, margins). */
  style?: CSSProperties;
  /** Style overrides for the inner body wrapper (e.g. reset padding). */
  bodyStyle?: CSSProperties;
}

function Panel({ title, right, accent, children, style, bodyStyle }: PanelProps) {
  return (
    <div
      style={{
        position: "relative",
        border: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        ...style,
      }}
    >
      {/* Title chip — absolutely positioned to sit astride the top border. The
          opaque background masks the border line so the text appears to break it. */}
      <div
        style={{
          position: "absolute",
          top: -8,
          left: 14,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 16,
          padding: "0 7px",
          background: "var(--wb-panel)",
          whiteSpace: "nowrap",
          font: "600 10.5px var(--wb-mono)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          zIndex: 1,
          color: accent ? "var(--wb-accent)" : "var(--wb-textDim2)",
        }}
      >
        <span style={{ color: "var(--wb-borderActive)" }}>{GLYPH.cornerTL}</span>
        {title}
      </div>

      {right && (
        <div
          style={{
            position: "absolute",
            top: -8,
            right: 12,
            height: 16,
            padding: "0 6px",
            background: "var(--wb-panel)",
            display: "flex",
            alignItems: "center",
            whiteSpace: "nowrap",
            zIndex: 1,
          }}
        >
          {right}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1, ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}

export default Panel;
