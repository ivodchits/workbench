// Command runner (step 1.10, extracted in 3.10) — the single place a resolved
// global command turns into an action, shared by the key-event path
// (`useGlobalKeys`) and the command palette. Pure-dock commands call `state/dock`
// (and `state/presets`) directly since no component owns them; everything else
// goes through the command bus to whichever component/host registered a handler.

import type { CommandId, Match } from "./keymap";
import { runCommand } from "./bus";
import {
  closeActivePanel,
  cyclePanel,
  focusPanelIndex,
  splitActivePanel,
} from "../state/dock";
import { applyPresetByIndex } from "../state/presets";

/** Run a global command (with its optional `arg`). No-op for rail-scope commands,
 *  which are dispatched in the rail's own scope, and for any command whose owning
 *  host hasn't registered a bus handler (e.g. a stub). */
export function runAction(command: CommandId, arg?: number): void {
  switch (command) {
    case "cyclePanelNext":
      cyclePanel(1);
      break;
    case "cyclePanelPrev":
      cyclePanel(-1);
      break;
    case "focusPanel":
      if (arg) focusPanelIndex(arg);
      break;
    case "splitPanel":
      splitActivePanel();
      break;
    case "closePanel":
      closeActivePanel();
      break;
    // Recall a saved arrangement by number — pure store logic, no owning component.
    case "applyPreset":
      if (arg) applyPresetByIndex(arg);
      break;
    // Component/host-owned — dispatched to the registered handler (no-op if absent,
    // which is how `jumpNeedsYou` stayed a registered stub until Phase 2).
    case "focusRail":
    case "newInstance":
    case "newEditor":
    case "newShell":
    case "resumeLastSession":
    case "killInstance":
    case "showDiff":
    case "jumpNeedsYou":
    case "jumpPrevNeedsYou":
    case "savePreset":
    case "openTemplates":
    case "openQueue":
    case "openCommandPalette":
    case "openKeymapEditor":
    case "permissionModeDefault":
    case "permissionModeAcceptEdits":
    case "permissionModePlan":
    case "cyclePermissionMode":
      runCommand(command, arg);
      break;
    // Rail-scope commands never reach here (matched in the rail's own scope).
    default:
      break;
  }
}

/** Convenience for the key-event path. */
export function dispatch(match: Match): void {
  runAction(match.command, match.arg);
}
