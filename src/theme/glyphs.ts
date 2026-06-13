// Status glyphs & spinner — the text-glyph vocabulary of the retro chrome (§5.x).
// Status is shown as monospace glyphs, never graphical icons, so the chrome reads
// like terminal output. Colors come from the status tokens in `tokens.ts`.

import type { ThemeTokens } from "./tokens";

/**
 * Lifecycle status of an instance/agent. Drives the rail dot, console header,
 * and (Phase 2) the hook-fed status state machine. `working` additionally shows
 * the animated spinner instead of a static glyph.
 */
export type Status = "working" | "needs" | "done" | "closed";

/** The static status glyph per state (the spinner replaces `working` when live). */
export const STATUS_GLYPH: Record<Status, string> = {
  working: "◐",
  needs: "●",
  done: "○",
  closed: "−",
};

/** The theme token each status maps to — both the glyph color and its accent. */
export const STATUS_TOKEN: Record<Status, keyof ThemeTokens> = {
  working: "working",
  needs: "needs",
  done: "done",
  closed: "closed",
};

/** `var(--wb-…)` reference for a status color, for inline styles. */
export function statusColorVar(status: Status): string {
  return `var(--wb-${STATUS_TOKEN[status]})`;
}

/**
 * Misc box-drawing / status glyphs used across the chrome, named so call sites
 * read clearly rather than scattering raw Unicode. (§5.x: `● ◐ ○ ⑃ ▸ ✓ ✗`.)
 */
export const GLYPH = {
  worktree: "⑃",
  run: "▸",
  ok: "✓",
  fail: "✗",
  prompt: "›",
  agent: "▸",
  queue: "◷",
  mcp: "◈",
  cornerTL: "╭─",
  warn: "⚠",
  remote: "⇄",
} as const;

/**
 * Braille spinner frames — the CLI-style working animation (§5.x). Advance one
 * frame per `SPINNER_INTERVAL_MS` while a card is working.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

/** Frame cadence for `SPINNER_FRAMES`, in milliseconds. */
export const SPINNER_INTERVAL_MS = 90;
