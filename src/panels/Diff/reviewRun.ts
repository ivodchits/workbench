// A review by a fresh agent (step A1): start a second instance in the same
// working dir with the review prompt, read its findings when its turn ends, and
// send the ticked ones to the implementing instance as review comments (V3).
//
// The reviewer is an ordinary instance — its console opens beside the diff, it
// can be watched, answered and closed like any other. Its findings come from its
// last reply in the transcript, so no text is copied by hand.

import { readFile } from "../../ipc/fs";
import type { Instance } from "../../ipc/registry";
import { readTranscriptBack } from "../../ipc/transcript";
import { openConsole } from "../../state/consoles";
import { setQueued } from "../../state/queue";
import { addInstance } from "../../state/registry";
import { promptBoxReady } from "../../state/remoteCreate";
import { addComment } from "../../state/reviewComments";
import { parseFindings, type Finding } from "../../state/reviewFindings";
import { beginReview, finishReview, getReview } from "../../state/reviews";
import { onStatusTransition } from "../../state/status";
import { readLastResponse } from "../../transcript/feed";
import { readScreen, submitPrompt } from "../terminalPool";
import { sendPendingComments } from "./sendComments";

/** How long to wait for a new console's prompt box before queueing the prompt. */
const READY_WAIT_MS = 60_000;
const READY_POLL_MS = 300;

/** Start a reviewer for `impl` with `prompt`. Resolves once the instance exists
 *  (the prompt follows when its console is ready). */
export async function startReview(impl: Instance, prompt: string): Promise<void> {
  const reviewer = await addInstance({
    projectId: impl.projectId,
    title: `review · ${impl.title}`,
    // The same files the implementing agent sees — its worktree, if it has one.
    workingDir: impl.workingDir,
    worktreeOn: false,
  });
  beginReview(impl.id, reviewer.id);
  openConsole(reviewer);
  watch(impl.id, reviewer.id);
  deliverWhenReady(reviewer.id, prompt);
}

/** Submit `text` once the console shows its prompt box, or queue it. */
function deliverWhenReady(instanceId: string, text: string): void {
  const started = Date.now();
  const tick = () => {
    const screen = readScreen(instanceId);
    if (screen && promptBoxReady(screen)) {
      submitPrompt(instanceId, text);
      return;
    }
    if (Date.now() - started < READY_WAIT_MS) setTimeout(tick, READY_POLL_MS);
    else setQueued(instanceId, text); // it shows in the queue, editable
  };
  tick();
}

/** Read the reviewer's findings when its turn ends. */
function watch(implId: string, reviewerId: string): void {
  const stop = onStatusTransition((id, phase) => {
    if (id !== reviewerId || phase !== "done") return;
    // A newer review replaced this one: nothing to report into.
    if (getReview(implId)?.reviewerId !== reviewerId) {
      stop();
      return;
    }
    stop();
    void readFindings(reviewerId).then((findings) => finishReview(implId, findings));
  });
}

/** When to read the reply after the turn ends. The end can be heard a moment
 *  before the reply's last line reaches the transcript file, so a reply without
 *  its findings block is read again before it counts as one. */
const READ_AT_MS = [0, 1000, 2500, 5000, 9000];

async function readFindings(reviewerId: string): Promise<Finding[] | null> {
  for (const ms of READ_AT_MS) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    try {
      const reply = await readLastResponse((before) => readTranscriptBack(reviewerId, before));
      const findings = reply === null ? null : parseFindings(reply);
      if (findings !== null) return findings;
    } catch {
      // the transcript isn't readable (yet): try again
    }
  }
  return null;
}

/** The ticked findings, as review comments on `impl` (with the code they point at),
 *  sent with any comments already pending. */
export async function sendFindings(
  impl: Instance,
  findings: readonly Finding[],
): Promise<{ how: "sent" | "queued"; count: number } | null> {
  const files = new Map<string, string[] | null>();
  const linesOf = async (path: string) => {
    if (!files.has(path)) {
      const full = `${impl.workingDir.replace(/[\\/]+$/, "")}/${path}`;
      files.set(path, await readFile(full).then((t) => t.split(/\r?\n/), () => null));
    }
    return files.get(path) ?? null;
  };
  for (const f of findings) {
    const lines = await linesOf(f.path);
    const quote = lines ? lines.slice(f.fromLine - 1, f.toLine).join("\n") : "";
    addComment(impl.id, {
      path: f.path,
      fromLine: f.fromLine,
      toLine: f.toLine,
      quote,
      note: `[${f.severity}] ${f.note}`,
    });
  }
  return sendPendingComments(impl.id);
}
