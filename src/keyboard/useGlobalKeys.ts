// Global key dispatch (step 1.10) — one document-level, **capture-phase** keydown
// listener that turns global-scope chords into actions. Capture + `stopPropagation`
// on a match means a bound combo is consumed before it reaches xterm's textarea
// (so `Ctrl+Shift+W` never lands in the terminal); anything unbound falls straight
// through to whatever is focused. Mounted once, from App.
//
// Pure-dock commands call `state/dock` directly; component-owned commands
// (`focusRail`, `newInstance`, `killInstance`, `jumpNeedsYou`) go through the bus
// to whichever component registered them.

import { useEffect } from "react";
import { matchCommand, type Match } from "./keymap";
import { runCommand } from "./bus";
import {
  closeActivePanel,
  cyclePanel,
  focusPanelIndex,
  splitActivePanel,
} from "../state/dock";
import { applyPresetByIndex } from "../state/presets";

function dispatch({ command, arg }: Match): void {
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
    // Component-owned — dispatched to the registered handler (no-op if absent,
    // which is how `jumpNeedsYou` stays a registered stub until Phase 2).
    // `savePreset` is owned by the presets bar, which prompts for a name.
    case "focusRail":
    case "newInstance":
    case "newEditor":
    case "newShell":
    case "killInstance":
    case "showDiff":
    case "jumpNeedsYou":
    case "jumpPrevNeedsYou":
    case "savePreset":
    case "openTemplates":
    case "openQueue":
      runCommand(command, arg);
      break;
    // Rail-scope commands never reach here (they're matched in the rail's own
    // scope), so there's nothing to do for them globally.
    default:
      break;
  }
}

/** Install the global keymap listener for the lifetime of the app. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const match = matchCommand(e, "global");
      if (!match) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch(match);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
