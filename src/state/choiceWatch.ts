// Choice watch (step R5) — keeps every pending prompt complete without a choice
// card on screen, so the phone sees the same prompt the desktop card would.
//
// The desktop card (`panels/ChoiceCard.tsx`) does two things only while it is
// shown: it reads a permission or plan prompt's options off the terminal screen,
// and its transcript view reports the conversation, which is the only record of a
// prompt refused with "No" or dismissed with Esc (no hook fires, T0). A phone
// answering a prompt whose console shows the terminal — or sits in another tab —
// needs both, so here they happen for every prompt that is open: the screen is read
// on the card's schedule, and the instance's transcript is followed until the
// prompt closes.
//
// Main window only, like the remote action handler; app-lifetime and idempotent.

import { readScreen } from "../panels/terminalPool";
import { instanceSource } from "../transcript/desktopSource";
import { createFeed, type Feed } from "../transcript/feed";
import {
  getChoiceStates,
  onChoicesChanged,
  parseOptionRows,
  READ_AT_MS,
  reconcileWithTranscript,
  setTerminalOptions,
} from "./pendingChoice";

interface Watch {
  /** The prompt being watched. */
  id: string;
  /** Its hook response is held (T4): no menu on screen yet. */
  held: boolean;
  feed: Feed;
  reads: ReturnType<typeof setTimeout>[];
}

const watches = new Map<string, Watch>();

function readOptions(instanceId: string, id: string): ReturnType<typeof setTimeout>[] {
  return READ_AT_MS.map((ms) =>
    setTimeout(() => {
      const screen = readScreen(instanceId);
      const options = screen && parseOptionRows(screen);
      if (options) setTerminalOptions(instanceId, id, options);
    }, ms),
  );
}

function unwatch(instanceId: string): void {
  const w = watches.get(instanceId);
  if (!w) return;
  w.reads.forEach(clearTimeout);
  w.feed.stop();
  watches.delete(instanceId);
}

function sync(): void {
  const states = getChoiceStates();
  for (const [instanceId, state] of states) {
    const pending = state.pending;
    const w = watches.get(instanceId);
    if (!pending) {
      unwatch(instanceId);
      continue;
    }
    const held = pending.held !== null;
    const reads = () => (pending.source === "generic" && !held ? readOptions(instanceId, pending.id) : []);
    if (w?.id === pending.id) {
      // Released without a decision: the menu is drawn now.
      if (w.held && !held) w.reads = reads();
      w.held = held;
      continue;
    }
    if (w) {
      // A new prompt on the same instance: keep following, read its options anew,
      // and check it against what the conversation already shows.
      w.reads.forEach(clearTimeout);
      w.id = pending.id;
      w.held = held;
      w.reads = reads();
      if (w.feed.ready) reconcileWithTranscript(instanceId, w.feed.items);
      continue;
    }
    const feed = createFeed(instanceSource(instanceId), (why) => {
      if (why !== "loading" && feed.ready) reconcileWithTranscript(instanceId, feed.items);
    });
    watches.set(instanceId, { id: pending.id, held, feed, reads: reads() });
  }
  for (const instanceId of [...watches.keys()]) {
    if (!states.get(instanceId)?.pending) unwatch(instanceId);
  }
}

let started = false;
export function initChoiceWatch(): void {
  if (started) return;
  started = true;
  onChoicesChanged(sync);
  sync();
}
