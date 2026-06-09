// Typed access to the app preferences store (step 1.2), backed by
// `tauri-plugin-store` (a JSON file under the app config dir). This is for small
// user prefs that aren't part of the relational registry — the per-project
// layout, instances, and groups live in SQLite (see `registry.ts`).
//
// The shape grows as features land; everything is optional so a missing key
// falls back to the caller's default. Known keys are typed here so callers get
// completion rather than reaching for arbitrary strings.

import { load, type Store } from "@tauri-apps/plugin-store";

export interface Prefs {
  /** Active theme token preset id (see `theme/`). */
  themeId: string;
  /** Last-selected project id, restored on launch so you land where you left. */
  activeProjectId: string;
}
// Note: the hook-server port is owned by the Rust backend (it must bind before it
// can advertise the port), persisted in the SQLite `meta` table, and read by the
// frontend via `getHookServerStatus()` (see `ipc/hooks.ts`) — not a pref here.

// A debug build (`tauri dev`, where `import.meta.env.DEV` is true) keeps its prefs
// in a separate file so it can run alongside an installed release without sharing
// the active theme/project selection. Mirrors the `workbench.dev.db` split in the
// Rust setup.
const STORE_FILE = import.meta.env.DEV ? "prefs.dev.json" : "prefs.json";

let storePromise: Promise<Store> | null = null;

/** Lazily open the shared prefs store; `autoSave` flushes writes to disk. */
function store(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

/** Read a pref, returning `fallback` when it hasn't been set yet. */
export async function getPref<K extends keyof Prefs>(
  key: K,
  fallback: Prefs[K],
): Promise<Prefs[K]> {
  const value = await (await store()).get<Prefs[K]>(key);
  return value ?? fallback;
}

/** Write a pref (persisted via the store's autoSave). */
export async function setPref<K extends keyof Prefs>(
  key: K,
  value: Prefs[K],
): Promise<void> {
  await (await store()).set(key, value);
}
