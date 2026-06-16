// Shells store (step 1.7) — the runtime registry of Project Shell panels. A shell
// is a free `portable-pty` child running the user's shell (`pwsh.exe` on Windows,
// `$SHELL` on Unix) in a project's root dir, for git / tests / running the app
// (design §5 Project Shell, §4.2). It's the sibling of the `consoles` store, but
// with two differences that matter:
//
//   • A console is bound 1:1 to a registry *instance* and runs `claude`; a shell
//     is bound to a *project* (its root working dir). So shells carry their own
//     minted id, not an instance id. A project can have *several* shells open at
//     once (e.g. one tied up running a debug build while another is free for git):
//     `newShell` always mints a fresh one, while `openShell` focus-or-creates for
//     the rail's "jump to a shell" affordance.
//   • A shell holds no precious session (unlike a `claude` console), so it's keyed
//     by `shellId` and freely respawned.
//
// Membership here is the authority the dockview `Workspace` reconciles its shell
// panels against, exactly as it does for consoles. A shell can be:
//   • spawning/running/error — a live PTY+terminal,
//   • dormant — a placeholder restored from a saved layout, awaiting a relaunch.
//
// The store is pure state (no IO): the hosting `Shell` panel drives the PTY via
// the terminal pool and reports back through `markShellSpawned` / `markShellError`.

import { useSyncExternalStore } from "react";

export type ShellStatus = "dormant" | "spawning" | "running" | "error";

export interface ShellSession {
  /** Minted, stable for the panel's life (also the terminal-pool + PTY key). */
  shellId: string;
  /** Project this shell belongs to (used to dedupe — one shell per project). */
  projectId: string;
  /** Resolved working directory the shell launched in (empty while dormant). */
  cwd: string;
  /** Display label — the project name. Shown in the tab + header. */
  label: string;
  status: ShellStatus;
  /** Spawn failure message, when `status === "error"`. */
  error: string | null;
  /** When true, this shell has been torn off into its own OS window (step 4.2):
   *  its PTY stays live but the panel is gone from the main dock. The Workspace
   *  reconciler skips it until it docks back. */
  tornOff?: boolean;
}

/** Where a shell points: a project's root dir, with a display label. */
export interface ShellTarget {
  projectId: string;
  cwd: string;
  label: string;
}

interface ShellsState {
  /** Shell panels in creation order (stable render order). */
  open: ShellSession[];
  /** The shell to bring to front, or null. Only a *new* value triggers focus in
   *  the Workspace reconciler, so a status repaint never steals focus. */
  activeId: string | null;
}

let state: ShellsState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: ShellsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ShellsState {
  return state;
}

function patchShell(shellId: string, patch: Partial<ShellSession>): void {
  const open = state.open.map((s) => (s.shellId === shellId ? { ...s, ...patch } : s));
  emit({ ...state, open });
}

/** Read the open shells outside React (used by the Workspace's persist path,
 *  which runs in a dockview callback and must not close over a stale snapshot). */
export function getOpenShells(): ShellSession[] {
  return state.open;
}

/** The active shell id, read outside React (see `getOpenShells`). */
export function getActiveShellId(): string | null {
  return state.activeId;
}

/**
 * Open *a* shell for `target`'s project. If one is already open for that project,
 * focus it (relaunching it first if it was a dormant placeholder) rather than
 * piling up duplicates; otherwise mint a fresh one in `spawning`. This is the
 * "jump to a shell" path (the rail's prompt button) — use `newShell` to always
 * spawn an additional one.
 */
export function openShell(target: ShellTarget): void {
  const existing = state.open.find((s) => s.projectId === target.projectId);
  if (existing) {
    if (existing.status === "dormant") {
      patchShell(existing.shellId, { ...target, status: "spawning", error: null });
    }
    emit({ ...state, activeId: existing.shellId });
    return;
  }
  newShell(target);
}

/**
 * Mint a fresh shell for `target`'s project and focus it — even when one is
 * already open. This is the "give me another shell" path (the New-Shell command):
 * a project can hold several, e.g. one busy running a debug build while another
 * stays free for git. The caller is responsible for a distinguishing `label`.
 */
export function newShell(target: ShellTarget): void {
  const shellId = `shell:${crypto.randomUUID()}`;
  const session: ShellSession = { shellId, ...target, status: "spawning", error: null };
  emit({ open: [...state.open, session], activeId: shellId });
}

/** A persisted shell: its target/label plus the minted id, so a restored panel
 *  re-binds to the same store entry. */
export interface ShellDescriptor extends ShellTarget {
  shellId: string;
}

/**
 * Seed dormant placeholders for `descriptors` not already open — used by the
 * Workspace to back the shell panels a saved layout restores (the box returns in
 * place, the PTY does not, until you relaunch it). Idempotent.
 */
export function hydrateShells(descriptors: ShellDescriptor[]): void {
  const present = new Set(state.open.map((s) => s.shellId));
  const additions = descriptors
    .filter((d) => !present.has(d.shellId))
    .map<ShellSession>((d) => ({
      shellId: d.shellId,
      projectId: d.projectId,
      cwd: d.cwd,
      label: d.label,
      status: "dormant",
      error: null,
    }));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Relaunch a dormant/errored shell in place — the panel already exists. */
export function relaunchShell(shellId: string): void {
  patchShell(shellId, { status: "spawning", error: null });
}

/** Record a successful spawn: flip the shell to `running`. */
export function markShellSpawned(shellId: string): void {
  patchShell(shellId, { status: "running" });
}

/**
 * Flag/unflag a shell as torn off into its own OS window (step 4.2). Mirrors
 * `setConsoleTornOff`: true drops its main-dock panel without killing the PTY,
 * false (dock-back) lets the reconciler re-add the panel and re-attach.
 */
export function setShellTornOff(shellId: string, tornOff: boolean): void {
  if (!state.open.some((s) => s.shellId === shellId)) return;
  patchShell(shellId, { tornOff });
}

/** Closer for a torn-off shell window, wired by `registerShellTornCloser` (avoids
 *  an import cycle with state/tearoff). */
let tornCloser: ((shellId: string) => void) | null = null;

/** Wire the torn-off-window closer (called once from the main window's init). */
export function registerShellTornCloser(fn: ((shellId: string) => void) | null): void {
  tornCloser = fn;
}

/** Record a spawn failure so the shell can surface it in place. */
export function markShellError(shellId: string, message: string): void {
  patchShell(shellId, { status: "error", error: message });
}

/**
 * Close a shell: drop it from the open set (the Workspace reconciler removes the
 * panel and releases the pooled terminal, which kills the PTY).
 */
export function closeShell(shellId: string): void {
  const session = state.open.find((s) => s.shellId === shellId);
  if (!session) return;
  // A torn-off shell's panel isn't in the main dock, so close its OS window here
  // (the dock's remove-handler won't fire). The caller kills the PTY via `release`.
  if (session.tornOff) tornCloser?.(shellId);
  const open = state.open.filter((s) => s.shellId !== shellId);
  const activeId = state.activeId === shellId ? null : state.activeId;
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the shells store. */
export function useShells(): ShellsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
