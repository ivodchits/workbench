// Console commands that need no panel of their own (step T3), shared by the main
// window's command bus and torn-off windows.

import { readTranscriptBack } from "../ipc/transcript";
import { readLastResponse } from "../transcript/feed";
import { flash } from "../util/flash";

/** Copy the last thing Claude said in `instanceId`'s session, as the markdown it
 *  wrote. Reads the transcript directly, so it works whichever view is showing. */
export async function copyLastResponse(instanceId: string): Promise<void> {
  try {
    const text = await readLastResponse((before) => readTranscriptBack(instanceId, before));
    if (text === null) {
      flash("no response to copy yet");
      return;
    }
    await navigator.clipboard.writeText(text);
    flash(`copied the last response · ${text.length.toLocaleString()} characters`);
  } catch (e) {
    flash(`could not copy: ${e instanceof Error ? e.message : String(e)}`);
  }
}
