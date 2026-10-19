// Tasks store (step K1) — the task panels: one per plugin action that has run, a
// terminal running the action's argv in a PTY of its own. The sibling of the
// `shells` store, with the run's state on top, which the toolbar button shows:
// running, then ✓ or ✗ with the exit code.
//
// A task's id is fixed per action (`task:<project>:<plugin>:<action>`), so running
// it again reuses its panel; each run bumps `run`, which the panel keys its
// terminal on. Like a shell, a task restored from a saved layout comes back
// dormant: a run that was going when the app closed is not restarted.
//
// The store is pure state. The PTY exit event (`pty-exited`) is the one input it
// listens to itself, so a run ends even while its panel is in a background tab.

import { useSyncExternalStore } from "react";

import { onPtyExited, type SpawnResult, type TaskSpawn } from "../ipc/pty";

export type TaskStatus = "dormant" | "spawning" | "running" | "exited" | "stopped" | "error";

/** What a task panel is bound to — persisted in layouts and presets. */
export interface TaskDescriptor {
  taskId: string;
  projectId: string;
  pluginId: string;
  actionId: string;
  /** "plugin: action", for the tab and the header. */
  label: string;
  /** Runs until stopped (a dev server). */
  long: boolean;
}

export interface TaskSession extends TaskDescriptor {
  status: TaskStatus;
  /** Bumped by every run; the panel's terminal is keyed on it. */
  run: number;
  /** What the current run was asked to do; null while dormant. */
  spawn: TaskSpawn | null;
  /** The argv and working dir the backend ran, once it has. */
  argv: string[] | null;
  cwd: string | null;
  /** The exit code, once `exited`. */
  code: number | null;
  /** When the run ended (exited, stopped or failed to start), ms. */
  endedAt: number | null;
  error: string | null;
}

interface TasksState {
  open: TaskSession[];
  /** The task to bring to front; only a new value moves focus. */
  activeId: string | null;
}

let state: TasksState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: TasksState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function patch(taskId: string, fn: (t: TaskSession) => Partial<TaskSession> | null): void {
  let changed = false;
  const open = state.open.map((t) => {
    if (t.taskId !== taskId) return t;
    const p = fn(t);
    if (!p) return t;
    changed = true;
    return { ...t, ...p };
  });
  if (changed) emit({ ...state, open });
}

export function getOpenTasks(): TaskSession[] {
  return state.open;
}

export function getActiveTaskId(): string | null {
  return state.activeId;
}

export function getTask(taskId: string): TaskSession | undefined {
  return state.open.find((t) => t.taskId === taskId);
}

/** Whether a run is going (or starting). */
export function isLive(t: TaskSession | undefined): boolean {
  return t?.status === "spawning" || t?.status === "running";
}

/** Start a run of `desc` in its panel (made if it isn't open) and bring it to
 *  front. The caller has already disposed of any previous run's terminal. */
export function startTask(desc: TaskDescriptor, spawn: TaskSpawn): void {
  const fresh = {
    ...desc,
    status: "spawning" as const,
    spawn,
    argv: null,
    cwd: null,
    code: null,
    endedAt: null,
    error: null,
  };
  const existing = getTask(desc.taskId);
  const open = existing
    ? state.open.map((t) => (t.taskId === desc.taskId ? { ...t, ...fresh, run: t.run + 1 } : t))
    : [...state.open, { ...fresh, run: 1 }];
  emit({ open, activeId: desc.taskId });
}

/** The backend spawned run `run`: record what it ran. */
export function markTaskSpawned(taskId: string, run: number, result: SpawnResult): void {
  patch(taskId, (t) =>
    t.run !== run
      ? null
      : {
          // The child may already have exited (a fast failure) before the spawn
          // call came back; that outcome stands.
          status: t.status === "spawning" ? "running" : t.status,
          argv: result.argv,
          cwd: result.cwd,
        },
  );
}

/** Run `run` couldn't start. */
export function markTaskError(taskId: string, run: number, message: string): void {
  patch(taskId, (t) => (t.run !== run ? null : { status: "error", error: message, endedAt: Date.now() }));
}

/** The child exited on its own. */
export function markTaskExited(taskId: string, code: number): void {
  patch(taskId, (t) => (isLive(t) ? { status: "exited", code, endedAt: Date.now() } : null));
}

/** The run was stopped from the app (its PTY is already killed). */
export function markTaskStopped(taskId: string): void {
  patch(taskId, (t) => (isLive(t) ? { status: "stopped", endedAt: Date.now() } : null));
}

/** Seed dormant task panels for a restored layout. Idempotent. */
export function hydrateTasks(descriptors: TaskDescriptor[]): void {
  const present = new Set(state.open.map((t) => t.taskId));
  const additions = descriptors
    .filter((d) => !present.has(d.taskId))
    .map<TaskSession>((d) => ({
      taskId: d.taskId,
      projectId: d.projectId,
      pluginId: d.pluginId,
      actionId: d.actionId,
      label: d.label,
      long: d.long,
      status: "dormant",
      run: 0,
      spawn: null,
      argv: null,
      cwd: null,
      code: null,
      endedAt: null,
      error: null,
    }));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Drop a task panel (the Workspace releases its terminal, which kills the PTY). */
export function closeTask(taskId: string): void {
  if (!getTask(taskId)) return;
  emit({
    open: state.open.filter((t) => t.taskId !== taskId),
    activeId: state.activeId === taskId ? null : state.activeId,
  });
}

let started = false;

/** Follow PTY exits. App-lifetime, idempotent. */
export function initTasks(): void {
  if (started) return;
  started = true;
  void onPtyExited((id, code) => markTaskExited(id, code));
}

// --- React binding ----------------------------------------------------------

export function useTasks(): TasksState {
  return useSyncExternalStore(subscribe, () => state);
}
