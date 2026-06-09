// Small display formatters shared across panels.

import type { Instance } from "../ipc/registry";

/**
 * Total tokens an instance has consumed — input + output + cache. Real values
 * are wired by the transcript-tailing subsystem in step 3.1; until then these
 * fields are 0. (Design §4.5 notes a single total is cache-inflated and that the
 * distinct input/output/cache split is the accurate view — 3.1 surfaces that;
 * this is the at-a-glance headline figure for the card/console header.)
 */
export function totalTokens(instance: Instance): number {
  return (
    instance.inputTokens +
    instance.outputTokens +
    instance.cacheCreationTokens +
    instance.cacheReadTokens
  );
}

/** Compact token count: `0K`, `140K`, `1.5M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}
