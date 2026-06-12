// Appearance store (step 3.9) — the runtime home for the three look-and-feel
// controls: the active **theme preset**, the **CRT overlay** toggle, and the global
// **font scale** (Ctrl+MouseWheel zoom). All three persist to the prefs store and
// apply app-wide on launch.
//
// Why a store (not just `applyTheme`): a theme switch has to reach three surfaces
// that don't share a React render — the CSS `--wb-*` variables (chrome), every
// pooled `xterm` terminal, and every open CodeMirror view. This store fans the
// change out: it writes the CSS vars via `applyTheme`, re-themes the terminals via
// the pool, and bumps a version that CodeMirror views subscribe to so they
// reconfigure. Font scaling works the same way: it zooms the document root (chrome
// + editor scale uniformly and stay crisp as DOM text) and rescales the terminals
// (which counter-zoom + grow their font so canvas glyphs stay crisp — see
// `terminalPool.applyScale`).

import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_THEME_ID, applyTheme, themeById } from "../theme/tokens";
import { rescaleAll, rethemeAll } from "../panels/terminalPool";
import { getPref, setPref } from "../ipc/prefs";

/** Font-scale bounds + step for Ctrl+wheel and the menu controls. */
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.2;
const SCALE_STEP = 0.1;

interface AppearanceState {
  themeId: string;
  crt: boolean;
  fontScale: number;
  /** Bumped on every theme switch so CodeMirror views reconfigure their theme
   *  compartment (CSS vars + terminals update in place; the editor can't read a
   *  CSS var for its syntax colors, so it rebuilds from the new tokens). */
  themeVersion: number;
}

let state: AppearanceState = {
  themeId: DEFAULT_THEME_ID,
  crt: false,
  fontScale: 1,
  themeVersion: 0,
};

const listeners = new Set<() => void>();

function emit(next: AppearanceState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// --- applying each dimension to the document --------------------------------

/** Write the preset's tokens to the CSS vars and re-theme every live terminal. */
function applyThemeId(id: string): void {
  applyTheme(themeById(id).tokens);
  rethemeAll();
}

/** Toggle the CRT overlay via a root data-attribute the overlay/CSS keys off. */
function applyCrt(on: boolean): void {
  document.documentElement.dataset.wbCrt = on ? "on" : "off";
}

/** Zoom the whole UI at the document root (chrome + editor scale crisply) and
 *  rescale the terminals (which keep their own glyphs crisp under the zoom). */
function applyFontScale(scale: number): void {
  // `zoom` (Chromium/WebView2) is a layout-level scale — DOM text re-rasterizes
  // crisp at the new size, unlike `transform: scale`. The terminals counter it.
  document.documentElement.style.zoom = String(scale);
  rescaleAll(scale);
}

function clampScale(n: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n * 100) / 100));
}

// --- public setters ---------------------------------------------------------

/** Switch the active theme preset (persisted; re-themes chrome + terminals +
 *  editors). No-op if it's already active. */
export function setThemeId(id: string): void {
  if (id === state.themeId) return;
  applyThemeId(id);
  emit({ ...state, themeId: id, themeVersion: state.themeVersion + 1 });
  void setPref("themeId", id);
}

/** Turn the CRT overlay on/off (persisted). */
export function setCrt(on: boolean): void {
  if (on === state.crt) return;
  applyCrt(on);
  emit({ ...state, crt: on });
  void setPref("crtEnabled", on);
}

export function toggleCrt(): void {
  setCrt(!state.crt);
}

/** Set the global font scale (clamped + persisted). */
export function setFontScale(scale: number): void {
  const next = clampScale(scale);
  if (next === state.fontScale) return;
  applyFontScale(next);
  emit({ ...state, fontScale: next });
  void setPref("fontScale", next);
}

/** Nudge the font scale by `steps × SCALE_STEP` (Ctrl+wheel: +1 up, −1 down). */
export function adjustFontScale(steps: number): void {
  setFontScale(state.fontScale + steps * SCALE_STEP);
}

/** Reset the font scale to 100%. */
export function resetFontScale(): void {
  setFontScale(1);
}

/** The current font scale, read outside React (the Ctrl+wheel handler needs the
 *  live value without a hook). */
export function getFontScale(): number {
  return state.fontScale;
}

// --- init -------------------------------------------------------------------

let started = false;

/**
 * Read the persisted appearance prefs and apply all three on launch. Idempotent;
 * called once from App. Applies immediately (no flash) using whatever loads — a
 * missing pref falls back to the default. Terminals created later adopt the scale
 * and theme via the pool's `acquire`.
 */
export async function initAppearance(): Promise<void> {
  if (started) return;
  started = true;
  // Paint the default theme synchronously so there's no unstyled flash while the
  // (async) prefs load; the real values below override it a tick later.
  applyThemeId(state.themeId);
  const [themeId, crt, fontScale] = await Promise.all([
    getPref("themeId", DEFAULT_THEME_ID),
    getPref("crtEnabled", false),
    getPref("fontScale", 1),
  ]);
  const scale = clampScale(fontScale);
  applyThemeId(themeId);
  applyCrt(crt);
  applyFontScale(scale);
  emit({ themeId, crt, fontScale: scale, themeVersion: state.themeVersion + 1 });
}

// --- React bindings ---------------------------------------------------------

export function useThemeId(): string {
  return useSyncExternalStore(subscribe, () => state.themeId);
}

export function useCrt(): boolean {
  return useSyncExternalStore(subscribe, () => state.crt);
}

export function useFontScale(): number {
  return useSyncExternalStore(subscribe, () => state.fontScale);
}

/** Subscribe to the theme-switch counter — CodeMirror views reconfigure on change. */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, () => state.themeVersion);
}

/**
 * Wire Ctrl+MouseWheel anywhere in the app to font scaling (step 3.9). Mounted
 * once by App. A capture-phase, non-passive `wheel` listener so it can
 * `preventDefault` the browser's own Ctrl+wheel page zoom and beat any panel
 * (xterm, the editor) to the event — without Ctrl it falls through untouched, so
 * normal scrollwheel scrolling is unaffected.
 */
export function useFontZoomWheel(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      adjustFontScale(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
}
