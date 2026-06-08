// Theme tokens — the single source of truth that will feed both the CSS custom
// properties and (later) the xterm.js theme object. Step 0.1 seeds only the
// "muted dark" palette from the design mockup so the scaffold reads as a themed
// terminal surface; the full theme system (variants, xterm derivation, CRT
// overlay) is built in step 1.1.

export type ThemeTokens = Record<string, string>;

// "Muted dark" — violet structural accent. The status palette doubles as the
// UI accent system: ● needs you = magenta · working = amber · done/idle = green.
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
};

export const mono = "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";

/** Write a token set onto an element as `--wb-*` CSS custom properties. */
export function applyTheme(tokens: ThemeTokens, el: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(tokens)) {
    el.style.setProperty(`--wb-${key}`, value);
  }
  el.style.setProperty("--wb-mono", mono);
}
