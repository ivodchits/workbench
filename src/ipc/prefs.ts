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
  /** Local port the hook server binds on `127.0.0.1` (wired in Phase 2). */
  hookServerPort: number;
}

const STORE_FILE = "prefs.json";

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
