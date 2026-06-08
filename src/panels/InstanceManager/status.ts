// Maps the persisted `InstanceStatus` (idle | working | needs_you | done |
// closed) to the retro status vocabulary (§5.x): a text glyph, a theme color,
// and a label. Step 1.4 renders these as *static placeholders* off whatever is
// stored — the hook-driven state machine that makes them live is Phase 2 (2.2).
//
// The status palette doubles as the UI accent system: ● needs you = magenta ·
// ⠹/◐ working = amber · ○ done/idle = green · · closed = grey. `idle` shares the
// green "done/idle" glyph per the §4.4 mapping.

import type { InstanceStatus } from "../../ipc/registry";

export interface StatusDisplay {
  /** Static glyph (the working spinner replaces this when live, Phase 2). */
  glyph: string;
  /** `var(--wb-…)` color reference for the glyph + accent. */
  colorVar: string;
  /** Short human label. */
  label: string;
  /** Whether this state should pulse the working spinner instead of a glyph. */
  working: boolean;
}

const TABLE: Record<InstanceStatus, StatusDisplay> = {
  idle: { glyph: "○", colorVar: "var(--wb-done)", label: "idle", working: false },
  working: { glyph: "◐", colorVar: "var(--wb-working)", label: "working", working: true },
  needs_you: { glyph: "●", colorVar: "var(--wb-needs)", label: "needs you", working: false },
  done: { glyph: "○", colorVar: "var(--wb-done)", label: "done", working: false },
  closed: { glyph: "·", colorVar: "var(--wb-closed)", label: "closed", working: false },
};

export function statusDisplay(status: InstanceStatus): StatusDisplay {
  return TABLE[status];
}

/** Compact relative time ("now", "3m", "2h", "5d") from an epoch-seconds stamp. */
export function relativeTime(epochSecs: number | null, nowMs = Date.now()): string {
  if (epochSecs == null) return "";
  const secs = Math.max(0, Math.floor(nowMs / 1000) - epochSecs);
  if (secs < 45) return "now";
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
