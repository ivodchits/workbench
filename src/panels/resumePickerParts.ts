// The resume picker's shared pieces that aren't components (fleet plan F9.4: the
// remote picker in `RemoteSessionDialogs` uses them too).

import type { CSSProperties } from "react";

import type { StatusPhase } from "../state/status";

/** Phase → status glyph + color for the instance list (mirrors the rail palette). */
export function phaseDot(phase: StatusPhase | undefined): { glyph: string; color: string } | null {
  switch (phase) {
    case "working":
      return { glyph: "◐", color: "var(--wb-working)" };
    case "needs_you":
      return { glyph: "●", color: "var(--wb-needs)" };
    case "done":
      return { glyph: "○", color: "var(--wb-done)" };
    default:
      return null;
  }
}

export function ago(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const searchStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-borderActive)",
  padding: "8px 10px",
  fontFamily: "var(--wb-mono)",
  fontSize: 13,
  outline: "none",
};

export const hintRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  borderTop: "1px solid var(--wb-border)",
  paddingTop: 9,
  font: "10px var(--wb-mono)",
  color: "var(--wb-textFaint)",
};

export const warnRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  borderTop: "1px solid var(--wb-border)",
  paddingTop: 9,
  font: "11px var(--wb-mono)",
  color: "var(--wb-text)",
};

export const confirmBtnStyle: CSSProperties = {
  font: "11px var(--wb-mono)",
  color: "var(--wb-needs)",
  background: "transparent",
  border: "1px solid var(--wb-needs)",
  borderRadius: 3,
  padding: "3px 9px",
  cursor: "pointer",
};

export const cancelBtnStyle: CSSProperties = {
  font: "11px var(--wb-mono)",
  color: "var(--wb-textDim2)",
  background: "transparent",
  border: "1px solid var(--wb-border)",
  borderRadius: 3,
  padding: "3px 9px",
  cursor: "pointer",
};
