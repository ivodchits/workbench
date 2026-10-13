// Prompt delivery (steps 3.5, T4) — the one place a prompt written in the app (the
// queue dialog, the transcript view's composer, a template sent to a transcript
// console) reaches a session: sent now if the agent is between turns, otherwise
// parked in the queue and sent when the turn finishes.
//
// Panel layer, not state: it writes to terminals. The queue store itself stays
// pure (`state/queue`).

import { submitPrompt } from "./terminalPool";
import { atRest, cancelQueued, getQueued, setQueued } from "../state/queue";
import { getLiveStatuses, onStatusTransition } from "../state/status";

/** Send `text` to `instanceId` now, or queue it if its agent is mid-turn. A prompt
 *  is never sent into a pending permission prompt or question — it could answer
 *  it — so "waiting on you" queues too. Queueing replaces a prompt already queued. */
export function sendOrQueue(instanceId: string, text: string): "sent" | "queued" {
  if (atRest(getLiveStatuses().get(instanceId))) {
    submitPrompt(instanceId, text);
    return "sent";
  }
  setQueued(instanceId, text);
  return "queued";
}

let users = 0;
let unsubscribe: (() => void) | null = null;

/** Start sending queued prompts as their agents finish a turn (live phase →
 *  "done"). Returns a release function; the subscription is shared and lasts
 *  while anyone holds it. */
export function initQueueDelivery(): () => void {
  if (users++ === 0) {
    unsubscribe = onStatusTransition((instanceId, phase) => {
      if (phase !== "done") return;
      const q = getQueued(instanceId);
      if (!q) return;
      // Clear first, so the prompt's own later Stop can't re-fire a stale entry.
      cancelQueued(instanceId);
      submitPrompt(instanceId, q.text);
    });
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
