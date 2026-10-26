// Routines (step L4): Duck runs things on a schedule, while Workbench runs.
//
// - A routine is `{title, schedule, action}`. Its record (with its next and last
//   run) is in duck.db (`routines.rs`), so one missed while the app was closed is
//   known at the next start: it runs once then, never once per missed slot.
// - Schedules are local time: every hour, every day, a weekday, or a date of the
//   month, at a time (midnight when none). `idle`: "after the first idle hour" from
//   that time on, as the nightly memory tidy waits. A slot whose day has passed
//   (the app was closed, or you never left for an hour) runs at once.
// - Actions: a message Duck gets in the routine's thread (a Workbench event: "the
//   morning briefing"), a worker task from a brief, or one of Duck's own jobs
//   (`job`: the backup push, housekeeping, the docs clean-up), which are the
//   built-in routines and can be paused but not deleted, or a skill (S2): Duck is
//   told to run it, and loads it as for a request.
// - `tick` (every minute) runs what's due, one run per routine at a time; a run that
//   throws records the error and waits for its next slot.

import { z } from "zod";

import { TASK_KINDS } from "./tasks";

const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "a time is HH:MM, 24-hour");

export const Schedule = z.discriminatedUnion("every", [
  z.object({ every: z.literal("hour") }),
  z.object({ every: z.literal("day"), at: HHMM.optional(), idle: z.boolean().optional() }),
  z.object({
    every: z.literal("week"),
    /** 0 Sunday … 6 Saturday. */
    day: z.number().int().min(0).max(6),
    at: HHMM.optional(),
    idle: z.boolean().optional(),
  }),
  z.object({
    every: z.literal("month"),
    date: z.number().int().min(1).max(28),
    at: HHMM.optional(),
    idle: z.boolean().optional(),
  }),
]);
export type Schedule = z.infer<typeof Schedule>;

export const JOBS = ["backup", "housekeeping", "docs"] as const;
export type Job = (typeof JOBS)[number];

const MessageAction = z.object({ kind: z.literal("message"), text: z.string().trim().min(1).max(2000) });
const TaskAction = z.object({
  kind: z.literal("task"),
  brief: z.string().trim().min(1).max(8000),
  taskKind: z.enum(TASK_KINDS).exclude(["code", "drawing"]),
  tier: z.enum(["standard", "involved", "serious"]),
});

const SkillAction = z.object({ kind: z.literal("skill"), skill: z.string().trim().min(1).max(64) });

/** What a routine you make does (Duck's own jobs are built in). */
export const UserAction = z.discriminatedUnion("kind", [MessageAction, TaskAction, SkillAction]);

export const Action = z.discriminatedUnion("kind", [
  MessageAction,
  TaskAction,
  SkillAction,
  z.object({ kind: z.literal("job"), job: z.enum(JOBS) }),
]);
export type Action = z.infer<typeof Action>;

export const Routine = z.object({
  id: z.string(),
  title: z.string(),
  schedule: Schedule,
  action: Action,
  /** The thread it reports to (made when first needed for a built-in one). */
  threadId: z.string().nullable(),
  enabled: z.boolean(),
  builtIn: z.boolean().default(false),
  created: z.number(),
  lastRun: z.number().nullable(),
  /** What the last run came to, in a line; an error starts "failed:". */
  lastResult: z.string().nullable(),
  nextRun: z.number(),
  /** A job's own memo (the backup's failing-since, …). */
  memo: z.record(z.string(), z.unknown()).default({}),
});
export type Routine = z.infer<typeof Routine>;

/** An idle routine waits for you to be away this long. */
export const ROUTINE_IDLE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function atOf(s: Schedule): [number, number] {
  const at = "at" in s && s.at ? s.at : "00:00";
  return [Number(at.slice(0, 2)), Number(at.slice(3, 5))];
}

/** The first slot strictly after `after` (epoch ms), local time. */
export function nextSlot(s: Schedule, after: number): number {
  if (s.every === "hour") return after + 60 * 60_000;
  const [h, m] = atOf(s);
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  if (s.every === "month") {
    d.setDate(s.date);
    while (d.getTime() <= after) d.setMonth(d.getMonth() + 1, s.date);
    return d.getTime();
  }
  while (d.getTime() <= after || (s.every === "week" && d.getDay() !== s.day)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Whether a routine runs now. An idle one waits for the first idle hour, unless
 *  its slot's day has gone by. */
export function isDue(r: Routine, now: number, idleMs: number): boolean {
  if (!r.enabled || now < r.nextRun) return false;
  const idle = "idle" in r.schedule && r.schedule.idle === true;
  return !idle || idleMs >= ROUTINE_IDLE_MS || now >= r.nextRun + DAY_MS;
}

/** The schedule in words: "Sundays after midnight, after the first idle hour". */
export function scheduleText(s: Schedule): string {
  if (s.every === "hour") return "every hour";
  const at = "at" in s && s.at ? `at ${s.at}` : "after midnight";
  const idle = s.idle ? ", once you've been away an hour" : "";
  if (s.every === "day") return `every day ${at}${idle}`;
  if (s.every === "week") return `${DAYS[s.day]}s ${at}${idle}`;
  const th = [1, 21].includes(s.date) ? "st" : [2, 22].includes(s.date) ? "nd" : [3, 23].includes(s.date) ? "rd" : "th";
  return `on the ${s.date}${th} of each month ${at}${idle}`;
}

export interface RoutineBackend {
  put(r: Routine): Promise<void>;
  list(): Promise<Routine[]>;
  remove(id: string): Promise<void>;
}

export interface NewRoutine {
  title: string;
  schedule: Schedule;
  action: Action;
  threadId: string | null;
}

export interface RoutinesDeps {
  backend: RoutineBackend;
  /** Run one; resolves to its result line. A job's memo changes are kept. */
  run(r: Routine): Promise<string>;
  /** How long you've been away; a failure counts as here. */
  idleMs(): Promise<number>;
  now?: () => number;
  newId?: () => string;
}

export interface Routines {
  /** Read the stored routines and add the built-in ones that are missing. */
  load(): Promise<void>;
  /** Run what's due. Resolves when those runs end. */
  tick(): Promise<void>;
  /** Run one now, whatever its schedule (the backup after a tidy); its next slot
   *  stays. */
  runNow(id: string): Promise<string>;
  add(r: NewRoutine): Promise<Routine>;
  setEnabled(id: string, on: boolean): Promise<Routine>;
  /** Built-in routines can only be paused. */
  remove(id: string): Promise<void>;
  /** Merge into a routine's memo (a job's state). */
  memo(id: string, patch: Record<string, unknown>): Promise<void>;
  setThread(id: string, threadId: string): Promise<void>;
  get(id: string): Routine | undefined;
  list(): Routine[];
  /** A run of it is going now. */
  running(id: string): boolean;
  subscribe(cb: () => void): () => void;
}

/** The built-in routines (step L4), by id. */
export const BUILT_IN: readonly (NewRoutine & { id: string })[] = [
  {
    id: "builtin-backup",
    title: "Back up Duck's data",
    // At most hourly; the tidy's run pushes too (`runNow`).
    schedule: { every: "hour" },
    action: { kind: "job", job: "backup" },
    threadId: null,
  },
  {
    id: "builtin-housekeeping",
    title: "Weekly housekeeping",
    schedule: { every: "week", day: 0, idle: true },
    action: { kind: "job", job: "housekeeping" },
    threadId: null,
  },
  {
    id: "builtin-docs",
    title: "Monthly docs clean-up",
    schedule: { every: "month", date: 1, idle: true },
    action: { kind: "job", job: "docs" },
    threadId: null,
  },
];

export function createRoutines(deps: RoutinesDeps): Routines {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID().slice(0, 8));
  const routines = new Map<string, Routine>();
  const running = new Map<string, Promise<string>>();
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const l of listeners) l();
  };
  async function save(r: Routine): Promise<Routine> {
    routines.set(r.id, r);
    changed();
    await deps.backend.put(r).catch((e: unknown) => console.warn("duck: a routine wasn't stored", e));
    return r;
  }
  function need(id: string): Routine {
    const r = routines.get(id);
    if (!r) throw new Error(`No routine ${id}: list_routines shows them.`);
    return r;
  }
  function make(n: NewRoutine, id: string, builtIn: boolean): Routine {
    const t = now();
    return {
      id,
      title: n.title.trim(),
      schedule: n.schedule,
      action: n.action,
      threadId: n.threadId,
      enabled: true,
      builtIn,
      created: t,
      lastRun: null,
      lastResult: null,
      nextRun: nextSlot(n.schedule, t),
      memo: {},
    };
  }

  /** One run; the record is updated whatever it comes to. */
  function runOne(id: string, scheduled: boolean): Promise<string> {
    const going = running.get(id);
    if (going) return going;
    const p = (async () => {
      const r = need(id);
      let result: string;
      try {
        result = await deps.run(r);
      } catch (e) {
        result = `failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      // The run may have changed the memo or thread: build on the latest record.
      const cur = routines.get(id);
      if (!cur) return result;
      const t = now();
      await save({ ...cur, lastRun: t, lastResult: result, ...(scheduled && { nextRun: nextSlot(cur.schedule, t) }) });
      return result;
    })().finally(() => {
      running.delete(id);
      changed();
    });
    running.set(id, p);
    changed();
    return p;
  }

  return {
    async load() {
      for (const r of await deps.backend.list()) routines.set(r.id, r);
      for (const b of BUILT_IN) if (!routines.has(b.id)) await save(make(b, b.id, true));
      changed();
    },
    async tick() {
      const due = [...routines.values()].filter((r) => r.enabled && now() >= r.nextRun && !running.has(r.id));
      if (!due.length) return;
      const idle = await deps.idleMs().catch(() => 0);
      await Promise.all(due.filter((r) => isDue(r, now(), idle)).map((r) => runOne(r.id, true)));
    },
    runNow: (id) => runOne(id, false),
    async add(n) {
      const r = Routine.parse(make(n, newId(), false));
      return save(r);
    },
    async setEnabled(id, on) {
      const r = need(id);
      // Back on: from its next slot, not the ones it was paused through.
      return save({ ...r, enabled: on, ...(on && !r.enabled && { nextRun: nextSlot(r.schedule, now()) }) });
    },
    async remove(id) {
      const r = need(id);
      if (r.builtIn) throw new Error(`"${r.title}" is built in: it can be paused, not deleted.`);
      routines.delete(id);
      changed();
      await deps.backend.remove(id);
    },
    async memo(id, patch) {
      const r = need(id);
      await save({ ...r, memo: { ...r.memo, ...patch } });
    },
    async setThread(id, threadId) {
      await save({ ...need(id), threadId });
    },
    get: (id) => routines.get(id),
    list: () => [...routines.values()],
    running: (id) => running.has(id),
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
