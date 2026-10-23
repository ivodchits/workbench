// Duck's reminders (step H8), the engine's side. The records are `reminders.json`
// in Duck's repo (`assistant/reminders.rs`, a commit per change); this module keeps
// the latest read, and decides when a reminder comes up:
//
// - **A project's** open reminders, each time a new session starts in it: in the
//   result of Duck's own start (`create_session`, `run_task`), or as one notice line
//   in Duck's thread when you start one (from the rail or the phone).
// - **General** ones (no project), on your first message in a new thread or after a
//   quiet spell (`reminderSpellMinutes`): a turn-scoped system note, so Duck
//   mentions them in a line and the cached prefix is untouched.
// - **Timed** ones, when due: announced once (V5's queue, a notice, the widget's
//   pulse, a push to the phone), late when they came due while the app was closed.
//   A reminder with a time comes up the other ways only once it's due.
//
// Step H4 adds repeats, snooze and timers:
// - **A repeating reminder** keeps one record; its `due` is the occurrence not yet
//   done. Done moves `due` to the next occurrence after now; dismissed ends it. One
//   left undone is announced again at each later occurrence, without a write.
// - **Snoozed**, it comes up at `snoozedUntil` instead (and is announced then); a
//   new due, or done, clears it.
// - **Timers** are `duck.db` rows, not the file: they matter for minutes. Each rings
//   once and is dropped; one that ran out while the app was closed rings late.
//
// Delivery bookkeeping (announced, for which time) is in `duck.db`, not the file.

import type { Repeat, ReminderRecord, RemindersFile } from "../ipc/reminders";

export type { Repeat, ReminderRecord };

/** A day without a time (`2026-10-24`) is due at this hour. */
export const DAY_HOUR = 9;

/** The longest one timer waits: a later reminder is armed again after this. */
const MAX_WAIT_MS = 3_600_000;

/** What the push's Snooze, and a snooze with no time given, put off by. */
export const SNOOZE_MINUTES = 10;

export interface RemindersBackend {
  read(): Promise<RemindersFile>;
  put(id: string, before: ReminderRecord | null, after: ReminderRecord | null, message: string): Promise<RemindersFile>;
  seen(): Promise<[string, string][]>;
  setSeen(id: string, value: string | null): Promise<void>;
  timers(): Promise<[string, string][]>;
  setTimer(id: string, value: string | null): Promise<void>;
}

/** A running timer (step H4). */
export interface TimerRecord {
  id: string;
  label?: string;
  /** When it rings, epoch ms. */
  ends: number;
  /** How long it was set for, as said back ("10 min"). */
  length: string;
  /** The thread it was asked for in. */
  threadId?: string;
}

/** What a surface shows of one open reminder. */
export interface ReminderView {
  id: string;
  title: string;
  /** "Fri 24 Oct, 10:00"; null without a due time. */
  due: string | null;
  /** When it's due, epoch ms; null without a due time. */
  at: number | null;
  /** Due now or past. */
  overdue: boolean;
  project: { id: string; name: string } | null;
}

/** `d` as a local stamp, `2026-10-23T14:05`. */
export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** When `due` is, epoch ms; NaN when it isn't a real local time. */
export function dueAt(due: string): number {
  const m = DUE.exec(due);
  if (!m) return NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? String(DAY_HOUR), m[5] ?? "0"].map(Number);
  const at = new Date(y, mo - 1, d, h, mi);
  // 2026-02-30 rolls into March: not a day.
  return at.getMonth() === mo - 1 && at.getDate() === d ? at.getTime() : NaN;
}

/** `due` as it's read back: "Friday 24 Oct, 10:00", "Friday 24 Oct" (`short`:
 *  "Fri 24 Oct, 10:00"). */
export function dueText(due: string, short = false): string {
  const at = new Date(dueAt(due));
  const day = at.toLocaleDateString("en-GB", { weekday: short ? "short" : "long", day: "numeric", month: "short" });
  return due.includes("T") ? `${day}, ${due.slice(11)}` : day;
}

// ── repeats ──

/** `stamp` (a day or a local time) moved on by one `repeat`; `anchor` is the day
 *  of the month a monthly one keeps (31 Jan → 28 Feb → 31 Mar). */
function stepOnce(stamp: string, repeat: Repeat, anchor: number): string {
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  let next: Date;
  if (repeat === "monthly") next = new Date(y, m, Math.min(anchor, new Date(y, m + 1, 0).getDate()));
  else {
    next = new Date(y, m - 1, d + (repeat === "weekly" ? 7 : 1));
    while (repeat === "weekdays" && (next.getDay() === 0 || next.getDay() === 6))
      next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1);
  }
  return localStamp(next).slice(0, 10) + stamp.slice(10);
}

/** Occurrences of `due` repeating, from `due` on, while `keep` holds; at most a
 *  few years' worth. */
function walk(due: string, repeat: Repeat, keep: (stamp: string) => boolean): string {
  const anchor = Number(due.slice(8, 10));
  let at = due;
  for (let i = 0; i < 5000; i++) {
    const next = stepOnce(at, repeat, anchor);
    if (!keep(next)) return next;
    at = next;
  }
  return at;
}

/** The first occurrence of a repeating `due` after `now`. */
export function nextOccurrence(due: string, repeat: Repeat, now: number): string {
  return dueAt(due) > now ? due : walk(due, repeat, (s) => dueAt(s) <= now);
}

/** The latest occurrence of a repeating `due` that's come (`due` itself when none
 *  has). */
function latestOccurrence(due: string, repeat: Repeat, now: number): string {
  if (dueAt(due) > now) return due;
  let last = due;
  walk(due, repeat, (s) => {
    if (dueAt(s) > now) return false;
    last = s;
    return true;
  });
  return last;
}

/** When `r` comes up now: its snooze, else its due (the latest occurrence come,
 *  for a repeating one); undefined without a time. */
export function comesUpAt(r: ReminderRecord, now: number): string | undefined {
  const latest = r.due && r.repeat ? latestOccurrence(r.due, r.repeat, now) : r.due;
  // A repeat's later occurrence, come since the snooze ended, wins over it.
  if (r.snoozedUntil && !(latest && dueAt(latest) <= now && dueAt(latest) > dueAt(r.snoozedUntil))) return r.snoozedUntil;
  return latest;
}

/** How a repeat is said: "every weekday". */
export function repeatText(repeat: Repeat): string {
  return repeat === "weekdays" ? "every weekday" : repeat === "daily" ? "every day" : repeat === "weekly" ? "every week" : "every month";
}

/** `r` done at `now`: closed, or, repeating, moved on to its next occurrence. */
export function completed(r: ReminderRecord, now: Date): ReminderRecord {
  const after: ReminderRecord =
    r.repeat && r.due ? { ...r, due: nextOccurrence(r.due, r.repeat, now.getTime()) } : { ...r, state: "done", closed: localStamp(now) };
  delete after.snoozedUntil;
  return after;
}

/** `r` put off until `until` (a local time). */
export function snoozed(r: ReminderRecord, until: string): ReminderRecord {
  return { ...r, snoozedUntil: until };
}

/** Open, and due if it has a time: what comes up. */
export function isActive(r: ReminderRecord, now: number): boolean {
  const at = comesUpAt(r, now);
  return r.state === "open" && (!at || dueAt(at) <= now);
}

export function view(r: ReminderRecord, now: number): ReminderView {
  const at = comesUpAt(r, now);
  return {
    id: r.id,
    title: r.title,
    due: at ? dueText(at, true) : null,
    at: at ? dueAt(at) : null,
    overdue: !!at && dueAt(at) <= now,
    project: r.project ?? null,
  };
}

// ── durations ──

const UNIT: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };

/** "10m", "10 min", "1h30m", "90s", "1.5 hours", or a bare number of minutes, in
 *  ms; NaN when it's none of those. */
export function parseDuration(text: string): number {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(hours?|hrs?)/g, "h")
    .replace(/(minutes?|mins?)/g, "m")
    .replace(/(seconds?|secs?)/g, "s");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60_000;
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== t) return NaN;
  return Math.round(parts.reduce((ms, p) => ms + Number(p[1]) * UNIT[p[2]], 0));
}

/** A length said back: "1 h 30 min", "45 s". */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return [h && `${h} h`, m && `${m} min`, sec && `${sec} s`].filter(Boolean).join(" ") || "0 s";
}

/** The widget's order: those with a time (soonest first), then the shown
 *  project's, then general, then other projects'. */
export function widgetOrder(list: readonly ReminderView[], projectId: string | null): ReminderView[] {
  const rank = (v: ReminderView) => (v.at !== null ? 0 : projectId && v.project?.id === projectId ? 1 : v.project ? 3 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.at ?? 0) - (b.at ?? 0));
}

/** A new id: short, and unique enough for one person's reminders. */
export function newId(now = Date.now()): string {
  return `r-${now.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The reminder `ref` names among `list`: its id, its title, or the one whose
 *  title and details hold every word of it. Throws when none or several do. */
export function findReminder(list: readonly ReminderRecord[], ref: string): ReminderRecord {
  const byId = list.find((r) => r.id === ref.trim());
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  const exact = list.filter((r) => r.title.trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const ws = tokens(ref);
  const hits = ws.length ? list.filter((r) => { const hay = tokens(`${r.title} ${r.details ?? ""}`).join(" "); return ws.every((w) => hay.includes(w)); }) : [];
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No reminder matches "${ref}": list_reminders shows them with their ids.`);
  throw new Error(`Several reminders match "${ref}": ${hits.map((r) => `${r.id} "${r.title}"`).join(", ")}. Name one by its id.`);
}

/** The notice line when you start a session in a project with reminders. */
export function projectLine(project: string, list: readonly ReminderRecord[]): string {
  const n = list.length;
  return `${project} · ${n} reminder${n === 1 ? "" : "s"}: ${list.map((r) => r.title).join("; ")}`;
}

/** The turn-scoped note with the general reminders. */
export function generalNote(list: readonly ReminderRecord[], now = Date.now()): string {
  const items = list.map((r) => {
    const at = comesUpAt(r, now);
    return at ? `${r.title} (was due ${dueText(at)})` : r.title;
  });
  return [
    `<reminders>Open reminders the user asked for: ${items.join("; ")}.`,
    "Mention them in one short line, before or after your answer, titles only; never instead of answering. If they say one is done, complete_reminder it.</reminders>",
  ].join(" ");
}

export interface RemindersHost {
  /** Every record as last read (all states). */
  list(): readonly ReminderRecord[];
  /** What's wrong with the file, when it doesn't parse. */
  problem(): string | null;
  /** The file's path. */
  path(): string | null;
  /** Read the file again (a hand edit). */
  load(): Promise<void>;
  /** Write one record over what it was (`before`); throws `stale:` otherwise. */
  put(id: string, before: ReminderRecord | null, after: ReminderRecord | null, message: string): Promise<void>;
  /** Hear every change (a write, a reread), and each `pulse` (true). */
  subscribe(cb: (pulse: boolean) => void): () => void;
  /** One just came up (due, or a project's on a new session): the widget pulses. */
  pulse(): void;
  /** A project's open reminders that come up now. */
  forProject(projectId: string, now?: number): ReminderRecord[];
  /** A user's message is starting a turn: the general reminders' note, when this
   *  is a new thread or the first message after a quiet spell; else null. */
  opening(first: boolean, now?: number): string | null;
  /** The running timers (step H4), soonest first. */
  timers(): readonly TimerRecord[];
  /** Read the timers again. */
  loadTimers(): Promise<void>;
  addTimer(t: TimerRecord): Promise<void>;
  /** Drop a timer (rung, or cancelled). */
  dropTimer(id: string): Promise<void>;
}

export function createReminders(deps: {
  backend: RemindersBackend;
  /** A quiet spell, in minutes. */
  spellMinutes: () => number;
  now?: () => number;
}): RemindersHost {
  const now = deps.now ?? Date.now;
  let file: RemindersFile | null = null;
  let timers: TimerRecord[] = [];
  let lastUser = -Infinity;
  const listeners = new Set<(pulse: boolean) => void>();
  const tell = (pulse: boolean) => {
    for (const l of listeners) l(pulse);
  };
  const changed = (f: RemindersFile) => {
    file = f;
    tell(false);
  };
  return {
    list: () => file?.reminders ?? [],
    problem: () => file?.problem ?? null,
    path: () => file?.path ?? null,
    async load() {
      changed(await deps.backend.read());
    },
    async put(id, before, after, message) {
      changed(await deps.backend.put(id, before, after, message));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    pulse: () => tell(true),
    forProject(projectId, at = now()) {
      return (file?.reminders ?? []).filter((r) => r.project?.id === projectId && isActive(r, at));
    },
    opening(first, at = now()) {
      const spell = first || at - lastUser >= deps.spellMinutes() * 60_000;
      lastUser = at;
      if (!spell) return null;
      const general = (file?.reminders ?? []).filter((r) => !r.project && isActive(r, at));
      return general.length ? generalNote(general, at) : null;
    },
    timers: () => timers,
    async loadTimers() {
      const rows = await deps.backend.timers();
      const list: TimerRecord[] = [];
      for (const [id, json] of rows) {
        try {
          const t = JSON.parse(json) as TimerRecord;
          if (typeof t.ends === "number") list.push({ ...t, id });
        } catch {
          // A row that doesn't parse is no timer.
        }
      }
      timers = list.sort((a, b) => a.ends - b.ends);
      tell(false);
    },
    async addTimer(t) {
      const { id, ...rest } = t;
      await deps.backend.setTimer(id, JSON.stringify(rest));
      timers = [...timers, t].sort((a, b) => a.ends - b.ends);
      tell(false);
    },
    async dropTimer(id) {
      await deps.backend.setTimer(id, null);
      timers = timers.filter((t) => t.id !== id);
      tell(false);
    },
  };
}

// ── timed reminders ──

export interface ReminderClock {
  /** Look again: announce what's due, arm a timer for the next. */
  arm(): void;
  stop(): void;
}

/** Announces each open reminder with a time once, when it's due; one that came
 *  due before `startedAt` (the app was closed) is announced late. A reminder whose
 *  time was changed (moved, snoozed, the next occurrence of a repeat) is announced
 *  again at its new time. Timers ring once, when they run out, and are dropped. */
export function createReminderClock(deps: {
  reminders: RemindersHost;
  backend: Pick<RemindersBackend, "seen" | "setSeen">;
  /** `at` is the time it came up for (its due, snooze or occurrence). */
  announce(r: ReminderRecord, late: boolean, at: string): void;
  ring?(t: TimerRecord, late: boolean): void;
  startedAt: number;
  now?: () => number;
}): Promise<ReminderClock> {
  const now = deps.now ?? Date.now;
  const announced = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return deps.backend.seen().then((rows) => {
    for (const [id, json] of rows) {
      try {
        const v = (JSON.parse(json) as { announced?: unknown }).announced;
        if (typeof v === "string") announced.set(id, v);
      } catch {
        // A row that doesn't parse: as if never announced.
      }
    }
    const clock: ReminderClock = {
      arm() {
        if (timer) clearTimeout(timer);
        timer = null;
        const at = now();
        let next = Infinity;
        for (const r of deps.reminders.list()) {
          if (r.state !== "open") continue;
          const up = comesUpAt(r, at);
          if (!up) continue;
          // A repeat's next occurrence is armed while this one waits to be done.
          if (r.repeat && r.due) next = Math.min(next, dueAt(nextOccurrence(r.due, r.repeat, at)));
          if (announced.get(r.id) === up) continue;
          const when = dueAt(up);
          if (Number.isNaN(when)) continue;
          if (when > at) {
            next = Math.min(next, when);
            continue;
          }
          announced.set(r.id, up);
          void deps.backend
            .setSeen(r.id, JSON.stringify({ announced: up, at }))
            .catch((e: unknown) => console.warn("duck: a reminder's bookkeeping wasn't saved", e));
          deps.announce(r, when < deps.startedAt, up);
        }
        for (const t of deps.reminders.timers()) {
          if (t.ends > at) {
            next = Math.min(next, t.ends);
            continue;
          }
          // Dropped first, so a second look can't ring it again.
          void deps.reminders.dropTimer(t.id).catch((e: unknown) => console.warn("duck: a timer wasn't dropped", e));
          deps.ring?.(t, t.ends < deps.startedAt);
        }
        if (next < Infinity) timer = setTimeout(() => clock.arm(), Math.min(next - at, MAX_WAIT_MS));
      },
      stop() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
    return clock;
  });
}
