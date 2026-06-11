// Small display formatters shared across panels.

import type { Instance } from "../ipc/registry";

/**
 * The instance's current **context-window occupancy** — the size of the latest
 * turn's prompt (`input + cache_creation + cache_read`), tracked live by the
 * transcript-tailing subsystem (step 3.1). This is the same figure Claude Code's
 * `/context` reports ("how full is this agent's context right now"), *not* a
 * lifetime sum — a cumulative count balloons every turn and diverges from
 * `/context`. `output` is excluded: it's the response, not part of the prompt.
 */
export function contextWindowTokens(instance: Instance): number {
  return instance.inputTokens + instance.cacheCreationTokens + instance.cacheReadTokens;
}

/** Compact token count: `0K`, `140K`, `1.5M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

/** The window and its components spelled out, for a tooltip. */
export function tokenBreakdown(instance: Instance): string {
  const f = (n: number) => n.toLocaleString();
  return (
    `context window ${f(contextWindowTokens(instance))} tokens — ` +
    `input ${f(instance.inputTokens)} · cache write ${f(instance.cacheCreationTokens)} · ` +
    `cache read ${f(instance.cacheReadTokens)}`
  );
}
