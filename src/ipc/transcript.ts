// Typed access to the transcript-tailing stream (step 3.1). The Rust backend
// follows each live session's `~/.claude/projects/<…>/<session-id>.jsonl`, reads
// the latest turn's `usage` (the current context-window components), and emits a
// `usage-updated` event per instance as it changes. The usage engine
// (`state/usage`) folds these onto the registry store so the rail card and console
// header show context-window occupancy live — matching Claude Code's `/context`.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A live token update for one instance: the latest turn's usage. The context
 *  window is `inputTokens + cacheCreationTokens + cacheReadTokens`; it shrinks
 *  after a `/compact` or `/clear`. */
export interface UsageUpdate {
  instanceId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Subscribe to per-instance token updates. Returns an unlisten function. */
export function onUsageUpdate(cb: (update: UsageUpdate) => void): Promise<UnlistenFn> {
  return listen<UsageUpdate>("usage-updated", (event) => cb(event.payload));
}
