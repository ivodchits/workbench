// Prompt queue (step 3.5, design §7) — a follow-up prompt parked for an instance,
// auto-sent the instant the agent finishes its turn (the `Stop` hook → live phase
// "done"). Unlike Claude Code's own native queue (type into a focused TUI while it
// works, sent at the next model yield), this is an app-level queue: you can leave a
// prompt for a *backgrounded* agent you aren't watching, it's **visible** on the
// card and **cancelable** until it fires, and it sends on a precise turn boundary.
//
// This module is the pure data store only — a single queued prompt per instance
// (queueing again replaces it; project decision). The *delivery* (paste + submit on
// the Stop transition, or immediately when the agent is already at rest) lives in
// the panel layer (`QueuePromptDialog` host + `submitToTerminal`), so the state
// layer stays free of terminal/IPC coupling.
//
// Transient by design: never persisted. A queued prompt only makes sense against a
// live console, so it doesn't survive a restart (there'd be nothing to send into).

import { useSyncExternalStore } from "react";

export interface QueuedPrompt {
  instanceId: string;
  /** The prompt text, exactly as typed (multi-line safe — sent as a bracketed paste). */
  text: string;
  /** Epoch ms when queued (for display / ordering). */
  createdAt: number;
}

let queue: ReadonlyMap<string, QueuedPrompt> = new Map();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Park `text` for `instanceId`, replacing any prompt already queued for it. */
export function setQueued(instanceId: string, text: string): void {
  const next = new Map(queue);
  next.set(instanceId, { instanceId, text, createdAt: Date.now() });
  queue = next;
  notify();
}

/** Drop the queued prompt for `instanceId` (cancel, or after it fires). No-op if none. */
export function cancelQueued(instanceId: string): void {
  if (!queue.has(instanceId)) return;
  const next = new Map(queue);
  next.delete(instanceId);
  queue = next;
  notify();
}

/** Read a queued prompt outside React (the Stop-transition firing path). */
export function getQueued(instanceId: string): QueuedPrompt | undefined {
  return queue.get(instanceId);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ReadonlyMap<string, QueuedPrompt> {
  return queue;
}

/** Subscribe a component to the queue map (keyed by instance id). */
export function useQueued(): ReadonlyMap<string, QueuedPrompt> {
  return useSyncExternalStore(subscribe, getSnapshot);
}
