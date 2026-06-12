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
  | "newEditor"
  | "newShell"
  | "resumeLastSession"
  | "killInstance"
  | "showDiff"
  | "jumpNeedsYou"
  | "jumpPrevNeedsYou"
  | "savePreset"
  | "applyPreset" // carries a 1-based preset number in `arg`
  | "openTemplates"
  | "openQueue"
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
  | "railDiff"
  | "railOpenDir"
  | "railInterrupt"
  | "railQueue"
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
  { chord: "Ctrl+Shift+E", command: "newEditor", scope: "global", title: "Open the editor for the active project" },
  { chord: "Ctrl+Shift+T", command: "newShell", scope: "global", title: "New shell in the active project" },
  // Resume the active instance's last claude session (`claude --resume`); ignored
  // when a session is already live there (step 3.8). NOTE: WebView2 consumes the
  // Ctrl+Shift+R reload accelerator before DOM dispatch, so this binding is *not*
  // driven by a DOM keydown — `accel.rs` suppresses the reload and emits a
  // `resume-last-session` event that `useGlobalKeys` routes to this command. The
  // entry stays here as the source of truth for the palette / remap UI (3.10).
  { chord: "Ctrl+Shift+R", command: "resumeLastSession", scope: "global", title: "Resume the last Claude session in the active instance" },
  { chord: "Ctrl+Shift+K", command: "killInstance", scope: "global", title: "Kill the focused instance" },
  { chord: "Ctrl+Shift+D", command: "showDiff", scope: "global", title: "Review changes (diff) for the focused instance" },
  { chord: "Ctrl+Shift+P", command: "openTemplates", scope: "global", title: "Open the prompt template library" },
  { chord: "Ctrl+Shift+Q", command: "openQueue", scope: "global", title: "Queue a prompt for an instance" },
  // Attention navigation (wired to the status engine in Phase 2). Modifiers must
  // be written in `eventToChord`'s canonical order (Ctrl → Alt → Shift) or the
  // string match in `matchCommand` never fires — hence `Alt+Shift`, not `Shift+Alt`.
  { chord: "Alt+Shift+PageDown", command: "jumpNeedsYou", scope: "global", title: "Jump to next agent that needs you" },
  { chord: "Alt+Shift+PageUp", command: "jumpPrevNeedsYou", scope: "global", title: "Jump to previous agent that needs you" },
  // --- global: layout presets (step 3.3) ------------------------------------
  // Recall the active project's saved arrangements by number. `Alt+<digit>` is
  // taken by focus-panel, so presets ride the `Ctrl+Shift+<digit>` command space.
  // Saving a preset has no chord — `Ctrl+Shift+S` collides with the editor's
  // Save-All, and saving is rare enough to leave to the PresetsBar button.
  ...Array.from({ length: 9 }, (_, i): Binding => ({
    chord: `Ctrl+Shift+${i + 1}`,
    command: "applyPreset",
    arg: i + 1,
    scope: "global",
    title: `Recall layout preset ${i + 1}`,
  })),

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
  { chord: "D", command: "railDiff", scope: "rail", title: "Rail: review changes (diff)" },
  { chord: "O", command: "railOpenDir", scope: "rail", title: "Rail: open working dir" },
  { chord: "I", command: "railInterrupt", scope: "rail", title: "Rail: interrupt agent" },
  { chord: "Q", command: "railQueue", scope: "rail", title: "Rail: queue a prompt" },
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
    case "PageDown":
      return "PageDown";
    case "PageUp":
      return "PageUp";
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
