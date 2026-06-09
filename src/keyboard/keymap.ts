// Keyboard layer (step 1.10) — the single binding registry for the whole app.
//
// Design constraint that shapes everything (design §5.y, §1 keyboard-first): the
// terminal owns the keyboard. Whenever a Console (xterm) or Editor (CodeMirror)
// is focused — most of the time — plain keys and most `Ctrl+key` combos are live
// editing keys that must reach the PTY/buffer (`Ctrl+W` = delete-word, `Ctrl+\` =
// SIGQUIT, `Ctrl+C` = interrupt, …). So the keymap is split into two scopes:
//
//   • global — modifier chords in the terminal-emulator command space (`Ctrl+Shift`,
//     plus `Ctrl+Tab` and `Alt+<digit>`), which shells and the `claude` TUI never
//     claim. Matched on a document **capture-phase** listener (`useGlobalKeys`) that
//     `preventDefault`s + `stopPropagation`s the bound combos so xterm never sees
//     them; unbound keys pass straight through.
//   • rail — single, unmodified keys (TUI-style: j/k, Enter, n, e, x, …) that act
//     **only** while focus is inside the Instance Manager rail, which is a list, not
//     a text field. Matched locally by the rail's own handlers, so a bare `x` can
//     never kill an instance while you're typing in a shell.
//
// This file is the source of truth for *which key does what*; remap-to-file (3.10)
// edits `BINDINGS` and nothing else has to change.

export type Scope = "global" | "rail";

export type CommandId =
  // global
  | "cyclePanelNext"
  | "cyclePanelPrev"
  | "focusPanel" // carries a 1-based panel number in `arg`
  | "focusRail"
  | "splitPanel"
  | "closePanel"
  | "newInstance"
  | "killInstance"
  | "jumpNeedsYou"
  | "jumpPrevNeedsYou"
  // rail
  | "railPrev"
  | "railNext"
  | "railCollapse"
  | "railExpand"
  | "railOpen"
  | "railNew"
  | "railEditNote"
  | "railRename"
  | "railKill"
  | "railWorktree"
  | "railOpenDir"
  | "railInterrupt"
  | "railAddProject"
  | "railReturn";

export interface Binding {
  /** Canonical chord (see `eventToChord`), e.g. `Ctrl+Shift+W`, `Alt+1`, `J`. */
  chord: string;
  command: CommandId;
  /** Fixed argument for parameterized commands (only `focusPanel` uses it). */
  arg?: number;
  scope: Scope;
  /** Human label for a future command palette / remap UI (3.10). */
  title: string;
}

/** A resolved command for one key event. */
export interface Match {
  command: CommandId;
  arg?: number;
}

// On macOS the "Ctrl/Cmd" bindings ride Cmd (the platform's command modifier); on
// Windows/Linux they ride Ctrl. We normalize the primary modifier to the `Ctrl`
// token so the keymap below is written once. (Windows is the primary target.)
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/**
 * The whole keymap. Two scopes share one table so the palette/remap UI (3.10) can
 * render every binding from a single list. `focusPanel` expands to Alt+1..9.
 */
export const BINDINGS: Binding[] = [
  // --- global: panel navigation ---------------------------------------------
  { chord: "Ctrl+Tab", command: "cyclePanelNext", scope: "global", title: "Cycle to next panel" },
  { chord: "Ctrl+Shift+Tab", command: "cyclePanelPrev", scope: "global", title: "Cycle to previous panel" },
  ...Array.from({ length: 9 }, (_, i): Binding => ({
    chord: `Alt+${i + 1}`,
    command: "focusPanel",
    arg: i + 1,
    scope: "global",
    title: `Focus panel ${i + 1}`,
  })),
  { chord: "Alt+0", command: "focusRail", scope: "global", title: "Focus the instance rail" },
  // --- global: layout -------------------------------------------------------
  { chord: "Ctrl+Shift+\\", command: "splitPanel", scope: "global", title: "Split panel into its own column" },
  { chord: "Ctrl+Shift+W", command: "closePanel", scope: "global", title: "Close the focused panel" },
  // --- global: instance control --------------------------------------------
  { chord: "Ctrl+Shift+N", command: "newInstance", scope: "global", title: "New instance in the active project" },
  { chord: "Ctrl+Shift+K", command: "killInstance", scope: "global", title: "Kill the focused instance" },
  // Attention navigation (wired to the status engine in Phase 2). Ctrl+Shift+Alt
  // keeps clear of the Intel-GPU display-rotate combo (Ctrl+Alt+Arrow, no Shift).
  { chord: "Ctrl+Alt+Shift+Up", command: "jumpNeedsYou", scope: "global", title: "Jump to next agent that needs you" },
  { chord: "Ctrl+Alt+Shift+Down", command: "jumpPrevNeedsYou", scope: "global", title: "Jump to previous agent that needs you" },

  // --- rail: navigation (TUI single keys) -----------------------------------
  { chord: "Up", command: "railPrev", scope: "rail", title: "Rail: move up" },
  { chord: "K", command: "railPrev", scope: "rail", title: "Rail: move up" },
  { chord: "Down", command: "railNext", scope: "rail", title: "Rail: move down" },
  { chord: "J", command: "railNext", scope: "rail", title: "Rail: move down" },
  { chord: "Left", command: "railCollapse", scope: "rail", title: "Rail: collapse / go to parent" },
  { chord: "H", command: "railCollapse", scope: "rail", title: "Rail: collapse / go to parent" },
  { chord: "Right", command: "railExpand", scope: "rail", title: "Rail: expand project" },
  { chord: "L", command: "railExpand", scope: "rail", title: "Rail: expand project" },
  { chord: "Enter", command: "railOpen", scope: "rail", title: "Rail: open / focus console" },
  // --- rail: actions --------------------------------------------------------
  { chord: "N", command: "railNew", scope: "rail", title: "Rail: new instance" },
  { chord: "E", command: "railEditNote", scope: "rail", title: "Rail: edit task note" },
  { chord: "R", command: "railRename", scope: "rail", title: "Rail: rename instance" },
  { chord: "X", command: "railKill", scope: "rail", title: "Rail: kill instance" },
  { chord: "Delete", command: "railKill", scope: "rail", title: "Rail: kill instance" },
  { chord: "W", command: "railWorktree", scope: "rail", title: "Rail: toggle worktree" },
  { chord: "O", command: "railOpenDir", scope: "rail", title: "Rail: open working dir" },
  { chord: "I", command: "railInterrupt", scope: "rail", title: "Rail: interrupt agent" },
  { chord: "P", command: "railAddProject", scope: "rail", title: "Rail: add project" },
  { chord: "Esc", command: "railReturn", scope: "rail", title: "Rail: return focus to panel" },
];

/**
 * Normalize a key event to a canonical chord string. Letters/digits come from
 * `event.code` (layout- and Shift-stable: Shift+`/` stays `/`, not `?`), and the
 * primary modifier is folded to `Ctrl` (= Cmd on mac). Pure modifier presses and
 * unmapped keys return `null`. Returns e.g. `Ctrl+Shift+W`, `Alt+1`, `J`, `Esc`.
 */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = mainKey(e);
  if (key === null) return null;
  const parts: string[] = [];
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  if (primary) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (secondary) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

/** The non-modifier "main" token of a key event, or null if it's not one we map. */
function mainKey(e: KeyboardEvent): string | null {
  const code = e.code;
  if (code.startsWith("Key")) return code.slice(3); // KeyW → "W"
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 → "1"
  if (code === "Backslash") return "\\";
  switch (e.key) {
    case "Tab":
      return "Tab";
    case "Enter":
      return "Enter";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Delete":
      return "Delete";
    default:
      return null;
  }
}

/** Resolve a key event to its bound command within `scope`, or null if unbound. */
export function matchCommand(e: KeyboardEvent, scope: Scope): Match | null {
  const chord = eventToChord(e);
  if (chord === null) return null;
  const b = BINDINGS.find((b) => b.scope === scope && b.chord === chord);
  return b ? { command: b.command, arg: b.arg } : null;
}

/** True when `el` is a text-entry surface, so rail single-keys must defer to it. */
export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}
