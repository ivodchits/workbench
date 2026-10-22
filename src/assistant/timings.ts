// How long Duck's turns take, and on which brain (step D3). D3 asks whether a
// rubber duck or a chat thinking on your subscription (M3's brain) keeps up with
// the API, and what it uses of the subscription; this keeps the numbers.
//
// - The clock follows the engine's events: a turn starts when its thread leaves
//   idle (a spoken turn: when the provisional turn starts, about when you stopped
//   talking), `routing` says its mode and brain, the deltas give the first words
//   and the first sentence (where the voice can start), and it ends idle or parked.
//   A queued turn starts at the next `routing`.
// - Only your own messages are kept (not Workbench events, not a provisional turn
//   you talked over), one row each in `duck.db` (`turn_timings`).
// - An API turn carries its cost (the turn meter's); every turn the subscription's
//   5-hour window before and after, so a conversation's use of it per hour shows.
// - `timingStats` sums them per mode and brain for the settings. The voice's own
//   part (the transcript before, the speech after) is the same on either brain.

import type { Brain } from "./routing";
import type { Backend } from "./brain/policy";
import { USER_SOURCES, type DuckEvent } from "./protocol";

export interface TurnTiming {
  /** When it started (epoch ms). */
  at: number;
  threadId: string;
  mode: string;
  backend: Backend;
  /** The model: the API's brain, or the subscription brain's. */
  model: string;
  /** Your message was spoken. */
  voice: boolean;
  firstTextMs: number | null;
  /** The first sentence done: where a spoken reply starts. */
  firstSentenceMs: number | null;
  totalMs: number;
  /** An API turn's cost; null on the subscription. */
  costUsd: number | null;
  /** The subscription's 5-hour window (percent) as the turn started and ended. */
  fiveHourBefore: number | null;
  fiveHourAfter: number | null;
}

export interface ClockDeps {
  now?: () => number;
  /** The subscription's 5-hour window, in percent; null when unknown. */
  fiveHour: () => Promise<number | null>;
  /** The meter's cost of the thread's turn so far (USD). */
  cost: (threadId: string) => number;
  /** The subscription brain's model for a thread in `mode`. */
  subscriptionModel: (mode: string) => string;
  keep: (t: TurnTiming) => void;
}

/** A sentence is done once its stop is followed by a space. */
const SENTENCE_END = /[.!?…]["'”»)\]]*\s/;

interface Open {
  at: number;
  mode: string | null;
  backend: Backend;
  brain: Brain;
  voice: boolean;
  yours: boolean;
  text: string;
  firstText: number | null;
  firstSentence: number | null;
  lastDelta: number | null;
  costFrom: number;
  before: Promise<number | null>;
}

export function createTurnClock(d: ClockDeps): { event(e: DuckEvent): void } {
  const now = d.now ?? Date.now;
  const open = new Map<string, Open>();
  const reading = () => d.fiveHour().catch(() => null);

  const start = (threadId: string) =>
    open.set(threadId, {
      at: now(),
      mode: null,
      backend: "api",
      brain: "sonnet",
      voice: false,
      yours: false,
      text: "",
      firstText: null,
      firstSentence: null,
      lastDelta: null,
      costFrom: d.cost(threadId),
      before: reading(),
    });

  const close = (threadId: string) => {
    const o = open.get(threadId);
    open.delete(threadId);
    if (!o || !o.yours || o.firstText === null || o.mode === null) return;
    const end = now();
    const mode = o.mode;
    const row: Omit<TurnTiming, "fiveHourBefore" | "fiveHourAfter"> = {
      at: o.at,
      threadId,
      mode,
      backend: o.backend,
      model: o.backend === "api" ? o.brain : d.subscriptionModel(mode),
      voice: o.voice,
      firstTextMs: o.firstText - o.at,
      firstSentenceMs: (o.firstSentence ?? o.lastDelta ?? o.firstText) - o.at,
      totalMs: end - o.at,
      costUsd: o.backend === "api" ? Math.max(0, d.cost(threadId) - o.costFrom) : null,
    };
    void Promise.all([o.before, reading()]).then(([before, after]) =>
      d.keep({ ...row, fiveHourBefore: before, fiveHourAfter: after }),
    );
  };

  return {
    event(e) {
      switch (e.type) {
        case "turnState":
          if (e.state === "idle" || e.state === "waiting") close(e.threadId);
          else if (!open.has(e.threadId)) start(e.threadId);
          return;
        case "routing": {
          // A queued turn starts without the thread going idle; a turn moved to
          // the subscription for want of credits routes again before any text.
          if (open.get(e.threadId)?.firstText != null) {
            close(e.threadId);
            start(e.threadId);
          }
          const o = open.get(e.threadId) ?? (start(e.threadId), open.get(e.threadId)!);
          o.mode = e.mode ?? "assistant";
          o.backend = e.backend ?? "api";
          o.brain = e.brain;
          return;
        }
        case "message": {
          const m = e.message;
          const o = open.get(m.threadId);
          if (o && !o.yours && m.role === "user" && USER_SOURCES.has(m.source)) {
            o.yours = true;
            o.voice = m.source === "voice" || m.source === "phone-voice";
          }
          return;
        }
        case "delta": {
          const o = open.get(e.threadId);
          if (!o) return;
          const t = now();
          o.firstText ??= t;
          o.lastDelta = t;
          o.text += e.text;
          if (o.firstSentence === null && SENTENCE_END.test(o.text)) o.firstSentence = t;
          return;
        }
      }
    },
  };
}

// ── the readout ─────────────────────────────────────────────────────────────

export interface TimingStat {
  mode: string;
  backend: Backend;
  model: string;
  turns: number;
  spoken: number;
  /** Medians, in ms. */
  firstSentenceMs: number;
  totalMs: number;
  /** Time in conversations of at least `LONG_MS` (hours), over which the rates go. */
  hours: number;
  usdPerHour: number | null;
  fiveHourPerHour: number | null;
}

/** Turns further apart than this are separate conversations. */
export const GAP_MS = 10 * 60_000;
/** A conversation this long counts toward the per-hour rates. */
export const LONG_MS = 5 * 60_000;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The turns per mode, brain and model: their medians, and the rates over long
 *  conversations (a thread's turns on one brain, at most `GAP_MS` apart). */
export function timingStats(rows: readonly TurnTiming[]): TimingStat[] {
  const groups = new Map<string, TurnTiming[]>();
  for (const r of rows) {
    const k = `${r.mode}\u0000${r.backend}\u0000${r.model}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: TimingStat[] = [];
  for (const g of groups.values()) {
    const byThread = new Map<string, TurnTiming[]>();
    for (const r of g) byThread.set(r.threadId, [...(byThread.get(r.threadId) ?? []), r]);
    let hours = 0;
    let usd = 0;
    let window = 0;
    let windowHours = 0;
    for (const ts of byThread.values()) {
      ts.sort((a, b) => a.at - b.at);
      const runs: TurnTiming[][] = [];
      for (const t of ts) {
        const run = runs[runs.length - 1];
        const prev = run?.[run.length - 1];
        if (prev && t.at - (prev.at + prev.totalMs) <= GAP_MS) run.push(t);
        else runs.push([t]);
      }
      for (const run of runs) {
        const first = run[0];
        const last = run[run.length - 1];
        const ms = last.at + last.totalMs - first.at;
        if (ms < LONG_MS) continue;
        const h = ms / 3_600_000;
        hours += h;
        usd += run.reduce((s, t) => s + (t.costUsd ?? 0), 0);
        const used = first.fiveHourBefore !== null && last.fiveHourAfter !== null ? last.fiveHourAfter - first.fiveHourBefore : null;
        // A drop is the window resetting: that conversation says nothing.
        if (used !== null && used >= 0) {
          window += used;
          windowHours += h;
        }
      }
    }
    const { mode, backend, model } = g[0];
    out.push({
      mode,
      backend,
      model,
      turns: g.length,
      spoken: g.filter((r) => r.voice).length,
      firstSentenceMs: median(g.map((r) => r.firstSentenceMs ?? r.totalMs)),
      totalMs: median(g.map((r) => r.totalMs)),
      hours,
      usdPerHour: backend === "api" && hours > 0 ? usd / hours : null,
      fiveHourPerHour: backend === "subscription" && windowHours > 0 ? window / windowHours : null,
    });
  }
  return out.sort((a, b) => a.mode.localeCompare(b.mode) || a.backend.localeCompare(b.backend) || a.model.localeCompare(b.model));
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One stat as a line for the settings. */
export function statLine(s: TimingStat): string {
  const on = s.backend === "api" ? `the API (${s.model})` : `your subscription (${s.model})`;
  const rate =
    s.usdPerHour !== null
      ? `; $${s.usdPerHour.toFixed(2)} an hour of conversation`
      : s.fiveHourPerHour !== null
        ? `; the 5-hour window +${s.fiveHourPerHour.toFixed(1)}% an hour of conversation`
        : "";
  return `${s.mode} on ${on}: first sentence in ${secs(s.firstSentenceMs)}, the whole reply ${secs(s.totalMs)} (medians of ${s.turns} turns, ${s.spoken} spoken)${rate}`;
}
