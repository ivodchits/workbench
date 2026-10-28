// Prompt delivery (steps 3.5, T4) — the one place a prompt written in the app (the
// queue dialog, the transcript view's composer, a template sent to a transcript
// console) reaches a session: sent now if the agent is between turns, otherwise
// parked in the queue and sent when the turn finishes.
//
// Panel layer, not state: it writes to terminals. The queue store itself stays
// pure (`state/queue`).

import { readScreen } from "./terminalPool";
import { typePrompt } from "../state/promptOutbox";
import { atRest, cancelQueued, getQueued, setQueued } from "../state/queue";
import { promptBoxReady } from "../state/remoteCreate";
import { getLiveStatuses, onCompactionEnd, onStatusTransition } from "../state/status";

/** Type `text` in and see its Enter taken: a busy TUI can leave a typed prompt in
 *  its box unsent, so the Enter is re-sent while the box still holds it. */
function submit(instanceId: string, text: string): void {
  const midTurn = !atRest(getLiveStatuses().get(instanceId));
  void typePrompt(instanceId, text, midTurn).then((out) => {
    if (!out.ok) console.warn(`prompt to ${instanceId}: ${out.why}`);
  });
}

/** Send `text` to `instanceId` now, or queue it if its agent is mid-turn. A prompt
 *  is never sent into a pending permission prompt or question — it could answer
 *  it — so "waiting on you" queues too, and so does a session that hasn't started
 *  (`starting`). Queueing replaces a prompt already queued. */
export function sendOrQueue(instanceId: string, text: string): "sent" | "queued" {
  const start = starting(instanceId);
  if (!start && atRest(getLiveStatuses().get(instanceId))) {
    submit(instanceId, text);
    return "sent";
  }
  setQueued(instanceId, text);
  if (start) watchStart(instanceId);
  return "queued";
}

/** True when a console hasn't started its session yet: no hook has come from it,
 *  and its screen shows something other than the prompt box — Claude Code's trust
 *  or MCP-server dialog, a login. No hook fires while such a dialog is up, so the
 *  session looks at rest, but a prompt typed then goes into the dialog and its
 *  Enter answers it. A console this window can't see is taken as started. */
export function starting(instanceId: string): boolean {
  if (getLiveStatuses().get(instanceId)) return false;
  const screen = readScreen(instanceId);
  return !!screen && !promptBoxReady(screen);
}

/** The prompt box has to have been on screen this long before a prompt goes in:
 *  the TUI draws it before it takes input (`remoteActions.ts`, READY_SETTLE_MS). */
const READY_SETTLE_MS = 1_000;
const START_POLL_MS = 250;
const watching = new Set<string>();

/** Send the prompt queued for a starting console once its prompt box has shown for
 *  a moment. Stops when nothing is queued any more, when the console goes, or when
 *  hooks arrive with the session mid-turn (its Stop sends the prompt then). */
function watchStart(instanceId: string): void {
  if (watching.has(instanceId)) return;
  watching.add(instanceId);
  let since: number | null = null;
  const tick = () => {
    const screen = readScreen(instanceId);
    const live = getLiveStatuses().get(instanceId);
    if (!getQueued(instanceId) || !screen || !atRest(live)) {
      watching.delete(instanceId);
      return;
    }
    if (promptBoxReady(screen)) {
      since ??= Date.now();
      if (Date.now() - since >= READY_SETTLE_MS) {
        watching.delete(instanceId);
        deliverQueued(instanceId);
        return;
      }
    } else since = null;
    setTimeout(tick, START_POLL_MS);
  };
  setTimeout(tick, START_POLL_MS);
}

let users = 0;
let unsubscribe: (() => void) | null = null;

/** Send the prompt queued for `instanceId`, if any. Cleared first, so the prompt's
 *  own later Stop can't re-fire a stale entry. Also the queue's "force send": typed
 *  into a working TUI, the prompt goes into Claude Code's own queue, which takes it
 *  in at the turn's next step (or as soon as the turn ends). */
export function deliverQueued(instanceId: string): void {
  const q = getQueued(instanceId);
  if (!q) return;
  cancelQueued(instanceId);
  submit(instanceId, q.text);
}

/** Start sending queued prompts as their agents finish a turn (live phase →
 *  "done"), or finish compacting back to rest — a `/compact` from an idle session
 *  ends with no phase change, so the turn boundary alone would strand the prompt.
 *  Returns a release function; the subscription is shared and lasts while anyone
 *  holds it. */
export function initQueueDelivery(): () => void {
  if (users++ === 0) {
    const offTransition = onStatusTransition((instanceId, phase) => {
      if (phase === "done") deliverQueued(instanceId);
    });
    // Mid-turn auto-compaction lifts back into "working": still held for the Stop.
    const offCompaction = onCompactionEnd((instanceId, live) => {
      if (atRest(live)) deliverQueued(instanceId);
    });
    unsubscribe = () => {
      offTransition();
      offCompaction();
    };
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--users === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}
