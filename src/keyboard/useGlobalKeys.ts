// Global key dispatch (step 1.10) — one document-level, **capture-phase** keydown
// listener that turns global-scope chords into actions. Capture + `stopPropagation`
// on a match means a bound combo is consumed before it reaches xterm's textarea
// (so `Ctrl+Shift+W` never lands in the terminal); anything unbound falls straight
// through to whatever is focused. Mounted once, from App.
//
// The command→action mapping lives in `commands.ts` so the palette (3.10) can run
// the same actions; here we only translate the key event and feed it through.

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isKeymapCapturing, matchCommand } from "./keymap";
import { runCommand } from "./bus";
import { dispatch } from "./commands";

/** Install the global keymap listener for the lifetime of the app. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Stand down while the keymap editor is recording a chord, so the key being
      // pressed is captured as a binding rather than firing its current action.
      if (isKeymapCapturing()) return;
      const match = matchCommand(e, "global");
      if (!match) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch(match);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });

    // `Ctrl+Shift+R` (resume last session) is a WebView2 reload accelerator the
    // engine consumes before DOM dispatch, so the keymap above never sees it — the
    // native `accel` handler suppresses the reload and emits this event instead, and
    // we route it to the same command the binding maps to (single source of truth in
    // the keymap; this is just an alternate input edge). See `src-tauri/src/accel.rs`.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen("resume-last-session", () => runCommand("resumeLastSession")).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
