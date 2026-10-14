// Remote action handler (step 4.3, design §11) — the **single place** that maps an
// action from a remote client onto a local effect. The remote server is pure
// transport: it forwards each action as a `remote-action` event and never touches a
// PTY itself, so the keystroke mapping (approve/deny/interrupt) and the lifecycle
// calls (start/stop/prompt/create) all live here, one definition each. A TUI keystroke
// change is therefore a one-line fix here (the §11 caveat).
//
// Mirrors the other engines: a permanent, idempotent subscription (a stored promise,
// not a boolean, to survive StrictMode's double mount). Main window only — it's wired
// from `App.tsx`, not the torn-off window.

import { ENTER_KEY, INTERRUPT_KEY, ptyWrite } from "../ipc/pty";
import { onRemoteAction, type RemoteAction } from "../ipc/remote";
import type { Instance } from "../ipc/registry";
import type { RemoteCreateAction } from "../remote/protocol";
import { addInstance, deleteInstance, getRegistry, nextInstanceTitle } from "./registry";
import { markInterrupted } from "./status";
import { closeConsole, openConsole } from "./consoles";
import { setActiveProject } from "./activeProject";
import { activatePanel } from "./dock";
import { setQueued } from "./queue";
import { asksForPassword, beginCreate, promptBoxReady, updateCreate } from "./remoteCreate";
import { provisionWorktree } from "./worktree";
import { readScreen, release, submitPrompt, submitToTerminal } from "../panels/terminalPool";

/** Execute one remote action against its target instance. Exported for direct testing
 *  / reuse; `initRemoteActions` wires it to the event stream. */
export function handleRemoteAction(action: RemoteAction): void {
  if (action.type === "create") {
    void createSession(action);
    return;
  }
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

/** An answer to a pending prompt: one of its numbered options, or dismissing it. */
export type ChoiceAnswer = { option: number } | "deny";

/**
 * Answer the prompt an instance is waiting on (the desktop choice card, step T5;
 * the phone's, step R5). The keys, as verified against the TUI in T0: a digit
 * selects that option of a permission prompt, a single question or a plan
 * approval at once, with no Enter; Esc dismisses the prompt and ends the turn.
 */
export function answerChoice(instanceId: string, answer: ChoiceAnswer): void {
  if (answer === "deny") {
    void ptyWrite(instanceId, INTERRUPT_KEY);
    markInterrupted(instanceId); // dismissing fires no hook — update the dot ourselves
    return;
  }
  if (!Number.isInteger(answer.option) || answer.option < 1 || answer.option > 9) return;
  void ptyWrite(instanceId, new TextEncoder().encode(String(answer.option)));
}

/** Open (or focus) the console for an instance resolved from the registry. No-op if
 *  the id isn't a known instance. */
function startInstance(instanceId: string): void {
  const instance = getRegistry().instances.find((i) => i.id === instanceId);
  if (instance) openConsole(instance);
}

/** How often a new console's screen is looked at for the prompt box. */
const READY_POLL_MS = 250;
/** How long to wait for the prompt box before keeping the first prompt queued. */
const READY_WAIT_MS = 60_000;
/** How long, instead, once the screen has asked for an SSH password: typing it on
 *  the phone's mirror takes a while. */
const PASSWORD_WAIT_MS = 5 * 60_000;

/**
 * Start a new session from the phone (step R7): the same steps as the rail's "new
 * instance" — make the instance, show its project, open its console — plus an
 * optional worktree and first prompt. The request's record (`state/remoteCreate`)
 * makes a replayed request a no-op and tells the phone how it went.
 *
 * A worktree that can't be provisioned removes the instance again, so the phone
 * never leaves a half-made one behind. The first prompt goes in only once the TUI
 * shows its prompt box; if it never does, the prompt becomes the instance's queued
 * prompt rather than being dropped.
 */
async function createSession(action: RemoteCreateAction): Promise<void> {
  const { requestId, projectId } = action;
  if (!beginCreate(requestId)) return; // a retry or a replay: already handled
  const fail = (message: string) => updateCreate(requestId, { state: "failed", message });

  const project = getRegistry().projects.find((p) => p.id === projectId);
  if (!project) return fail("That project no longer exists.");
  const title = action.title?.trim() || nextInstanceTitle(getRegistry().instances, project.id);

  let instance: Instance;
  try {
    instance = await addInstance({ projectId: project.id, title });
  } catch (e) {
    return fail(`Could not create the session: ${errorText(e)}`);
  }
  updateCreate(requestId, { instanceId: instance.id });

  let message: string | null = null;
  if (action.worktree) {
    try {
      const setup = await provisionWorktree(instance, project);
      if (setup.failed) {
        message = `The worktree's setup command failed${
          setup.exitCode !== null ? ` (exit ${setup.exitCode})` : ""
        }.`;
      }
    } catch (e) {
      await deleteInstance(instance.id).catch(() => {});
      return updateCreate(requestId, {
        instanceId: null,
        state: "failed",
        message: `Could not make the worktree: ${errorText(e)}`,
      });
    }
    const id = instance.id;
    instance = getRegistry().instances.find((i) => i.id === id) ?? instance;
  }

  // As the rail does it: show the project, open the console, focus its panel.
  setActiveProject(project.id);
  openConsole(instance);
  activatePanel(instance.id);

  const text = action.text?.trim();
  if (!text) return updateCreate(requestId, { state: "started", message });
  updateCreate(requestId, { state: "starting", message });
  deliverWhenReady(requestId, instance.id, text, message);
}

/** Submit `text` once the console shows its prompt box, or queue it if it never does. */
function deliverWhenReady(
  requestId: string,
  instanceId: string,
  text: string,
  message: string | null,
): void {
  const started = Date.now();
  let password = false;
  const tick = () => {
    const screen = readScreen(instanceId);
    if (screen && promptBoxReady(screen)) {
      submitPrompt(instanceId, text);
      updateCreate(requestId, { state: "sent", message });
      return;
    }
    if (!password && screen && asksForPassword(screen)) {
      password = true;
      updateCreate(requestId, {
        message: "The SSH login is asking for a password — answer it in the console.",
      });
    }
    if (Date.now() - started < (password ? PASSWORD_WAIT_MS : READY_WAIT_MS)) {
      setTimeout(tick, READY_POLL_MS);
      return;
    }
    // Never ready (an untrusted folder's dialog, a login that wasn't answered…):
    // park the prompt where the desktop shows it, editable and cancellable.
    setQueued(instanceId, text);
    updateCreate(requestId, {
      state: "queued",
      message: "Claude's prompt box never appeared, so the first prompt is queued — check the console.",
    });
  };
  tick();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let subscription: Promise<unknown> | null = null;

/** Start consuming remote actions. Idempotent; never torn down. Swallows a non-Tauri
 *  host so the app still imports/runs without the backend. */
export function initRemoteActions(): void {
  if (subscription) return;
  subscription = onRemoteAction(handleRemoteAction).catch(() => {});
}
