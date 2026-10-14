// Putting text in a console's prompt without sending it (step V3's "add to
// prompt"): into the terminal as a paste, or — when the console shows its
// transcript, so the terminal is off screen — at the caret of its composer. The
// console is brought forward either way, so you see where the text went.

import { canShowTranscript, focusConsole, getOpenConsoles, type ConsoleSession } from "../state/consoles";
import { focusComposer, insertReferences } from "../state/composer";
import { getRegistry } from "../state/registry";
import { getViewMode } from "../state/viewMode";
import { pasteIntoTerminal } from "./terminalPool";

/** Land `text` in the instance's prompt, unsent. False when it has no running
 *  console in this window. */
export function insertIntoConsole(instanceId: string, text: string): boolean {
  const session = getOpenConsoles().find((c) => c.instanceId === instanceId);
  if (!session || session.status !== "running" || session.tornOff) return false;
  focusConsole(instanceId);
  if (canShowTranscript(session) && getViewMode(instanceId) === "transcript") {
    insertReferences(instanceId, text);
    focusComposer(instanceId);
    return true;
  }
  return pasteIntoTerminal(instanceId, text);
}

/** The console a project's editor talks to: its running console focused last. */
export function promptTargetFor(projectId: string): ConsoleSession | null {
  const ids = new Set(
    getRegistry()
      .instances.filter((i) => i.projectId === projectId)
      .map((i) => i.id),
  );
  let best: ConsoleSession | null = null;
  for (const c of getOpenConsoles()) {
    if (!ids.has(c.instanceId) || c.status !== "running" || c.tornOff || c.kind !== "claude") continue;
    if (!best || c.focusSeq > best.focusSeq) best = c;
  }
  return best;
}
