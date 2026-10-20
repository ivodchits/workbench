// Headless workers in the webview (step D4). A console flagged headless
// (`headlessFlag.ts`) has no terminal: its `claude -p` process is started here when
// the console opens and stopped when it closes, and the console shows the
// transcript view, which reads the session's transcript as for any session.
//
// - Prompts go in as protocol messages (`sendHeadless`, used by `submitPrompt`), an
//   interrupt as the protocol's interrupt.
// - Hooks fire as in a terminal, so the status engine and the pending choice work
//   as they do. What doesn't come as a hook is made up here: `SessionStart` (it
//   doesn't fire headless), the turn's end on a `result` (should `Stop` be late),
//   compaction from the `status` messages, and `SessionEnd` when the process dies.
// - Permission requests come twice: the `PermissionRequest` hook (T4's hold, the
//   trust watcher, the pending choice) and the protocol's `can_use_tool`, kept here.
//   The first answer wins and Claude Code cancels the other. A card's answer, when
//   the hold is gone, goes back over the protocol (`answerHeadless`): no menu, no
//   keys. A plan approval is a plain allow, so its card offers it.
// - "Take over" (`takeOverHeadless`) stops the process and resumes the same
//   session in a terminal.

import {
  headlessAnswer,
  headlessInterrupt,
  headlessKill,
  headlessSend,
  headlessSpawn,
  onHeadlessEvent,
  onHeadlessExited,
  type HeadlessMessage,
  type HeadlessResponse,
} from "../ipc/headless";
import type { HookEvent } from "../ipc/hooks";
import { setActiveProject } from "./activeProject";
import { getOpenConsoles, markError, markSpawned, onConsolesChanged, resumeConsole } from "./consoles";
import { activatePanel } from "./dock";
import { isHeadless, markHeadless } from "./headlessFlag";
import { takeLaunchPrompt } from "./launchPrompt";
import {
  clearPendingChoice,
  getChoiceStates,
  getPendingChoice,
  onChoicesChanged,
  setTerminalOptions,
  type PendingChoice,
} from "./pendingChoice";
import { getRegistry } from "./registry";
import { getLiveStatuses, ingestHookEvent, markInterrupted } from "./status";

export { isHeadless, markHeadless };

/** A `can_use_tool` request waiting for an answer. */
interface Request {
  requestId: string;
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
}

const requests = new Map<string, Request[]>();
/** Instances whose worker is up (started here, not yet stopped or ended). */
const running = new Set<string>();
const starting = new Set<string>();

/** Each instance's backend calls, in order: a stop and the start after it must not
 *  pass each other. */
const chains = new Map<string, Promise<unknown>>();
function chain<T>(id: string, op: () => Promise<T>): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(op);
  chains.set(id, next);
  return next;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Feed the status engine an event the worker doesn't fire as a hook. */
function synth(instanceId: string, event: Partial<HookEvent> & { hook_event_name: string }): void {
  ingestHookEvent({
    instanceId,
    receivedAt: Math.floor(Date.now() / 1000),
    event: { session_id: "", transcript_path: null, cwd: null, permission_mode: null, tool_name: null, ...event },
  });
}

function start(instanceId: string, cwd: string, resumeSessionId: string | null): void {
  starting.add(instanceId);
  const prompt = takeLaunchPrompt(instanceId);
  void chain(instanceId, () => headlessSpawn(instanceId, cwd, resumeSessionId, prompt)).then(
    (r) => {
      starting.delete(instanceId);
      const c = getOpenConsoles().find((x) => x.instanceId === instanceId);
      if (!c?.headless || c.status !== "spawning") {
        // Closed while it started.
        void chain(instanceId, () => headlessKill(instanceId)).catch(() => {});
        return;
      }
      running.add(instanceId);
      markSpawned(instanceId, { sessionId: r.sessionId, cwd: r.cwd, argv: null });
      // The prompt is on its way: its hook may already have lit the card.
      const live = getLiveStatuses().get(instanceId);
      if (!live || live.phase === "ended") synth(instanceId, { hook_event_name: "SessionStart", source: "startup" });
    },
    (e: unknown) => {
      starting.delete(instanceId);
      markError(instanceId, `The worker couldn't start: ${errorText(e)}`);
    },
  );
}

function stop(instanceId: string): void {
  running.delete(instanceId);
  requests.delete(instanceId);
  void chain(instanceId, () => headlessKill(instanceId)).catch(() => {});
}

/** Start the consoles that just opened headless; stop the ones that closed. */
function sync(): void {
  const open = getOpenConsoles();
  // Stops first: a relaunch (spawning again) stops the old worker, then starts anew.
  for (const id of [...running]) {
    const c = open.find((x) => x.instanceId === id);
    if (!c?.headless || c.status === "dormant" || c.status === "spawning") stop(id);
  }
  for (const c of open) {
    if (c.headless && c.status === "spawning" && !running.has(c.instanceId) && !starting.has(c.instanceId))
      start(c.instanceId, c.cwd, c.resumeSessionId);
  }
}

function onMessage(id: string, msg: HeadlessMessage): void {
  if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool" && msg.request_id) {
    const list = requests.get(id) ?? [];
    list.push({
      requestId: msg.request_id,
      toolName: msg.request.tool_name ?? "",
      toolUseId: msg.request.tool_use_id ?? null,
      input: msg.request.input ?? {},
    });
    requests.set(id, list);
    return;
  }
  if (msg.type === "control_cancel_request" && msg.request_id) {
    // Answered by the hook (the trust watcher) first.
    requests.set(id, (requests.get(id) ?? []).filter((r) => r.requestId !== msg.request_id));
    return;
  }
  if (msg.type === "result") {
    requests.delete(id);
    if (getLiveStatuses().get(id)?.phase === "working") synth(id, { hook_event_name: "Stop" });
    return;
  }
  if (msg.type === "system" && msg.subtype === "status") {
    if (msg.status === "compacting") synth(id, { hook_event_name: "PreCompact" });
    else if (getLiveStatuses().get(id)?.compacting) synth(id, { hook_event_name: "PostCompact" });
  }
}

function onExited(id: string, code: number | null, stderr: string): void {
  if (!running.delete(id) && !starting.has(id)) return;
  requests.delete(id);
  clearPendingChoice(id);
  if (getLiveStatuses().get(id)?.phase !== "ended") synth(id, { hook_event_name: "SessionEnd", reason: "other" });
  const last = stderr.trim().split("\n").pop()?.trim();
  if (getOpenConsoles().some((c) => c.instanceId === id && c.headless))
    markError(id, `The worker's process ended${code !== null ? ` (exit ${code})` : ""}${last ? `: ${last}` : "."}`);
}

/** A plan in a headless worker is approved by allowing it, so its card can offer
 *  that (in a terminal its options are read off the menu). */
function offerPlans(): void {
  for (const [id, s] of getChoiceStates()) {
    const p = s.pending;
    if (p?.kind === "plan" && p.options.length === 0 && isHeadless(id))
      setTerminalOptions(id, p.id, [{ key: 1, label: "Yes, go ahead with the plan", detail: "", typed: false }]);
  }
}

/** The protocol request that `pending` is about. */
function requestFor(id: string, pending: PendingChoice | null): Request | null {
  const list = requests.get(id) ?? [];
  if (pending?.toolUseId) {
    const r = list.find((x) => x.toolUseId === pending.toolUseId);
    if (r) return r;
  }
  const named = pending ? list.filter((x) => x.toolName === pending.toolName) : [];
  return named[named.length - 1] ?? list[list.length - 1] ?? null;
}

/**
 * Answer the prompt a headless worker waits on over the protocol: an option, a
 * question's typed answer, or a denial (which ends the turn, as Esc does). False
 * when there's no request to answer (it was answered or cancelled already).
 */
export function answerHeadless(
  instanceId: string,
  answer: { option: number } | { text: string } | "deny",
  deniedMessage: string,
): boolean {
  const pending = getPendingChoice(instanceId);
  const req = requestFor(instanceId, pending);
  if (!req) return false;
  let response: HeadlessResponse;
  if (answer === "deny") response = { behavior: "deny", message: deniedMessage, interrupt: true };
  else if (pending?.kind === "question") {
    const q = pending.questions[0];
    const label = "text" in answer ? answer.text : pending.options.find((o) => o.key === answer.option)?.label;
    if (!q || !label) return false;
    response = { behavior: "allow", updatedInput: { ...req.input, answers: { [q.question]: label } } };
  } else response = { behavior: "allow", updatedInput: req.input };
  requests.set(
    instanceId,
    (requests.get(instanceId) ?? []).filter((r) => r.requestId !== req.requestId),
  );
  void headlessAnswer(instanceId, req.requestId, response).catch(() => {});
  if (answer === "deny") markInterrupted(instanceId);
  return true;
}

/** A prompt into a headless worker. */
export function sendHeadless(instanceId: string, text: string): Promise<void> {
  return headlessSend(instanceId, text);
}

/** Stop a headless worker's turn. */
export function interruptHeadless(instanceId: string): void {
  void headlessInterrupt(instanceId).catch(() => {});
  markInterrupted(instanceId);
}

/** Stop the worker and continue its session in a terminal you can type in. */
export async function takeOverHeadless(instanceId: string): Promise<void> {
  const i = getRegistry().instances.find((x) => x.id === instanceId);
  if (!i) return;
  const sessionId = getOpenConsoles().find((c) => c.instanceId === instanceId)?.sessionId ?? i.lastSessionId;
  markHeadless(instanceId, false);
  running.delete(instanceId);
  requests.delete(instanceId);
  await chain(instanceId, () => headlessKill(instanceId)).catch(() => {});
  setActiveProject(i.projectId);
  resumeConsole(i, sessionId ?? undefined);
  activatePanel(i.id);
}

let started = false;
/** Main window only; app-lifetime and idempotent. */
export function initHeadless(): void {
  if (started) return;
  started = true;
  onConsolesChanged(sync);
  onChoicesChanged(offerPlans);
  void onHeadlessEvent(onMessage).catch(() => {});
  void onHeadlessExited(onExited).catch(() => {});
}
