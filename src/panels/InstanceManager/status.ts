// Maps the persisted `InstanceStatus` (idle | working | needs_you | done |
// closed) to the retro status vocabulary (§5.x): a text glyph, a theme color,
// and a label. Step 1.4 rendered these as static placeholders; step 2.2 adds
// `mergeStatus`, which overlays the **live** hook-driven status and the console's
// PTY lifecycle on top of the placeholder to produce the dot the rail actually
// shows.
//
// The status palette doubles as the UI accent system: ● needs you = magenta ·
// ⠹/◐ working = amber · ○ done/idle = green · · closed = grey. `idle` shares the
// green "done/idle" glyph per the §4.4 mapping.

import { GLYPH } from "../../theme";
import type { InstanceStatus } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import type { LiveStatus } from "../../state/status";

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

/** The unified status a rail row (and its counts) should render, after merging
 *  the three sources of truth: the PTY lifecycle, the live hook status, and the
 *  persisted placeholder. */
export interface CardStatusView {
  /** Glyph to show when not spinning. */
  glyph: string;
  colorVar: string;
  /** Short label (tooltip / a11y). */
  label: string;
  /** Render the working spinner instead of `glyph`. */
  spinning: boolean;
  /** This card is awaiting you — drives the badge and the "N need you" counts. */
  needsYou: boolean;
  /** Active subagents, for the nested spinner (>0 shows the ↳ line). */
  subagents: number;
  /** Context is being compacted (a transient working sub-state). */
  compacting: boolean;
  /** Live activity stamp (epoch s) when hook-driven, else null (use persisted). */
  liveAt: number | null;
}

const BLANK = {
  spinning: false,
  needsYou: false,
  subagents: 0,
  compacting: false,
  liveAt: null as number | null,
};

/**
 * Merge the PTY lifecycle (`consoleStatus`), the live hook status (`live`), and
 * the persisted placeholder (`persisted`) into the single status the rail shows.
 *
 * Precedence: a launching/failed PTY wins (it's the most immediate truth); then
 * the live hook signal (the real "what's the agent doing"); then a running PTY
 * with no hook signal yet; finally the persisted placeholder for dormant rows.
 */
export function mergeStatus(
  consoleStatus: ConsoleStatus | null,
  live: LiveStatus | null,
  persisted: InstanceStatus,
): CardStatusView {
  // 1. Console lifecycle: launching or failed is the most immediate truth.
  if (consoleStatus === "spawning") {
    return { ...BLANK, glyph: "", colorVar: "var(--wb-working)", label: "launching", spinning: true };
  }
  if (consoleStatus === "error") {
    return { ...BLANK, glyph: GLYPH.fail, colorVar: "var(--wb-needs)", label: "error" };
  }

  // 2. Live hook status — the heart of the rail (design §4.4).
  if (live && live.phase !== "ended") {
    const liveAt = live.updatedAt;
    const subagents = live.subagents;
    // The compaction overlay reads as "busy" regardless of the underlying phase.
    if (live.compacting) {
      return { ...BLANK, glyph: "◐", colorVar: "var(--wb-working)", label: "compacting…", spinning: true, compacting: true, subagents, liveAt };
    }
    switch (live.phase) {
      case "working":
        return { ...BLANK, glyph: "◐", colorVar: "var(--wb-working)", label: "working", spinning: true, subagents, liveAt };
      case "needs_you":
        return { ...BLANK, glyph: "●", colorVar: "var(--wb-needs)", label: "needs you", needsYou: true, liveAt };
      case "done":
        return { ...BLANK, glyph: "○", colorVar: "var(--wb-done)", label: "done", liveAt };
      case "idle":
        return { ...BLANK, glyph: "○", colorVar: "var(--wb-done)", label: "idle", liveAt };
    }
  }

  // 3. A running console with no hook signal yet (just launched / between turns).
  if (consoleStatus === "running") {
    return { ...BLANK, glyph: GLYPH.run, colorVar: "var(--wb-accent)", label: "running" };
  }

  // 4. Dormant / no console: the persisted placeholder.
  const d = statusDisplay(persisted);
  return { ...BLANK, glyph: d.glyph, colorVar: d.colorVar, label: d.label, spinning: d.working };
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
