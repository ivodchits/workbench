// Duck's prompt delivery: one line per session, and a prompt counts as delivered
// only when Claude Code says it took it (the `UserPromptSubmit` hook, or the session
// turning to working). Before this, each prompt watched the screen on its own: two
// sent to a starting session pasted into its box at the same moment and ran
// together, and the check that re-sends a dropped Enter looked for each one's own
// text, which neither matched, so both sat there unsent.
//
// - A session that isn't running is started with the prompt on claude's command
//   line (`launchPrompt.ts`), so nothing is typed into a TUI that may not take
//   input yet. A prompt too long for the command line, or for an SSH project
//   (whose launch can't carry it), waits for the prompt box and is typed.
// - A running session between turns gets it typed now. Otherwise it waits here for
//   the turn to end, and everything waiting then goes in as one prompt: one turn
//   for all of it, as a person would type it.
// - A prompt marked `now` goes into a running turn instead: Claude Code takes typed
//   input mid-turn and reads it at its next step (a correction, a constraint). Never
//   into a session waiting on a permission prompt or question, which a keystroke
//   could answer: that one waits like the rest.
// - Typed prompts whose Enter wasn't taken get up to two more Enters while the box
//   holds text. A prompt still not taken is reported, never claimed as sent.
// - A slash command runs in Claude Code itself and fires no `UserPromptSubmit`
//   (a `/compact` only starts compacting), so its leaving the box, or the
//   compaction starting, says it was taken. Before, every `/compact` sent this way
//   was reported unsent while it compacted.
// - Nothing waits on a single event: what's waiting is looked at again every few
//   seconds, so a turn end that was missed, or that came while the session was
//   still compacting, can't strand it.
// - A headless worker (step D4) has no box: its prompts go in as protocol messages,
//   the first one with its launch, and the same hook says they were taken.
//
// State layer that writes to terminals, as `remoteActions.ts` does.

import { ENTER_KEY, ptyWrite } from "../ipc/pty";
import { onHookEvent } from "../ipc/hooks";
import { readScreen, submitPrompt } from "../panels/terminalPool";
import { clearLaunchPrompt, LAUNCH_PROMPT_MAX, setLaunchPrompt } from "./launchPrompt";
import { isHeadless, sendHeadless } from "./headless";
import { atRest } from "./queue";
import { inputHasText, inputHolds, promptBoxReady, trustDialogOffset } from "./remoteCreate";
import { getLiveStatuses, onCompactionEnd, onStatusTransition } from "./status";

/** How a prompt ended: taken by Claude Code, or not (with why). */
export type Outcome = { ok: true } | { ok: false; why: string };

/** Where a prompt is now, and its end. */
export interface Delivery {
  /** `sent`: going in now (`done` says whether it was taken). `queued`: waiting for
   *  the session's turn to end. `starting`: its console is starting with it. */
  state: "sent" | "queued" | "starting";
  done: Promise<Outcome>;
}

export interface Target {
  instanceId: string;
  /** Its console is up (a PTY is running). */
  running: () => boolean;
  /** Start (or resume) its console. A launch prompt, when set, is already waiting. */
  launch: () => void;
  /** The launch can't carry a prompt (an SSH project): type it once the box shows. */
  typedOnly?: boolean;
  /** Answer Claude Code's folder-trust dialog (a folder Workbench made itself). */
  trustFolder?: boolean;
}

/** How long a just-launched session gets to take its first prompt (start, trust
 *  dialog, a slow resume). */
const LAUNCH_ACK_MS = 90_000;
/** After a typed prompt's Enter, how long before looking again, each time. */
const ENTER_RETRY_MS = 2_000;
const ENTER_RETRIES = 2;
/** The prompt box has to have been on screen this long before a paste goes in
 *  (`remoteActions.ts`, READY_SETTLE_MS: the TUI draws it before it takes input). */
const READY_SETTLE_MS = 1_000;
const POLL_MS = 250;
/** How often a line with prompts waiting is looked at again. */
const PUMP_WATCH_MS = 2_000;
/** A prompt taken by a sign other than its hook (a slash command like `/model`,
 *  which starts no turn) holds the line this long, or until the session moves. */
const IN_TURN_GRACE_MS = 5_000;
const TRUST_KEY_GAP_MS = 400;
const TRUST_KEYS_MAX = 6;
const DOWN_KEY = new Uint8Array([0x1b, 0x5b, 0x42]);
const UP_KEY = new Uint8Array([0x1b, 0x5b, 0x41]);
/** Between prompts sent as one. */
const JOIN = "\n\n";

interface Item {
  target: Target;
  text: string;
  /** Into the running turn, rather than after it. */
  now: boolean;
  settle: (o: Outcome) => void;
}

interface Line {
  /** Prompts being delivered, until taken or given up on. */
  busy: boolean;
  /** Taken; their turn hasn't ended yet, so the next ones wait. */
  inTurn: boolean;
  /** When the last prompt was taken (epoch ms). */
  takenAt: number;
  waiting: Item[];
}

const lines = new Map<string, Line>();

function line(id: string): Line {
  let l = lines.get(id);
  if (!l) {
    l = { busy: false, inTurn: false, takenAt: 0, waiting: [] };
    lines.set(id, l);
  }
  return l;
}

// ── the "taken" signal ──────────────────────────────────────────────────────

/** How Claude Code showed it took input: its hook (or the turn starting), or a
 *  compaction starting, which only a `/compact` counts on. */
type Sign = "prompt" | "compact";

const takers = new Map<string, Set<(sign: Sign) => void>>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  void onHookEvent((env) => {
    const name = env.event.hook_event_name;
    if (name === "UserPromptSubmit") taken(env.instanceId, "prompt");
    else if (name === "PreCompact") taken(env.instanceId, "compact");
  }).catch(() => {});
  onStatusTransition((id, phase) => {
    if (phase === "working") taken(id, "prompt");
    // The turn is over: what's waiting may go.
    if (phase === "done" || phase === "idle" || phase === "ended") turnEnded(id);
    // Waiting on a prompt no more: a `now` prompt held back for it may go in.
    else pump(id);
  });
  onCompactionEnd((id, live) => {
    if (atRest(live)) turnEnded(id);
    else pump(id);
  });
}

function taken(id: string, sign: Sign): void {
  for (const f of takers.get(id) ?? []) f(sign);
}

/** Resolves true when Claude Code takes a prompt in `id`, false after `ms`.
 *  `compact`: a compaction starting counts too (the prompt is a `/compact`). */
function whenTaken(id: string, ms: number, compact = false): { promise: Promise<boolean>; cancel: () => void } {
  let done: (v: boolean) => void = () => {};
  const promise = new Promise<boolean>((r) => (done = r));
  const set = takers.get(id) ?? new Set();
  takers.set(id, set);
  const finish = (v: boolean) => {
    clearTimeout(timer);
    set.delete(on);
    done(v);
  };
  const on = (sign: Sign) => {
    if (sign === "prompt" || compact) finish(true);
  };
  const timer = setTimeout(() => finish(false), ms);
  set.add(on);
  return { promise, cancel: () => finish(false) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── delivering ──────────────────────────────────────────────────────────────

/** Type `text` into the prompt box and make sure its Enter was taken. Mid-turn,
 *  the text leaving the box is the sign: Claude Code queues it for its next step,
 *  and the hook comes only then. */
async function typeIn(id: string, text: string, midTurn: boolean): Promise<Outcome> {
  if (isHeadless(id)) return sendIn(id, text, midTurn);
  const command = isCommand(text);
  const t = whenTaken(id, ENTER_RETRY_MS * (ENTER_RETRIES + 1) + 1_000, COMPACT_COMMAND.test(text.trimStart()));
  submitPrompt(id, text);
  for (let i = 0; i <= ENTER_RETRIES; i++) {
    if (await Promise.race([t.promise, sleep(ENTER_RETRY_MS).then(() => false)])) return { ok: true };
    const screen = readScreen(id);
    if ((midTurn || command) && screen && !inputHolds(screen, text)) {
      t.cancel();
      return { ok: true };
    }
    if (i === ENTER_RETRIES) break;
    if (screen ? inputHasText(screen) : blindEnterSafe(id, command, midTurn)) void ptyWrite(id, ENTER_KEY).catch(() => {});
  }
  t.cancel();
  return { ok: false, why: "it was typed into the session's prompt box, but Claude Code didn't take it" };
}

/** A slash command: Claude Code runs it itself, with no `UserPromptSubmit`. */
const isCommand = (text: string) => text.trimStart().startsWith("/");
const COMPACT_COMMAND = /^\/compact\b/;

/** With no screen to see the box by, whether a second Enter is still safe: the
 *  session is between turns as it was (nothing took the prompt, so no permission
 *  prompt can have opened), and the prompt isn't a command, which may have opened
 *  a picker the Enter would answer. */
function blindEnterSafe(id: string, command: boolean, midTurn: boolean): boolean {
  return !command && !midTurn && atRest(getLiveStatuses().get(id));
}

/** Type `text` into a running session's prompt box, outside Duck's lines (the
 *  composer, the queue), re-sending its Enter while it isn't taken. `midTurn`: the
 *  session is working, so Claude Code's own queue takes it at its next step. */
export function typePrompt(id: string, text: string, midTurn: boolean): Promise<Outcome> {
  listen();
  return typeIn(id, text, midTurn);
}

/** How long a headless worker gets to take a prompt sent between turns. */
const HEADLESS_ACK_MS = 15_000;

/** A prompt into a headless worker, as a protocol message. Mid-turn, Claude Code
 *  queues it for its next step; between turns, the hook says it was taken. */
async function sendIn(id: string, text: string, midTurn: boolean): Promise<Outcome> {
  const t = whenTaken(id, HEADLESS_ACK_MS);
  try {
    await sendHeadless(id, text);
  } catch (e) {
    t.cancel();
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (midTurn) {
    t.cancel();
    return { ok: true };
  }
  return (await t.promise) ? { ok: true } : { ok: false, why: "it was sent to the worker, but Claude Code didn't take it" };
}

/** Watch a starting console: answer the trust dialog when asked to, and resolve
 *  once the prompt box has shown for a moment (false: it never did). */
async function untilReady(id: string, trustFolder: boolean, ms: number, stop?: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  let since: number | null = null;
  let keys = 0;
  let keyAt = 0;
  while (Date.now() < end && !stop?.()) {
    const screen = readScreen(id);
    const offset = trustFolder && screen ? trustDialogOffset(screen) : null;
    if (offset !== null && keys < TRUST_KEYS_MAX && Date.now() - keyAt >= TRUST_KEY_GAP_MS) {
      keys++;
      keyAt = Date.now();
      void ptyWrite(id, offset === 0 ? ENTER_KEY : offset > 0 ? DOWN_KEY : UP_KEY).catch(() => {});
    }
    if (screen && promptBoxReady(screen)) {
      since ??= Date.now();
      if (Date.now() - since >= READY_SETTLE_MS) return true;
    } else since = null;
    await sleep(POLL_MS);
  }
  return false;
}

/** Start the session with the prompt and wait for it to be taken. */
async function launchWith(target: Target, text: string): Promise<Outcome> {
  const id = target.instanceId;
  // A headless worker's launch takes any prompt, and shows no dialog.
  const headless = isHeadless(id);
  if (!headless && (target.typedOnly || text.length > LAUNCH_PROMPT_MAX)) {
    target.launch();
    if (!(await untilReady(id, !!target.trustFolder, 60_000)))
      return { ok: false, why: "the session's prompt box never appeared, so the prompt wasn't typed" };
    return typeIn(id, text, false);
  }
  const t = whenTaken(id, LAUNCH_ACK_MS);
  setLaunchPrompt(id, text);
  target.launch();
  // The prompt waits in claude's command line; only the trust dialog needs a hand.
  let settled = false;
  if (target.trustFolder && !headless) void untilReady(id, true, LAUNCH_ACK_MS, () => settled);
  const ok = await t.promise;
  settled = true;
  clearLaunchPrompt(id); // not taken by a spawn (the console didn't start)
  return ok ? { ok: true } : { ok: false, why: "the session was started with the prompt, but Claude Code didn't take it" };
}

type How = "launch" | "typed" | "midTurn";

/** Deliver `batch` as one prompt; each of its prompts hears the outcome. */
async function run(batch: Item[], how: How, l: Line): Promise<void> {
  const { target } = batch[0];
  const id = target.instanceId;
  const text = batch.map((i) => i.text).join(JOIN);
  l.busy = true;
  let out: Outcome;
  try {
    out = how === "launch" ? await launchWith(target, text) : await typeIn(id, text, how === "midTurn");
  } catch (e) {
    out = { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  l.busy = false;
  // A prompt into a running turn doesn't start a turn of its own.
  if (out.ok && how !== "midTurn") {
    l.inTurn = true;
    l.takenAt = Date.now();
  }
  for (const i of batch) i.settle(out);
  pump(id);
}

/** The session is working (not waiting on you, not compacting): typed input goes
 *  into Claude Code's own queue for its next step. */
function working(id: string): boolean {
  const s = getLiveStatuses().get(id);
  return !!s && s.phase === "working" && !s.compacting;
}

/** Send what's waiting, if the session can take it: all of it as one prompt, or
 *  mid-turn only the prompts marked `now`. */
function pump(id: string): void {
  const l = lines.get(id);
  if (!l || l.busy || l.waiting.length === 0) return;
  const target = l.waiting[0].target;
  if (!target.running()) {
    l.inTurn = false; // a session that isn't running is in no turn
    void run(l.waiting.splice(0), "launch", l);
    return;
  }
  const rest = atRest(getLiveStatuses().get(id));
  // Taken a while ago, and the session never left rest: that prompt started no
  // turn (a command), or its turn's end was missed.
  if (l.inTurn && rest && Date.now() - l.takenAt >= IN_TURN_GRACE_MS) l.inTurn = false;
  if (!l.inTurn && rest) {
    void run(l.waiting.splice(0), "typed", l);
    return;
  }
  if (!working(id)) return; // waiting on you, or compacting
  const now = l.waiting.filter((i) => i.now);
  if (now.length === 0) return;
  l.waiting = l.waiting.filter((i) => !i.now);
  void run(now, "midTurn", l);
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** Look at every line with prompts waiting every few seconds, while there are any:
 *  the turn's end (or the compaction's) is the usual trigger, and this is for one
 *  that was missed. */
function watch(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    let any = false;
    for (const [id, l] of lines) {
      if (l.waiting.length === 0) continue;
      any = true;
      pump(id);
    }
    if (!any && watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }, PUMP_WATCH_MS);
}

/** True while Duck's delivery holds a prompt for `id`: being typed in, or waiting
 *  for the turn to end. Until then the session isn't really done with its work:
 *  `wait_for_session` and the autopilot hold off. */
export function promptPending(id: string): boolean {
  const l = lines.get(id);
  return !!l && (l.busy || l.waiting.length > 0);
}

function turnEnded(id: string): void {
  const l = lines.get(id);
  if (!l) return;
  l.inTurn = false;
  pump(id);
}

/**
 * Deliver `text` to a session: now, combined with what's waiting when its turn
 * ends, or by starting its console with it. `now` sends it into a running turn.
 * `done` says whether Claude Code took it.
 */
export function deliverPrompt(target: Target, text: string, opts: { now?: boolean } = {}): Delivery {
  listen();
  const id = target.instanceId;
  const l = line(id);
  let settle: (o: Outcome) => void = () => {};
  const done = new Promise<Outcome>((r) => (settle = r));
  const item: Item = { target, text, now: !!opts.now, settle };
  const running = target.running();
  l.waiting.push(item);
  pump(id);
  if (l.waiting.length > 0) watch();
  return { state: l.waiting.includes(item) ? "queued" : running ? "sent" : "starting", done };
}
