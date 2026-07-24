// Git-panel value module — the status glyph + colour maps, the relative-date
// formatter, and the shared style objects every tab draws with. Sibling of
// `rows.tsx`, which holds the components: they're split because a module that
// exports both components and non-literal constants breaks React fast refresh
// (`react-refresh/only-export-components`).

import type { CSSProperties } from "react";

/** `DiffFile.status` → its one-char glyph (the Diff-panel vocabulary). */
export const STATUS_GLYPH: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  typechange: "T",
  untracked: "?",
};

/** Colour for a `DiffFile.status` word. */
export function statusColor(status: string): string {
  if (status === "added" || status === "untracked") return "var(--wb-done)";
  if (status === "deleted") return "var(--wb-needs)";
  if (status === "modified") return "var(--wb-working)";
  return "var(--wb-textDim2)";
}

/** Colour for a porcelain `XY` status char. `U` is the conflict marker (G6), and
 *  gets the "needs you" token — an unmerged file is the one thing in the working
 *  tree that can't be left alone. */
export function statusCharColor(ch: string): string {
  if (ch === "U" || ch === "!") return "var(--wb-needs)";
  if (ch === "A" || ch === "?") return "var(--wb-done)";
  if (ch === "D") return "var(--wb-needs)";
  if (ch === "M" || ch === "R" || ch === "C") return "var(--wb-working)";
  return "var(--wb-textDim2)";
}

/**
 * A porcelain unmerged `XY` pair in plain words (G6). The pair is the only place
 * the *shape* of a conflict is recorded — whether there's even a "theirs" side to
 * take — so the panel says it out loud instead of showing two cryptic chars.
 */
export function conflictLabel(index: string, worktree: string): string {
  switch (`${index}${worktree}`) {
    case "UU":
      return "both modified";
    case "AA":
      return "both added";
    case "DD":
      return "both deleted";
    case "AU":
      return "added by us";
    case "UA":
      return "added by them";
    case "DU":
      return "deleted by us";
    case "UD":
      return "deleted by them";
    default:
      return "conflicted";
  }
}

/** Compact relative date from an epoch-seconds timestamp ("3d", "2h", "5m", "now"). */
export function relativeDate(epochSeconds: number): string {
  if (!epochSeconds) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** A readable absolute date for the commit-detail pane (G7). Relative ages are
 *  right on a list of two hundred rows; the one commit you've opened is the place
 *  the actual date belongs — "3mo" is not an answer to "when did this land". */
export function absoluteDate(epochSeconds: number): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The small right-aligned action on a `SectionHead`. */
export const miniActionStyle: CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--wb-textDim2)",
  font: "9.5px var(--wb-mono)",
  textTransform: "none",
  letterSpacing: 0,
  padding: 0,
};

/** A row in the header's `⋯` overflow menu (G2). Left-aligned and full-width so
 *  the labels line up as a list rather than sitting like buttons in a box. */
export const menuItemStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  textAlign: "left",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

export const inputStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-borderActive)",
  padding: "7px 9px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
  outline: "none",
};

export const confirmButtonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};
