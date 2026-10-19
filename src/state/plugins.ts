// Plugins store (step K1) — each project's plugin file as last read, and the values
// its toolbar fields hold. The file is re-read whenever the backend says it changed
// (`plugins-changed`, from its watcher or its own writes), so saving it from
// anywhere redraws the toolbar with nothing compiled and no window reload.
//
// Field values are kept per project in prefs (`pluginValues`), so a field keeps
// its last value across restarts; they are keyed `pluginId.controlId`.

import { useSyncExternalStore } from "react";

import { onPluginsChanged, pluginsRead, type PluginsView } from "../ipc/plugins";
import { getPref, setPref } from "../ipc/prefs";
import type { FieldValue } from "./pluginModel";

interface PluginsState {
  /** The last read of each project's file; absent until first asked for. */
  views: Record<string, PluginsView>;
  /** Why a read failed (not a broken file — that's in the view's `problems`). */
  errors: Record<string, string>;
  /** projectId → `pluginId.controlId` → value. */
  values: Record<string, Record<string, FieldValue>>;
}

let state: PluginsState = { views: {}, errors: {}, values: {} };
const listeners = new Set<() => void>();

function emit(next: PluginsState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Read (or re-read) a project's plugin file. Concurrent calls share one read. */
const inFlight = new Map<string, Promise<void>>();
export function loadPlugins(projectId: string): Promise<void> {
  const running = inFlight.get(projectId);
  if (running) return running;
  const p = pluginsRead(projectId)
    .then((view) => {
      const errors = { ...state.errors };
      delete errors[projectId];
      emit({ ...state, views: { ...state.views, [projectId]: view }, errors });
    })
    .catch((e: unknown) => {
      emit({ ...state, errors: { ...state.errors, [projectId]: String(e) } });
    })
    .finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, p);
  return p;
}

let started = false;

/** Follow file changes and load the stored field values. App-lifetime, idempotent. */
export function initPlugins(): void {
  if (started) return;
  started = true;
  void onPluginsChanged((projectId) => {
    if (projectId in state.views || projectId in state.errors) void loadPlugins(projectId);
  });
  void getPref("pluginValues", {}).then((values) => emit({ ...state, values: { ...values, ...state.values } }));
}

/** The stored values of a project's fields, keyed `controlId`, for one plugin. */
export function storedValues(projectId: string, pluginId: string): Record<string, FieldValue> {
  const all = state.values[projectId] ?? {};
  const prefix = `${pluginId}.`;
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

export function setFieldValue(projectId: string, pluginId: string, controlId: string, value: FieldValue): void {
  const project = { ...(state.values[projectId] ?? {}), [`${pluginId}.${controlId}`]: value };
  const values = { ...state.values, [projectId]: project };
  emit({ ...state, values });
  void setPref("pluginValues", values);
}

export function getPluginsView(projectId: string): PluginsView | undefined {
  return state.views[projectId];
}

// --- React binding ----------------------------------------------------------

export function usePluginsState(): PluginsState {
  return useSyncExternalStore(subscribe, () => state);
}
