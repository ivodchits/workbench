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
//   pulse), late when they came due while the app was closed. A reminder with a
//   time comes up the other ways only once it's due.
//
// Delivery bookkeeping (announced, for which due) is in `duck.db`, not the file.

import type { ReminderRecord, RemindersFile } from "../ipc/reminders";

export type { ReminderRecord };

/** A day without a time (`2026-10-24`) is due at this hour. */
export const DAY_HOUR = 9;

/** The longest one timer waits: a later reminder is armed again after this. */
const MAX_WAIT_MS = 3_600_000;

export interface RemindersBackend {
  read(): Promise<RemindersFile>;
  put(id: string, before: ReminderRecord | null, after: ReminderRecord | null, message: string): Promise<RemindersFile>;
  seen(): Promise<[string, string][]>;
  setSeen(id: string, value: string | null): Promise<void>;
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

/** Open, and due if it has a time: what comes up. */
export function isActive(r: ReminderRecord, now: number): boolean {
  return r.state === "open" && (!r.due || dueAt(r.due) <= now);
}

export function view(r: ReminderRecord, now: number): ReminderView {
  return {
    id: r.id,
    title: r.title,
    due: r.due ? dueText(r.due, true) : null,
    at: r.due ? dueAt(r.due) : null,
    overdue: !!r.due && dueAt(r.due) <= now,
    project: r.project ?? null,
  };
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
export function generalNote(list: readonly ReminderRecord[]): string {
  const items = list.map((r) => (r.due ? `${r.title} (was due ${dueText(r.due)})` : r.title));
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
}

export function createReminders(deps: {
  backend: RemindersBackend;
  /** A quiet spell, in minutes. */
  spellMinutes: () => number;
  now?: () => number;
}): RemindersHost {
  const now = deps.now ?? Date.now;
  let file: RemindersFile | null = null;
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
      return general.length ? generalNote(general) : null;
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
 *  time was changed is announced again at its new time. */
export function createReminderClock(deps: {
  reminders: RemindersHost;
  backend: Pick<RemindersBackend, "seen" | "setSeen">;
  announce(r: ReminderRecord, late: boolean): void;
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
          if (r.state !== "open" || !r.due || announced.get(r.id) === r.due) continue;
          const when = dueAt(r.due);
          if (Number.isNaN(when)) continue;
          if (when > at) {
            next = Math.min(next, when);
            continue;
          }
          announced.set(r.id, r.due);
          void deps.backend
            .setSeen(r.id, JSON.stringify({ announced: r.due, at }))
            .catch((e: unknown) => console.warn("duck: a reminder's bookkeeping wasn't saved", e));
          deps.announce(r, when < deps.startedAt);
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
