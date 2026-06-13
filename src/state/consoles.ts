// Consoles store (step 1.5, extended in 1.6) — the runtime registry of console
// *panels*. Distinct from the SQLite-backed `registry` store: an instance row is
// a saved config that always exists; a console is the panel you launch for it.
//
// Membership here is the source of truth that the dockview `Workspace` (1.6)
// reconciles its panels against: each entry maps 1:1 to a Console panel in the
// dock. A console can be:
//   • spawning/running/error — a live PTY+terminal,
//   • dormant — a placeholder restored from a saved layout, awaiting a relaunch.
// Dormant entries are how "reopen → same layout" works without auto-launching
// `claude`: the box returns in place, the PTY does not. Clicking it relaunches a
// fresh session; `Ctrl+Shift+R` relaunches it *resumed* (`resumeConsole`, step 3.8).
//
// A tiny external store exposed to React via `useSyncExternalStore`.

import { useSyncExternalStore } from "react";
import type { RemoteSpawn, SpawnKind, SpawnResult } from "../ipc/pty";
import type { Instance } from "../ipc/registry";
import { applyInstanceUsage, getRegistry, updateInstance } from "./registry";
import { clearLiveStatus } from "./status";
import { cancelQueued } from "./queue";
import { release } from "../panels/terminalPool";

/** Browsers cap live WebGL contexts (~16); we reserve a margin (design §5 /
 *  decision 14). The first `WEBGL_CAP` *live* consoles render via WebGL; the rest
 *  fall back to xterm's DOM renderer. Invisible in practice at this scale. */
export const WEBGL_CAP = 10;

export type ConsoleStatus = "dormant" | "spawning" | "running" | "error";

export interface ConsoleSession {
  instanceId: string;
  /** Resolved working directory the PTY launched in (empty while dormant). */
  cwd: string;
  kind: SpawnKind;
  /** Whether this console claimed a WebGL renderer slot (sticky for its life). */
  webgl: boolean;
  status: ConsoleStatus;
  /** Minted session UUID, known once the spawn resolves. */
  sessionId: string | null;
  /** When set, this console was launched to *resume* that claude session
   *  (`claude --resume <id>`, step 3.8) rather than start a fresh one — so its
   *  spawn keeps the existing context/tokens instead of zeroing them. Null for a
   *  normal fresh launch. */
  resumeSessionId: string | null;
  /** Spawn failure message, when `status === "error"`. */
  error: string | null;
  /** When set, this console drives a remote `claude` over SSH+tmux (step 3.12)
   *  rather than a local child. Null for a local instance. */
  remote: RemoteSpawn | null;
  /** Monotonic focus stamp; the active console has the highest. */
  focusSeq: number;
}

/** Build the remote launch descriptor for `instance`, or null when its project is
 *  local (step 3.12). Reads the project from the registry store for the SSH dest +
 *  remote dir; the instance carries its own tmux session name. */
function remoteSpawnFor(instance: Instance): RemoteSpawn | null {
  const project = getRegistry().projects.find((p) => p.id === instance.projectId);
  if (!project?.remoteSshDest || !instance.remoteTmuxSession) return null;
  return {
    dest: project.remoteSshDest,
    session: instance.remoteTmuxSession,
    dir: project.remoteDir ?? instance.workingDir,
  };
}

interface ConsolesState {
  /** Console panels in creation order (stable render order). */
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

/** Read the open consoles outside React (used by the Workspace's swap reconcile,
 *  which runs synchronously right after `hydrateDormant` — before React commits a
 *  render, so the hook-backed refs would still be stale). */
export function getOpenConsoles(): ConsoleSession[] {
  return state.open;
}

/** The active console id, read outside React (see `getOpenConsoles`). */
export function getActiveConsoleId(): string | null {
  return state.activeId;
}

function patchSession(instanceId: string, patch: Partial<ConsoleSession>): void {
  const open = state.open.map((c) =>
    c.instanceId === instanceId ? { ...c, ...patch } : c,
  );
  emit({ ...state, open });
}

/** Count live consoles (dormant ones hold no PTY and no renderer slot). */
function liveWebglCount(): number {
  return state.open.filter((c) => c.webgl && c.status !== "dormant").length;
}

/**
 * Open the console for `instance`, focusing it if already live, or relaunching
 * it if it was a dormant placeholder. A fresh/relaunched console starts in
 * `spawning`; the hosting panel drives the PTY and reports back via
 * `markSpawned` / `markError`.
 */
export function openConsole(instance: Instance): void {
  const existing = state.open.find((c) => c.instanceId === instance.id);
  if (existing && existing.status !== "dormant") {
    focusConsole(instance.id);
    return;
  }

  const live: Omit<ConsoleSession, "instanceId"> = {
    cwd: instance.workingDir,
    kind: "claude",
    webgl: liveWebglCount() < WEBGL_CAP,
    status: "spawning",
    sessionId: null,
    resumeSessionId: null,
    remote: remoteSpawnFor(instance),
    error: null,
    focusSeq: ++focusSeq,
  };

  if (existing) {
    // Relaunch a dormant placeholder in place — the panel already exists.
    patchSession(instance.id, live);
    emit({ ...state, activeId: instance.id });
    return;
  }

  const session: ConsoleSession = { instanceId: instance.id, ...live };
  emit({ open: [...state.open, session], activeId: instance.id });
}

/**
 * Relaunch `instance`'s console to **resume** the session it last ran
 * (`claude --resume <lastSessionId>`, step 3.8 — the `Ctrl+Shift+R` shortcut).
 *
 * Always tears down any existing console+PTY for the instance first, then opens a
 * fresh one carrying `resumeSessionId`. The full close→release→re-add (rather than
 * an in-place status flip) is deliberate: it's the proven relaunch path (see
 * worktree `relaunchLiveConsole`) — it disposes the old pooled terminal so the
 * remounted panel re-`acquire`s and actually respawns, including for a console
 * still reading "running" after its claude self-exited (no live terminal would
 * respawn from a mere status change). `release` no-ops when there's no pooled
 * terminal (a dormant placeholder), so the restored-layout case is covered too.
 *
 * The caller is responsible for the "already running → ignore" guard (the backend
 * `pty_session_live` check); this unconditionally relaunches.
 */
export function resumeConsole(instance: Instance): void {
  if (state.open.some((c) => c.instanceId === instance.id)) {
    closeConsole(instance.id);
    release(instance.id); // the only path that kills the PTY (see terminalPool)
  }
  const session: ConsoleSession = {
    instanceId: instance.id,
    cwd: instance.workingDir,
    kind: "claude",
    webgl: liveWebglCount() < WEBGL_CAP,
    status: "spawning",
    sessionId: null,
    resumeSessionId: instance.lastSessionId,
    remote: remoteSpawnFor(instance),
    error: null,
    focusSeq: ++focusSeq,
  };
  emit({ open: [...state.open, session], activeId: instance.id });
}

/**
 * Seed dormant placeholders for `instanceIds` not already open — used by the
 * Workspace to back the console panels a saved layout restores. Idempotent.
 */
export function hydrateDormant(instanceIds: string[]): void {
  const present = new Set(state.open.map((c) => c.instanceId));
  const additions = instanceIds
    .filter((id) => !present.has(id))
    .map<ConsoleSession>((instanceId) => ({
      instanceId,
      cwd: "",
      kind: "claude",
      webgl: false,
      status: "dormant",
      sessionId: null,
      resumeSessionId: null,
      remote: null,
      error: null,
      focusSeq: 0,
    }));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Make `instanceId` the focused console (no-op if not open or already active). */
export function focusConsole(instanceId: string): void {
  if (state.activeId === instanceId) return;
  if (!state.open.some((c) => c.instanceId === instanceId)) return;
  const open = state.open.map((c) =>
    c.instanceId === instanceId ? { ...c, focusSeq: ++focusSeq } : c,
  );
  emit({ open, activeId: instanceId });
}

/**
 * Record a successful spawn: flip the console to `running` and persist the minted
 * session id onto the instance row (so a later resume can continue it).
 *
 * A fresh (re)launch mints a brand-new, empty session, so its context window starts
 * at 0. We clear the previous session's token figures — both immediately in the
 * store and durably in the DB — so a re-launched console (after closing the panel or
 * restarting the app) never inherits last session's count; the tailer then refills
 * the window from the new session's first turn.
 *
 * A **resume** (`claude --resume`, step 3.8) is the opposite: it continues the same
 * session and transcript, so we keep the existing tokens (the `lastSessionId` is
 * unchanged) and skip the zeroing — the tailer keeps the window where the session
 * left off.
 *
 * Note we deliberately do *not* update `session.cwd` here: it's a dependency of
 * the hosting terminal's effect, so mutating it would tear the PTY down and
 * respawn. The working dir is fixed for a console's lifetime.
 */
export function markSpawned(instanceId: string, result: SpawnResult): void {
  const resumed = state.open.find((c) => c.instanceId === instanceId)?.resumeSessionId != null;
  patchSession(instanceId, { status: "running", sessionId: result.sessionId });
  if (resumed) return;
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  applyInstanceUsage({ instanceId, ...zero });
  void updateInstance(instanceId, { lastSessionId: result.sessionId, ...zero });
}

/** Record a spawn failure so the console can surface it in place. */
export function markError(instanceId: string, message: string): void {
  patchSession(instanceId, { status: "error", error: message });
}

/**
 * Close a console: drop it from the open set entirely (panel removed too, via
 * the Workspace reconciler). Unmounting its host terminates the PTY (the host's
 * cleanup calls `ptyKill`), so the instance row survives and can relaunch. Focus
 * falls back to the most-recently-focused remaining console.
 */
export function closeConsole(instanceId: string): void {
  if (!state.open.some((c) => c.instanceId === instanceId)) return;
  // Drop any live hook-fed status so the row doesn't hold a stale "working"/"needs
  // you" after its PTY is gone (the backend also unmaps the session, so late events
  // are filtered out — this just clears the visual immediately). (step 2.2)
  clearLiveStatus(instanceId);
  // Drop any queued follow-up prompt (step 3.5): with the PTY gone there's nothing
  // to send it into, and the Stop that would fire it will never come.
  cancelQueued(instanceId);
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
