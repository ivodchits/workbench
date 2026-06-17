// Remote action handler (step 4.3, design §11) — the **single place** that maps an
// action from a remote client onto a local effect. The remote server is pure
// transport: it forwards each action as a `remote-action` event and never touches a
// PTY itself, so the keystroke mapping (approve/deny/interrupt) and the lifecycle
// calls (start/stop/prompt) all live here, one definition each. A TUI keystroke
// change is therefore a one-line fix here (the §11 caveat).
//
// Mirrors the other engines: a permanent, idempotent subscription (a stored promise,
// not a boolean, to survive StrictMode's double mount). Main window only — it's wired
// from `App.tsx`, not the torn-off window.

import { ENTER_KEY, INTERRUPT_KEY, ptyWrite } from "../ipc/pty";
import { onRemoteAction, type RemoteAction } from "../ipc/remote";
import { getRegistry } from "./registry";
import { markInterrupted } from "./status";
import { closeConsole, openConsole } from "./consoles";
import { release, submitToTerminal } from "../panels/terminalPool";

/** Execute one remote action against its target instance. Exported for direct testing
 *  / reuse; `initRemoteActions` wires it to the event stream. */
export function handleRemoteAction(action: RemoteAction): void {
  const { type, instanceId, text } = action;
  switch (type) {
    case "prompt": {
      const body = (text ?? "").trim();
      if (!body) break;
      // Land the prompt in the live console and submit it. If the instance isn't
      // running, start its console so a follow-up prompt has somewhere to go (the
      // PWA, step 4.4, sequences start→prompt; here we don't silently swallow it).
      if (!submitToTerminal(instanceId, body)) startInstance(instanceId);
      break;
    }
    case "approve":
      // Submitting the highlighted choice approves the pending permission prompt.
      void ptyWrite(instanceId, ENTER_KEY);
      break;
    case "deny":
      // ESC dismisses the permission prompt (the turn continues / is declined).
      void ptyWrite(instanceId, INTERRUPT_KEY);
      break;
    case "interrupt":
      void ptyWrite(instanceId, INTERRUPT_KEY);
      markInterrupted(instanceId); // interrupting fires no hook — update the dot ourselves
      break;
    case "start":
      startInstance(instanceId);
      break;
    case "stop":
      // Close the console panel and kill its PTY (the established teardown — same as
      // the rail's kill path and `resumeConsole`).
      closeConsole(instanceId);
      release(instanceId);
      break;
  }
}

/** Open (or focus) the console for an instance resolved from the registry. No-op if
 *  the id isn't a known instance. */
function startInstance(instanceId: string): void {
  const instance = getRegistry().instances.find((i) => i.id === instanceId);
  if (instance) openConsole(instance);
}

let subscription: Promise<unknown> | null = null;

/** Start consuming remote actions. Idempotent; never torn down. Swallows a non-Tauri
 *  host so the app still imports/runs without the backend. */
export function initRemoteActions(): void {
  if (subscription) return;
  subscription = onRemoteAction(handleRemoteAction).catch(() => {});
}
