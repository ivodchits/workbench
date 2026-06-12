// MCP-manager store (step 3.7) — the runtime registry of MCP Server Manager panels.
// Sibling of the `diffs` store: a panel is bound to a *project* (design §7 — MCP
// scopes are project-relative: project `.mcp.json`, local `~/.claude.json` keyed by
// dir, plus the global user scope), one panel per project, keyed by a deterministic
// `mcp:<projectId>` id so reopening focuses the existing panel rather than stacking.
//
// Like a diff panel it owns no PTY and holds no precious buffer — it re-fetches the
// server list from the backend on mount / refresh / after each edit — so the store
// carries only the *binding* (which project, its repo root, its name). That keeps
// layout restore trivial: the descriptor is the whole state.

import { useSyncExternalStore } from "react";

export interface McpSession {
  /** Deterministic `mcp:<projectId>` — the dock panel id + reconcile key. */
  mcpId: string;
  /** The project whose MCP servers this panel manages. */
  projectId: string;
  /** The project's root path — the cwd for `claude mcp` + where `.mcp.json` lives. */
  repoRoot: string;
  /** Display label — the project name. Shown in the tab + header. */
  title: string;
}

/** A persisted MCP panel: its binding is the whole state (no buffers to restore). */
export type McpDescriptor = McpSession;

interface McpState {
  /** MCP panels in creation order (stable render order). */
  open: McpSession[];
  /** The panel to bring to front, or null. Only a *new* value triggers focus. */
  activeId: string | null;
}

let state: McpState = { open: [], activeId: null };
const listeners = new Set<() => void>();

function emit(next: McpState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): McpState {
  return state;
}

/** Read the open MCP panels outside React (used by the Workspace reconcile path). */
export function getOpenMcps(): McpSession[] {
  return state.open;
}

/** The active MCP panel id, read outside React (see `getOpenMcps`). */
export function getActiveMcpId(): string | null {
  return state.activeId;
}

/** The deterministic panel id for a project's MCP manager. */
export function mcpIdFor(projectId: string): string {
  return `mcp:${projectId}`;
}

/** Where an MCP panel points: a project and its root path. */
export interface McpTarget {
  projectId: string;
  repoRoot: string;
  title: string;
}

/**
 * Open the MCP Server Manager for a project, focusing it if one already exists. An
 * existing panel has its binding refreshed (the repo root / name can change on a
 * project edit) so the next fetch reads the right config.
 */
export function openMcp(target: McpTarget): void {
  const mcpId = mcpIdFor(target.projectId);
  const existing = state.open.find((m) => m.mcpId === mcpId);
  if (existing) {
    const open = state.open.map((m) =>
      m.mcpId === mcpId ? { ...m, repoRoot: target.repoRoot, title: target.title } : m,
    );
    emit({ open, activeId: mcpId });
    return;
  }
  const session: McpSession = { mcpId, ...target };
  emit({ open: [...state.open, session], activeId: mcpId });
}

/**
 * Seed MCP sessions for `descriptors` not already open — backs the MCP panels a
 * saved layout restores. Idempotent (a live session is left untouched).
 */
export function hydrateMcps(descriptors: McpDescriptor[]): void {
  const present = new Set(state.open.map((m) => m.mcpId));
  const additions = descriptors.filter((m) => !present.has(m.mcpId));
  if (additions.length === 0) return;
  emit({ ...state, open: [...state.open, ...additions] });
}

/** Close an MCP panel entirely. */
export function closeMcp(mcpId: string): void {
  if (!state.open.some((m) => m.mcpId === mcpId)) return;
  const open = state.open.filter((m) => m.mcpId !== mcpId);
  const activeId = state.activeId === mcpId ? null : state.activeId;
  emit({ open, activeId });
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the MCP store. */
export function useMcps(): McpState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
