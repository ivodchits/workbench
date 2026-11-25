// Quitting waits for the daily log (improvement plan J3). The backend asks the main
// window first (`daylog-quit`); this brings the log up to date and says when the
// quit may carry on.
//
// - **On the main:** a capture and a tidy of today, then the commit is waited for.
//   With nothing new, that's a look at each machine and no model call, so the quit
//   goes at once; the window shows only if it takes a moment.
// - **On another machine:** only when its sessions have work since the main last
//   read it. It asks the main to run, waits for that, then for the commit to reach
//   its mirror, so its own copy is current too.
// - **The main unreachable:** it says so and waits for "Quit anyway". Nothing is
//   lost: the offsets are where they were.
// - **The limit:** [`QUIT_LIMIT_MS`]; then it says it gave up, and quits.

import type { DayLog, RunReport, Step } from "./daylog";

export const QUIT_LIMIT_MS = 180_000;
/** The window shows only once a run has taken this long (nothing new is quicker). */
const SHOW_AFTER_MS = 600;
const MIRROR_POLL_MS = 2000;

export type QuitStatus =
  | { phase: "running"; step: string }
  | { phase: "unreachable"; why: string }
  | { phase: "failed"; error: string }
  | { phase: "gaveUp" };

export interface QuitDeps {
  /** The log, when Duck's main is this machine. */
  here(): DayLog | null;
  /** When the main last read this machine (epoch ms; null: never). */
  readAt(): Promise<number | null>;
  /** Whether this machine's sessions were written to after `since` (epoch ms). */
  workSince(since: number): Promise<boolean>;
  /** Whether the main can be asked now, and its name. */
  reachable(): { available: boolean; why: string | null; main: string | null };
  /** Ask the main for a capture and a tidy, and wait for it to end. */
  askMain(onStep: (s: Step) => void): Promise<RunReport>;
  /** Sync the mirror now; its head. */
  syncMirror(): Promise<string | null>;
  /** Wait for the log's commits (on the main). */
  flush(): Promise<unknown>;
  ack(): void;
  finish(): void;
  show(s: QuitStatus | null): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Today's start, epoch ms (the log's day). */
  todayStart(): number;
}

export function stepLine(s: Step, machineName?: string | null): string {
  switch (s.step) {
    case "reading":
      return `Reading ${s.machine === machineName ? "this machine" : s.machine}'s sessions`;
    case "writing":
      return "Writing up";
    case "tidying":
      return "Tidying the day";
    case "saving":
      return "Saving";
    case "done":
      return "Done";
  }
}

/** The run going now; a cancel ("keep Workbench open") makes it another's. */
let runs = 0;

/** Keep Workbench open: the run going on says and quits nothing more. */
export function cancelQuit(): void {
  runs++;
  setQuitStatus(null);
}

/** Bring the log up to date for a quit, then let the quit go on. */
export async function quitRun(input: QuitDeps): Promise<void> {
  const me = ++runs;
  const live = () => me === runs;
  const deps: QuitDeps = {
    ...input,
    show: (s) => live() && input.show(s),
    finish: () => live() && input.finish(),
  };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  deps.ack();
  const until = now() + QUIT_LIMIT_MS;
  let shown = false;
  let pending: string | null = null;
  const show = (step: string) => {
    pending = step;
    if (shown) deps.show({ phase: "running", step });
  };
  const timer = setTimeout(() => {
    shown = true;
    deps.show({ phase: "running", step: pending ?? "Looking for new work" });
  }, SHOW_AFTER_MS);

  const work = async (): Promise<"done" | "waiting"> => {
    const log = deps.here();
    if (log) {
      await log.quitRun((s) => show(stepLine(s)));
      show("Saving");
      await deps.flush();
      return "done";
    }
    const readAt = await deps.readAt().catch(() => null);
    if (!(await deps.workSince(readAt ?? deps.todayStart()).catch(() => false))) return "done";
    const r = deps.reachable();
    if (!r.available) {
      clearTimeout(timer);
      deps.show({ phase: "unreachable", why: r.why ?? "Duck's main machine isn't connected now." });
      return "waiting";
    }
    shown = true;
    clearTimeout(timer);
    show(`Asking ${r.main ?? "Duck's main"} to log this machine's work`);
    const before = await deps.syncMirror().catch(() => null);
    const report = await deps.askMain((s) => show(stepLine(s)));
    if (report.away.length) throw new Error(`${r.main ?? "Duck's main"} couldn't read ${report.away.join(", ")}.`);
    show("Waiting for the log to arrive here");
    while (now() < until) {
      const head = await deps.syncMirror().catch(() => null);
      if (head && head !== before) break;
      await sleep(MIRROR_POLL_MS);
    }
    return "done";
  };

  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"limit">((r) => (limitTimer = setTimeout(() => r("limit"), Math.max(0, until - now()))));
  try {
    const how = await Promise.race([work(), limit]);
    clearTimeout(timer);
    clearTimeout(limitTimer);
    if (how === "waiting") return;
    if (how === "limit") {
      deps.show({ phase: "gaveUp" });
      await sleep(1500);
    }
    deps.show(null);
    deps.finish();
  } catch (e) {
    clearTimeout(timer);
    clearTimeout(limitTimer);
    deps.show({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}

// ── the overlay's store ──

let current: QuitStatus | null = null;
const subs = new Set<(s: QuitStatus | null) => void>();

export function setQuitStatus(s: QuitStatus | null): void {
  current = s;
  for (const cb of subs) cb(s);
}

export function onQuitStatus(cb: (s: QuitStatus | null) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => void subs.delete(cb);
}
