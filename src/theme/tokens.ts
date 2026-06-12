// Theme tokens — the single source of truth that feeds *both* the CSS custom
// properties (`--wb-*`) used by the React chrome and the `xterm.js` theme object
// used by every Console. One token edit recolors the chrome and the embedded
// terminal together, so the app reads as one continuous terminal surface.
//
// Step 1.1 ships a single default theme ("muted dark"). Variants, the CRT
// overlay, and per-instance accents are Phase 3 (§5.x) — the shape here is built
// to accept them: a theme is just another `ThemeTokens` value passed to
// `applyTheme` / `deriveXtermTheme`.

import type { ITheme } from "@xterm/xterm";

/**
 * Every color the app draws with. Grouped by role; the keys become `--wb-<key>`
 * CSS variables verbatim. Keeping this an explicit interface (not a loose
 * `Record`) means a missing or misspelled token is a compile error, and the
 * xterm derivation below can rely on every slot being present.
 */
export interface ThemeTokens {
  // ── surfaces ──────────────────────────────────────────────────────────────
  /** App background — the deepest surface, also the terminal background. */
  bg: string;
  /** Panel body background (one step up from `bg`). */
  panel: string;
  /** Instance-manager rail background. */
  rail: string;
  /** Title bar / status bar / tab strip background. */
  titlebar: string;

  // ── borders ───────────────────────────────────────────────────────────────
  /** Thin square-cornered panel borders. */
  border: string;
  /** Active/focused border + the box-drawing corner glyphs on title chips. */
  borderActive: string;

  // ── text ──────────────────────────────────────────────────────────────────
  /** Primary foreground. */
  text: string;
  /** Secondary text (notes, labels, dim rows). */
  textDim2: string;
  /** Faint text (hints, line numbers, inactive glyphs). */
  textFaint: string;

  // ── selection & accent ────────────────────────────────────────────────────
  /** Selected-row background in the rail. */
  sel: string;
  /** Selected-row left marker bar. */
  selBar: string;
  /** Structural accent (violet) — corners, prompts, group labels, cursor. */
  accent: string;
  /** Translucent accent wash for callouts / highlighted blocks. */
  accentSoft: string;

  // ── status palette (doubles as the UI accent system) ──────────────────────
  /** ◐/⠹ working — don't disturb. */
  working: string;
  /** ● needs you — the key signal. */
  needs: string;
  /** ○ done / idle. */
  done: string;
  /** − closed / dim. */
  closed: string;

  // ── diff ──────────────────────────────────────────────────────────────────
  /** Added lines (`+N`). */
  addText: string;
  /** Removed lines (`−N`). */
  delText: string;

  // ── syntax (CodeMirror + reused as terminal ANSI) ─────────────────────────
  /** Strings. */
  str: string;
  /** Keywords. */
  kw: string;
  /** Functions / identifiers. */
  fn: string;
  /** Numbers. */
  num: string;
  /** Comments. */
  com: string;

  // ── terminal ANSI extras ──────────────────────────────────────────────────
  // The 16-color ANSI palette is mostly mapped from the semantic tokens above
  // (see `deriveXtermTheme`); these fill the few slots without a natural match
  // so the whole xterm theme still derives from this one object.
  /** ANSI black (slightly lifted off `bg` so it's not pure void). */
  ansiBlack: string;
  /** ANSI cyan. */
  ansiCyan: string;
  /** ANSI bright blue. */
  ansiBrightBlue: string;
  /** ANSI bright cyan. */
  ansiBrightCyan: string;
  /** ANSI bright white. */
  ansiBrightWhite: string;
}

/**
 * "Muted dark" — violet structural accent, calm for long sessions. The status
 * palette doubles as the UI accent system: ● needs you = magenta · ◐ working =
 * amber · ○ done/idle = green · − closed = grey. (Matches the design mockup.)
 */
export const mutedDark: ThemeTokens = {
  bg: "#13151e",
  panel: "#171a25",
  rail: "#13151e",
  titlebar: "#10121a",

  border: "#2c2f44",
  borderActive: "#7c6df2",

  text: "#d8dae8",
  textDim2: "#7c8197",
  textFaint: "#474b60",

  sel: "#232742",
  selBar: "#7c6df2",
  accent: "#8b7cf6",
  accentSoft: "rgba(139,124,246,0.14)",

  working: "#e0a83e",
  needs: "#e85d9e",
  done: "#54c47a",
  closed: "#5a5e72",

  addText: "#6cc886",
  delText: "#e8707a",

  str: "#9bd4a6",
  kw: "#c08bf0",
  fn: "#7fb0f5",
  num: "#e0a83e",
  com: "#5a6072",

  ansiBlack: "#1b1e2b",
  ansiCyan: "#5bc8d6",
  ansiBrightBlue: "#8ba3ff",
  ansiBrightCyan: "#7fdbe6",
  ansiBrightWhite: "#ffffff",
};

/**
 * "Green phosphor" — the classic CRT terminal look, *tinted-dark* not monochrome:
 * the chrome and terminal read green, but syntax and diff colors stay distinct so
 * code/diffs remain readable (step 3.9 decision). The status palette keeps its
 * cross-theme meaning (magenta needs / amber working / green done).
 */
export const greenPhosphor: ThemeTokens = {
  bg: "#0b110c",
  panel: "#0f1710",
  rail: "#0b110c",
  titlebar: "#080d09",

  border: "#214027",
  borderActive: "#4ade80",

  text: "#cfe9d4",
  textDim2: "#74917a",
  textFaint: "#3f5944",

  sel: "#16301c",
  selBar: "#4ade80",
  accent: "#56d98a",
  accentSoft: "rgba(74,222,128,0.13)",

  working: "#e0c23e",
  needs: "#ff6b9d",
  done: "#4ade80",
  closed: "#566e5e",

  addText: "#6cdf8e",
  delText: "#f08a8a",

  str: "#bdebc6",
  kw: "#7fe3b0",
  fn: "#86d9b4",
  num: "#e0c23e",
  com: "#4f6b55",

  ansiBlack: "#0f1710",
  ansiCyan: "#5fd0b0",
  ansiBrightBlue: "#8fe0c0",
  ansiBrightCyan: "#9ff0d6",
  ansiBrightWhite: "#eafff0",
};

/** "Amber" — amber/gold phosphor on near-black, the other monochrome-CRT classic,
 *  tinted-dark with readable syntax (step 3.9 decision). */
export const amber: ThemeTokens = {
  bg: "#140f06",
  panel: "#1a130a",
  rail: "#140f06",
  titlebar: "#0f0b04",

  border: "#43331a",
  borderActive: "#f0a830",

  text: "#ecd9b4",
  textDim2: "#9c8460",
  textFaint: "#5e4d30",

  sel: "#30230f",
  selBar: "#f0a830",
  accent: "#f0b84a",
  accentSoft: "rgba(240,168,48,0.13)",

  working: "#ffd35e",
  needs: "#ff6f91",
  done: "#7bd88a",
  closed: "#6e5e44",

  addText: "#9fd07a",
  delText: "#f0857a",

  str: "#e8c98a",
  kw: "#f0a850",
  fn: "#e6b96a",
  num: "#ffd35e",
  com: "#6a583a",

  ansiBlack: "#1a130a",
  ansiCyan: "#5bbf9e",
  ansiBrightBlue: "#d8b96a",
  ansiBrightCyan: "#7fd6b8",
  ansiBrightWhite: "#fff3da",
};

/** "Cyan / synthwave" — cyan + magenta on deep indigo. The most colorful preset;
 *  still dark and readable. */
export const synthwave: ThemeTokens = {
  bg: "#0d1020",
  panel: "#141832",
  rail: "#0d1020",
  titlebar: "#0a0c18",

  border: "#2a2f55",
  borderActive: "#22d3ee",

  text: "#d6e6f5",
  textDim2: "#7b86b8",
  textFaint: "#454d80",

  sel: "#1c2348",
  selBar: "#22d3ee",
  accent: "#3ddbf0",
  accentSoft: "rgba(34,211,238,0.14)",

  working: "#f5c542",
  needs: "#ff5cc8",
  done: "#43e8c0",
  closed: "#565d85",

  addText: "#5fe0c0",
  delText: "#ff7eb0",

  str: "#7ef0d8",
  kw: "#c08bf0",
  fn: "#5cc8f5",
  num: "#f5c542",
  com: "#5a6296",

  ansiBlack: "#141832",
  ansiCyan: "#22d3ee",
  ansiBrightBlue: "#7aa6ff",
  ansiBrightCyan: "#7ff0ff",
  ansiBrightWhite: "#eef6ff",
};

/** A selectable theme preset: a stable id (persisted), a display label, and the
 *  token set. The appearance store (`state/appearance`) switches between these. */
export interface ThemeOption {
  id: string;
  label: string;
  tokens: ThemeTokens;
}

/** The shipped presets (step 3.9). `mutedDark` is the default; the order here is
 *  the order they appear in the appearance menu and the cycle order. */
export const THEMES: ThemeOption[] = [
  { id: "muted-dark", label: "muted dark", tokens: mutedDark },
  { id: "green-phosphor", label: "green phosphor", tokens: greenPhosphor },
  { id: "amber", label: "amber", tokens: amber },
  { id: "synthwave", label: "cyan / synthwave", tokens: synthwave },
];

/** The default preset id, used when no `themeId` pref is set yet. */
export const DEFAULT_THEME_ID = "muted-dark";

/** The fixed per-instance accent palette (step 3.9). Theme-independent so an
 *  instance keeps its visual identity across theme switches; `null` (offered as
 *  "none" in the picker) inherits the active theme's structural accent. */
export const ACCENT_SWATCHES: { id: string; color: string }[] = [
  { id: "violet", color: "#8b7cf6" },
  { id: "cyan", color: "#5bc8d6" },
  { id: "green", color: "#54c47a" },
  { id: "amber", color: "#e0a83e" },
  { id: "magenta", color: "#e85d9e" },
  { id: "blue", color: "#7fb0f5" },
];

/** Look up a preset by id, falling back to the default if it's unknown (e.g. a
 *  pref written by a newer build, or a removed preset). */
export function themeById(id: string): ThemeOption {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The font stack. The app font and the `xterm.js` font are the same on purpose. */
export const mono =
  "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";

/**
 * The theme currently applied to the document. `applyTheme` keeps this in sync
 * so theme-derived consumers (notably `deriveXtermTheme`) can default to "the
 * active theme" without threading it through props. Single-theme today; the
 * Phase-3 theme switcher just calls `applyTheme(otherTheme)`.
 */
export let activeTheme: ThemeTokens = mutedDark;

/** Write a token set onto an element as `--wb-*` CSS custom properties. */
export function applyTheme(
  tokens: ThemeTokens,
  el: HTMLElement = document.documentElement,
): void {
  for (const [key, value] of Object.entries(tokens)) {
    el.style.setProperty(`--wb-${key}`, value);
  }
  el.style.setProperty("--wb-mono", mono);
  activeTheme = tokens;
}

/**
 * Derive the `xterm.js` theme from the same token object that drives the CSS
 * chrome, so the real Claude TUI inside a console matches the chrome around it.
 * Defaults to the active theme; pass an explicit set to preview another.
 */
export function deriveXtermTheme(tokens: ThemeTokens = activeTheme): ITheme {
  return {
    background: tokens.bg,
    foreground: tokens.text,
    cursor: tokens.accent,
    cursorAccent: tokens.bg,
    selectionBackground: tokens.sel,

    black: tokens.ansiBlack,
    red: tokens.needs,
    green: tokens.done,
    yellow: tokens.working,
    blue: tokens.fn,
    magenta: tokens.accent,
    cyan: tokens.ansiCyan,
    white: tokens.text,

    brightBlack: tokens.textFaint,
    brightRed: tokens.delText,
    brightGreen: tokens.done,
    brightYellow: tokens.working,
    brightBlue: tokens.ansiBrightBlue,
    brightMagenta: tokens.kw,
    brightCyan: tokens.ansiBrightCyan,
    brightWhite: tokens.ansiBrightWhite,
  };
}
