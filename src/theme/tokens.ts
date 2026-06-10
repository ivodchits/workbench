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
