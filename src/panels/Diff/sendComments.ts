// Sending an instance's pending review comments as one prompt (steps V3, A1):
// the review panel's "send" and the fresh agent's ticked findings both go here.

import { getQueued, setQueued } from "../../state/queue";
import { buildCommentsPrompt, clearComments, getComments } from "../../state/reviewComments";
import { sendOrQueue } from "../promptDelivery";

/** Send every pending comment of `instanceId` and clear them. Sent now when the
 *  agent is between turns, queued otherwise; the queue holds one prompt, so one
 *  already waiting is kept ahead of these. Null when there was nothing to send. */
export function sendPendingComments(instanceId: string): { how: "sent" | "queued"; count: number } | null {
  const comments = getComments(instanceId);
  if (comments.length === 0) return null;
  const prompt = buildCommentsPrompt(comments);
  const waiting = getQueued(instanceId)?.text;
  const how = sendOrQueue(instanceId, prompt);
  if (how === "queued" && waiting) setQueued(instanceId, `${waiting}\n\n${prompt}`);
  clearComments(instanceId);
  return { how, count: comments.length };
}
