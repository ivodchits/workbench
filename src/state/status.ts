// Status engine (step 2.2) — the heart of feature #1.
//
// Turns the hook stream (step 2.1's `hook-event`) into live per-instance card
// status. This is a frontend external store, ephemeral by design: live status
// reflects a *running* session, so it's derived fresh from hooks and never
// persisted (a stale "working" after a restart would lie — session restore is 3.8).
//
// Precedence — only **needs-you** is sticky, and only against *tool churn*:
//   • `permission_prompt` (`PermissionRequest` / `Notification`) → ● needs you.
//     While a tool waits on your approval, a *parallel batch* keeps emitting
//     `PreToolUse`/`PostToolUse` for its other tools, which must NOT stomp the
//     pending prompt — so tool events never downgrade a needs-you.
//   • It clears the moment the agent resumes: `PostToolBatch` (the batch you
//     approved finished), `UserPromptSubmit`, `PermissionDenied`, `Stop`/`Session
//     End` — plus a time-grace fallback (a tool event > NEEDS_GRACE_MS after the
//     prompt began, in case `PostToolBatch` doesn't fire).
//   • Everything else is "latest event wins": `Stop`/`idle_prompt` → ○ done,
//     tool events → ◐ working, `PreCompact` → compacting.
//
// (Note: this deliberately departs from the original §4.4 "everything sticky"
// sketch, which assumed `idle_prompt` = needs-you and had no resume signal —
// that produced a stuck needs-you after approving and a spurious needs-you when
// idle. The event model above matches what Claude Code actually emits.)
//
// Repaints are **debounced** (~150 ms): high-frequency tool events coalesce into
// one repaint, while attention/turn-boundary transitions bypass it (instant).

import { useSyncExternalStore } from "react";
import { onHookEvent, type HookEnvelope, type HookEvent } from "../ipc/hooks";

/** One repaint per this window for debounced (tool-event) changes. Attention /
 *  turn-boundary transitions ignore it — they must be instant. */
const DEBOUNCE_MS = 150;

/** A needs-you held this long stops being protected from tool events: a tool
 *  event arriving past this since the prompt began means the agent has resumed
 *  (you approved) even if `PostToolBatch` didn't fire. Comfortably longer than the
 *  ms-scale gap between a permission prompt and its batch's trailing events. */
const NEEDS_GRACE_MS = 1500;

/** Live phase of a card, driven by the hook stream. Distinct from the persisted
 *  `InstanceStatus`: this only exists while a session is running. */
export type StatusPhase =
  | "idle" // session live, nothing happening yet (post-SessionStart / between turns)
  | "working" // ◐ actively doing work
  | "needs_you" // ● awaiting you (permission prompt)
  | "done" // ○ finished its turn, your move
  | "ended"; // session closed

export interface LiveStatus {
  phase: StatusPhase;
  /** Compaction overlay (PreCompact→PostCompact). Orthogonal to `phase` so a
   *  mid-work compaction returns cleanly to whatever the agent was doing; any
   *  later event clears it, so it can't get stuck. */
  compacting: boolean;
  /** Active subagents (SubagentStart − SubagentStop), for the nested spinner. */
  subagents: number;
  /** Epoch seconds of the last event that touched this card (live "ago"). */
  updatedAt: number;
  /** When the current needs-you began (epoch s), for the grace fallback; null
   *  whenever the phase isn't needs-you. */
  needsSince: number | null;
  /** The hook event that produced the current phase (tooltip/debug). */
  reason: string | null;
}

interface Reduction {
  entry: LiveStatus;
  /** True → bypass the debounce and repaint now (attention/turn-boundary). */
  instant: boolean;
}

/**
 * Classify a `Notification` event by its `notification_type` (design/docs): only a
 * permission prompt is the ● needs-you alarm; an idle prompt is just ○ your-move.
 * Falls back to sniffing `message` for clients that don't send the type.
 */
function notificationPhase(event: HookEvent): StatusPhase | null {
  const type = typeof event.notification_type === "string" ? event.notification_type : "";
  if (type === "permission_prompt") return "needs_you";
  if (type === "idle_prompt") return "done";
  if (type) return null; // auth_success / elicitation_* → not a status change
  const msg = typeof event.message === "string" ? event.message.toLowerCase() : "";
  if (msg.includes("permission")) return "needs_you";
  if (msg.includes("waiting for")) return "done";
  return null;
}

/**
 * Pure state transition: fold one hook event into the prior card status. Exported
 * so the precedence rules — the painful-to-retrofit part — are reasoned about (and
 * testable) in isolation from the store plumbing.
 */
export function reduceStatus(
  prev: LiveStatus | undefined,
  event: HookEvent,
  at: number,
): Reduction {
  const base: LiveStatus = prev ?? {
    phase: "idle",
    compacting: false,
    subagents: 0,
    updatedAt: at,
    needsSince: null,
    reason: null,
  };
  const name = event.hook_event_name ?? "";
  const needsYou = base.phase === "needs_you";

  // Transition to `phase`, auto-managing `needsSince` (set on entry into needs-you,
  // preserved while it persists, else cleared) and clearing the compaction overlay
  // (any real event means compaction is over).
  const to = (phase: StatusPhase, instant: boolean, extra: Partial<LiveStatus> = {}): Reduction => ({
    entry: {
      ...base,
      ...extra,
      phase,
      compacting: false,
      updatedAt: at,
      reason: name || base.reason,
      needsSince: phase === "needs_you" ? (needsYou ? base.needsSince : at) : null,
    },
    instant,
  });
  // No observable change — return the prior entry so the store can skip a repaint.
  const keep = (): Reduction => ({ entry: base, instant: false });

  // A *new tool is starting* (PreToolUse): genuine new work. This is the one tool
  // signal allowed to wake a resting "done" — a new tool only starts when there's
  // work to do, whereas the stragglers that land after `Stop` are completions
  // (PostToolUse / PostToolBatch), never starts. A held needs-you clears once past
  // the grace window (you approved and work moved on).
  const startWork = (): Reduction => {
    if (needsYou && !graceElapsed(base, at)) return keep();
    return to("working", false);
  };
  // A tool/subagent *finished* (a completion): must never reanimate a resting state
  // (that's the done→working→done flicker). It only advances active states and
  // updates the subagent count under a held needs-you.
  const finishWork = (extra: Partial<LiveStatus> = {}): Reduction => {
    if (base.phase === "done") return keep();
    if (needsYou && !graceElapsed(base, at)) {
      // Hold the needs-you; only repaint if the subagent count changed, so the
      // "ago" stays anchored to when you were first asked.
      return Object.keys(extra).length > 0 ? to("needs_you", false, extra) : keep();
    }
    return to("working", false, extra);
  };

  switch (name) {
    // --- turn boundaries (instant) ------------------------------------------
    case "SessionStart":
      return to("idle", true, { subagents: 0 });
    case "SessionEnd":
      return to("ended", true, { subagents: 0 });

    // --- you acted (instant): start a new turn, clearing any resting state ---
    case "UserPromptSubmit":
    case "PermissionDenied": // auto-classifier denial; the turn continues
      return to("working", true);

    // --- attention / end-of-turn (instant) ----------------------------------
    case "PermissionRequest":
      return to("needs_you", true);
    case "Stop":
    case "StopFailure":
      return to("done", true, { subagents: 0 });
    case "Notification": {
      const phase = notificationPhase(event);
      if (!phase) return keep();
      // An idle notification must never downgrade a pending permission prompt.
      if (phase === "done" && needsYou) return keep();
      return to(phase, true);
    }

    // --- the gated batch resolved → the only signal that an *approval* let work
    // resume (no dedicated event fires on approve). Clears needs-you; never wakes
    // a resting "done".
    case "PostToolBatch":
      return needsYou ? to("working", true) : keep();

    // --- tool / subagent churn (debounced) ----------------------------------
    case "PreToolUse":
      return startWork(); // new tool → may resume a resting "done"
    case "PostToolUse":
    case "PostToolUseFailure":
      return finishWork(); // completion → never wakes a resting state
    case "SubagentStart":
      return finishWork({ subagents: base.subagents + 1 });
    case "SubagentStop":
      return finishWork({ subagents: Math.max(0, base.subagents - 1) });

    // --- compaction overlay (instant so a quick compaction still paints) -----
    case "PreCompact":
      return base.compacting
        ? keep()
        : { entry: { ...base, compacting: true, updatedAt: at, reason: name }, instant: true };
    case "PostCompact":
      // Compaction finished → your move (○). `/compact` rides in on a UserPromptSubmit
      // that set "working", so just clearing the overlay would strand it on working;
      // a genuine mid-turn auto-compaction resumes via the next PreToolUse (which
      // wakes done). Only act if we were actually compacting.
      return base.compacting ? to("done", true) : keep();

    default:
      // Unknown/other event: no status change.
      return keep();
  }
}

/** True once a needs-you has outlived the grace window (so a tool event past it
 *  should be read as the agent having resumed after you approved). */
function graceElapsed(s: LiveStatus, at: number): boolean {
  return s.needsSince != null && at - s.needsSince > NEEDS_GRACE_MS / 1000;
}

// --- transition listeners ---------------------------------------------------
// Called synchronously when a card's phase changes (before the React flush).
// Used to drive OS notifications without polling the store.

type TransitionListener = (
  instanceId: string,
  phase: StatusPhase,
  prevPhase: StatusPhase | null,
) => void;

const transitionListeners = new Set<TransitionListener>();

/** Subscribe to phase transitions (any direction). Returns an unsubscribe fn.
 *  Idempotent: calling subscribe twice with the same reference is a no-op. */
export function onStatusTransition(cb: TransitionListener): () => void {
  transitionListeners.add(cb);
  return () => {
    transitionListeners.delete(cb);
  };
}

// --- store ------------------------------------------------------------------
// `latest` is the authoritative state, updated synchronously on every event.
// `committed` is what React sees via getSnapshot; it only advances on a flush
// (instant, or the debounce timer firing), which is how repaints coalesce.

let latest: ReadonlyMap<string, LiveStatus> = new Map();
let committed = latest;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function flushNow(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  committed = latest;
  notify();
}

function scheduleFlush(): void {
  // A timer already pending will pick up whatever `latest` holds when it fires —
  // that's the coalescing. (No per-card timers: one batched repaint per window is
  // strictly cheaper than the §4.4 "per card" budget and visually identical.)
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    committed = latest;
    notify();
  }, DEBOUNCE_MS);
}

/** Fold one accepted hook event into the store. */
export function ingestHookEvent(envelope: HookEnvelope): void {
  const { instanceId, receivedAt, event } = envelope;
  const prev = latest.get(instanceId);
  const { entry, instant } = reduceStatus(prev, event, receivedAt);
  if (entry === prev) return; // no observable change (e.g. tool churn under needs-you)
  const next = new Map(latest);
  next.set(instanceId, entry);
  latest = next;
  // Notify transition listeners synchronously on any phase change. `keep()`
  // returns the same object reference, so this only fires on real transitions.
  if (entry.phase !== prev?.phase) {
    for (const l of transitionListeners) l(instanceId, entry.phase, prev?.phase ?? null);
  }
  if (instant) flushNow();
  else scheduleFlush();
}

/**
 * Optimistically mark an instance "done" because *you* interrupted it (Esc /
 * Ctrl+C / the rail interrupt action). Interrupting fires no hook we can observe,
 * so without this the dot would sit on ◐ working forever. If the interrupt didn't
 * actually stop the turn, the agent's next `PreToolUse` legitimately wakes it back
 * to working (see the reducer), so this is safe to apply eagerly.
 */
export function markInterrupted(instanceId: string): void {
  const prev = latest.get(instanceId);
  if (prev && prev.phase === "ended") return; // session's gone; nothing to interrupt
  const entry: LiveStatus = {
    phase: "done",
    compacting: false,
    subagents: 0,
    updatedAt: Math.floor(Date.now() / 1000),
    needsSince: null,
    reason: "interrupt",
  };
  const next = new Map(latest);
  next.set(instanceId, entry);
  latest = next;
  flushNow();
}

/** Drop a card's live status (on console close / instance kill), so the row falls
 *  back to its persisted placeholder immediately rather than holding stale state. */
export function clearLiveStatus(instanceId: string): void {
  if (!latest.has(instanceId)) return;
  const next = new Map(latest);
  next.delete(instanceId);
  latest = next;
  flushNow();
}

/**
 * Start consuming the hook stream. Idempotent and **never torn down**: the hook
 * stream lives for the whole app session, so a single permanent subscription is
 * correct — and tracking the subscription as a stored promise (rather than a
 * boolean we'd reset on cleanup) sidesteps React StrictMode's double mount, which
 * would otherwise double-process every event (e.g. double-counting subagents).
 */
let subscription: Promise<unknown> | null = null;
export function initStatusEngine(): void {
  if (subscription) return;
  // Swallow a non-Tauri host (e.g. `vite preview` in a plain browser) or a bridge
  // that failed to start: live status just won't update, app import still works.
  subscription = onHookEvent(ingestHookEvent).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ReadonlyMap<string, LiveStatus> {
  return committed;
}

/** Read live status outside React (e.g. keyboard-command handlers). */
export function getLiveStatuses(): ReadonlyMap<string, LiveStatus> {
  return committed;
}

/** Subscribe a component to the live status map (keyed by instance id). */
export function useLiveStatuses(): ReadonlyMap<string, LiveStatus> {
  return useSyncExternalStore(subscribe, getSnapshot);
}
