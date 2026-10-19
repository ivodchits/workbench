// Remote action handler (step 4.3, design §11) — the **single place** that maps an
// action from a remote client onto a local effect. The remote server is pure
// transport: it forwards each action as a `remote-action` event and never touches a
// PTY itself, so the keystroke mapping (approve/deny/interrupt) and the lifecycle
// calls (start/stop/prompt/create) and the answer to a pending prompt (choose) all live here, one definition each. A TUI keystroke
// change is therefore a one-line fix here (the §11 caveat).
//
// Mirrors the other engines: a permanent, idempotent subscription (a stored promise,
// not a boolean, to survive StrictMode's double mount). Main window only — it's wired
// from `App.tsx`, not the torn-off window.

import { ENTER_KEY, INTERRUPT_KEY, ptyWrite } from "../ipc/pty";
import { onRemoteAction, type RemoteAction } from "../ipc/remote";
import type { Instance, Project } from "../ipc/registry";
import type { RemoteChooseAction, RemoteCreateAction } from "../remote/protocol";
import { addInstance, deleteInstance, getRegistry, nextInstanceTitle } from "./registry";
import { markInterrupted } from "./status";
import { getPendingChoice, markChoiceSent } from "./pendingChoice";
import { closeConsole, openConsole } from "./consoles";
import { setActiveProject } from "./activeProject";
import { activatePanel } from "./dock";
import { encodePaste } from "./composer";
import { setQueued } from "./queue";
import {
  asksForPassword,
  beginCreate,
  inputHolds,
  promptBoxReady,
  updateCreate,
} from "./remoteCreate";
import { provisionWorktree } from "./worktree";
import { readScreen, release, submitPrompt, submitToTerminal } from "../panels/terminalPool";

/** Execute one remote action against its target instance. Exported for direct testing
 *  / reuse; `initRemoteActions` wires it to the event stream. */
export function handleRemoteAction(action: RemoteAction): void {
  if (action.type === "create") {
    void createSession(action);
    return;
  }
  if (action.type === "choose") {
    chooseRemote(action);
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
      // Not a plan: its first option can be "yes, and use auto mode", so a plan is
      // only approved through one of its options read off the screen (`choose`).
      if (getPendingChoice(instanceId)?.kind === "plan") break;
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

/** After the digit of a typed option, how long the TUI takes to open its field. */
const TYPED_FIELD_MS = 500;
/** After the pasted text, before its Enter (a paste and its Enter in one chunk can
 *  lose the Enter). */
const TYPED_ENTER_MS = 300;

/**
 * Answer a question with free text: the digit of its "Type something" row opens a
 * text field, the text goes in as a paste, and Enter answers. Verified in a scratch
 * PTY against Claude Code 2.1.304 (single question: digit n+1, then the text).
 */
export function answerChoiceText(instanceId: string, key: number, text: string): void {
  if (!Number.isInteger(key) || key < 1 || key > 9) return;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  void ptyWrite(instanceId, new TextEncoder().encode(String(key)))
    .then(() => wait(TYPED_FIELD_MS))
    .then(() => ptyWrite(instanceId, encodePaste(text)))
    .then(() => wait(TYPED_ENTER_MS))
    .then(() => ptyWrite(instanceId, ENTER_KEY))
    .catch(() => {}); // the PTY is gone: nothing to answer
}

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

/**
 * The phone answering a prompt (step R5). Only the prompt it was shown counts: a
 * tap that arrives after that prompt closed — answered in the terminal, replaced by
 * the next one — or after an answer was already sent, does nothing.
 */
function chooseRemote(action: RemoteChooseAction): void {
  const { instanceId, choiceId, option } = action;
  const pending = getPendingChoice(instanceId);
  if (!pending || pending.id !== choiceId || pending.sent) return;
  if (option === "deny") {
    answerChoice(instanceId, "deny");
    markChoiceSent(instanceId, choiceId, pending.kind === "permission" ? "deny" : "cancel");
    return;
  }
  const picked = pending.terminalOnly ? undefined : pending.options.find((o) => o.key === option);
  if (!picked) return;
  answerChoice(instanceId, { option: picked.key });
  markChoiceSent(instanceId, choiceId, picked.label);
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
/** How long the prompt box has to have been on screen before the prompt goes in.
 *  Claude Code draws the box before it takes input: a prompt pasted at once lands in
 *  it but its Enter is dropped, and the prompt sits there unsent. In a scratch PTY
 *  (Claude Code 2.1.304) 250 ms after the box showed still lost the Enter; 500 ms
 *  and more never did. */
const READY_SETTLE_MS = 1000;
/** After the Enter, when to look whether the prompt is still sitting in the box. */
const ENTER_CHECK_MS = 1000;
/** How long, instead, once the screen has asked for an SSH password: typing it on
 *  the phone's mirror takes a while. */
const PASSWORD_WAIT_MS = 5 * 60_000;

/** A new session's first prompt: in, or parked on the card because the prompt box
 *  never showed. */
export type FirstPromptState = "sent" | "queued";

/**
 * Make a session the way the rail's "new instance" does — the instance, an optional
 * worktree, its project shown, its console open and focused — for the phone (R7)
 * and Duck (W2). `onCreated` hears the instance id as soon as it exists.
 *
 * A worktree that can't be provisioned removes the instance again, so no half-made
 * one is left behind. Throws an Error whose message says what failed; `message` on
 * success is something worth knowing (a setup command failed).
 */
export async function startNewSession(
  project: Project,
  opts: { title?: string; worktree?: boolean; model?: string | null },
  onCreated?: (instanceId: string) => void,
): Promise<{ instance: Instance; message: string | null }> {
  const title = opts.title?.trim() || nextInstanceTitle(getRegistry().instances, project.id);
  let instance: Instance;
  try {
    instance = await addInstance({ projectId: project.id, title, model: opts.model ?? null });
  } catch (e) {
    throw new Error(`Could not create the session: ${errorText(e)}`);
  }
  onCreated?.(instance.id);

  let message: string | null = null;
  if (opts.worktree) {
    try {
      const setup = await provisionWorktree(instance, project);
      if (setup.failed) {
        message = `The worktree's setup command failed${
          setup.exitCode !== null ? ` (exit ${setup.exitCode})` : ""
        }.`;
      }
    } catch (e) {
      await deleteInstance(instance.id).catch(() => {});
      throw new Error(`Could not make the worktree: ${errorText(e)}`);
    }
    const id = instance.id;
    instance = getRegistry().instances.find((i) => i.id === id) ?? instance;
  }

  // As the rail does it: show the project, open the console, focus its panel.
  setActiveProject(project.id);
  openConsole(instance);
  activatePanel(instance.id);
  return { instance, message };
}

/**
 * Start a new session from the phone (step R7): `startNewSession` plus an optional
 * first prompt. The request's record (`state/remoteCreate`) makes a replayed
 * request a no-op and tells the phone how it went.
 */
async function createSession(action: RemoteCreateAction): Promise<void> {
  const { requestId, projectId } = action;
  if (!beginCreate(requestId)) return; // a retry or a replay: already handled

  const project = getRegistry().projects.find((p) => p.id === projectId);
  if (!project) return updateCreate(requestId, { state: "failed", message: "That project no longer exists." });

  let made: { instance: Instance; message: string | null };
  try {
    made = await startNewSession(
      project,
      { title: action.title, worktree: action.worktree, model: action.model },
      (instanceId) => updateCreate(requestId, { instanceId }),
    );
  } catch (e) {
    return updateCreate(requestId, { instanceId: null, state: "failed", message: errorText(e) });
  }
  const { instance, message } = made;

  const text = action.text?.trim();
  if (!text) return updateCreate(requestId, { state: "started", message });
  updateCreate(requestId, { state: "starting", message });
  deliverWhenReady(instance.id, text, {
    password: () =>
      updateCreate(requestId, {
        message: "The SSH login is asking for a password — answer it in the console.",
      }),
    done: (state) =>
      updateCreate(
        requestId,
        state === "sent"
          ? { state: "sent", message }
          : {
              state: "queued",
              message: "Claude's prompt box never appeared, so the first prompt is queued — check the console.",
            },
      ),
  });
}

/**
 * Submit `text` once a just-opened console shows its prompt box, and has shown it
 * for `READY_SETTLE_MS`. If the prompt is still in the box a moment after its
 * Enter, the Enter was dropped and is sent once more. If the box never shows (an
 * untrusted folder's dialog, a login that wasn't answered…), the prompt becomes the
 * instance's queued prompt, editable and cancellable on its card, rather than being
 * dropped. `password` hears that the screen asked for an SSH password (the wait is
 * longer then).
 */
export function deliverWhenReady(
  instanceId: string,
  text: string,
  on: { password?: () => void; done?: (state: FirstPromptState) => void } = {},
): void {
  const started = Date.now();
  let password = false;
  let readySince: number | null = null;
  const tick = () => {
    const screen = readScreen(instanceId);
    if (screen && promptBoxReady(screen)) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= READY_SETTLE_MS) {
        submitPrompt(instanceId, text);
        setTimeout(() => {
          const now = readScreen(instanceId);
          if (now && inputHolds(now, text)) void ptyWrite(instanceId, ENTER_KEY);
        }, ENTER_CHECK_MS);
        on.done?.("sent");
        return;
      }
    } else {
      readySince = null;
    }
    if (!password && screen && asksForPassword(screen)) {
      password = true;
      on.password?.();
    }
    if (Date.now() - started < (password ? PASSWORD_WAIT_MS : READY_WAIT_MS)) {
      setTimeout(tick, READY_POLL_MS);
      return;
    }
    setQueued(instanceId, text);
    on.done?.("queued");
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
