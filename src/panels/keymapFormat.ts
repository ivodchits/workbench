// Chord display helpers (step 3.10) — turn a canonical chord string (from
// `eventToChord`, e.g. `Ctrl+Shift+A`, `Alt+1`, `PageDown`) into the parts a
// keycap row renders, with platform-appropriate modifier symbols and readable key
// names. Display-only; the stored chords stay in the canonical `Ctrl/Alt/Shift`
// form so the keymap is written once (see `keymap.ts`).

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

const KEY_LABEL: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Enter: "↵",
  Esc: "Esc",
  Tab: "Tab",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
  "\\": "\\",
};

function modLabel(mod: string): string {
  if (mod === "Ctrl") return isMac ? "⌘" : "Ctrl";
  if (mod === "Alt") return isMac ? "⌥" : "Alt";
  if (mod === "Shift") return isMac ? "⇧" : "Shift";
  if (mod === "Meta") return isMac ? "⌃" : "Win";
  return mod;
}

/** Split a chord into display parts (modifiers + key). `[]` for an empty chord. */
export function prettyChord(chord: string): string[] {
  if (chord === "") return [];
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(modLabel);
  return [...mods, KEY_LABEL[key] ?? key];
}

/** A chord as one space-joined string (for titles/tooltips). */
export function chordText(chord: string): string {
  return prettyChord(chord).join(" ");
}
