// Consoles store (step 1.5) — the runtime (non-persisted) registry of *open*
// Claude consoles. Distinct from the SQLite-backed `registry` store: an instance
// row is a saved config that always exists; a console is the live PTY+terminal
// you launch for it. Clicking an instance opens (or focuses) its console; closing
// a console stops its PTY while the row survives, so re-opening relaunches a fresh
// `claude` session.
//
// A tiny external store exposed to React via `useSyncExternalStore`, mirroring the
// shape of `state/registry`. State here is intentionally ephemeral — it's the set
// of what's running *now*, rebuilt each launch.

import { useSyncExternalStore } from "react";
import type { SpawnKind, SpawnResult } from "../ipc/pty";
import type { Instance } from "../ipc/registry";
import { updateInstance } from "./registry";

/** Browsers cap live WebGL contexts (~16); we reserve a margin (design §5 /
 *  decision 14). The first `WEBGL_CAP` consoles render via WebGL; the rest fall
 *  back to xterm's DOM renderer. Invisible in practice at this workflow's scale. */
export const WEBGL_CAP = 10;

export type ConsoleStatus = "spawning" | "running" | "error";

export interface ConsoleSession {
  instanceId: string;
  /** Resolved working directory the PTY launched in. */
  cwd: string;
  kind: SpawnKind;
  /** Whether this console claimed a WebGL renderer slot (sticky for its life). */
  webgl: boolean;
  status: ConsoleStatus;
  /** Minted session UUID, known once the spawn resolves. */
  sessionId: string | null;
  /** Spawn failure message, when `status === "error"`. */
  error: string | null;
  /** Monotonic focus stamp; the active console has the highest. */
  focusSeq: number;
}

interface ConsolesState {
  /** Open consoles in launch order (stable render order for the grid). */
  open: ConsoleSession[];
  /** The focused console, or null when none are open. */
  activeId: string | null;
}

let state: ConsolesState = { open: [], activeId: null };
let focusSeq = 0;
const listeners = new Set<() => void>();

function emit(next: ConsolesState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ConsolesState {
  return state;
}

function patchSession(
  instanceId: string,
  patch: Partial<ConsoleSession>,
): void {
  const open = state.open.map((c) =>
    c.instanceId === instanceId ? { ...c, ...patch } : c,
  );
  emit({ ...state, open });
}

/**
 * Open the console for `instance`, or focus it if already open. A fresh console
 * starts in `spawning`; the hosting component drives the PTY and reports back via
 * `markSpawned` / `markError`.
 */
export function openConsole(instance: Instance): void {
  const existing = state.open.find((c) => c.instanceId === instance.id);
  if (existing) {
    focusConsole(instance.id);
    return;
  }
  const webglInUse = state.open.filter((c) => c.webgl).length;
  const session: ConsoleSession = {
    instanceId: instance.id,
    cwd: instance.workingDir,
    kind: "claude",
    webgl: webglInUse < WEBGL_CAP,
    status: "spawning",
    sessionId: null,
    error: null,
    focusSeq: ++focusSeq,
  };
  emit({ open: [...state.open, session], activeId: instance.id });
}

/** Make `instanceId` the focused console (no-op if it isn't open). */
export function focusConsole(instanceId: string): void {
  if (!state.open.some((c) => c.instanceId === instanceId)) return;
  patchSessionFocus(instanceId);
  if (state.activeId !== instanceId) emit({ ...state, activeId: instanceId });
}

function patchSessionFocus(instanceId: string): void {
  patchSession(instanceId, { focusSeq: ++focusSeq });
}

/**
 * Record a successful spawn: flip the console to `running` and persist the minted
 * session id onto the instance row (so a later session-restore can resume it).
 *
 * Note we deliberately do *not* update `session.cwd` here: it's a dependency of
 * the hosting terminal's effect, so mutating it would tear the PTY down and
 * respawn. The working dir is fixed for a console's lifetime.
 */
export function markSpawned(instanceId: string, result: SpawnResult): void {
  patchSession(instanceId, { status: "running", sessionId: result.sessionId });
  void updateInstance(instanceId, { lastSessionId: result.sessionId });
}

/** Record a spawn failure so the console can surface it in place. */
export function markError(instanceId: string, message: string): void {
  patchSession(instanceId, { status: "error", error: message });
}

/**
 * Close a console: drop it from the open set. Unmounting its host terminates the
 * PTY (the host's cleanup calls `ptyKill`), so the instance row survives and can
 * relaunch. Focus falls back to the most-recently-focused remaining console.
 */
export function closeConsole(instanceId: string): void {
  const open = state.open.filter((c) => c.instanceId !== instanceId);
  let activeId = state.activeId;
  if (activeId === instanceId) {
    activeId =
      open.length === 0
        ? null
        : open.reduce((a, b) => (b.focusSeq > a.focusSeq ? b : a)).instanceId;
  }
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the consoles store. */
export function useConsoles(): ConsolesState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
