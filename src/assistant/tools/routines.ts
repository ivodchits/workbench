// Routines and the backup (step L4), as tools. All deferred: they load on demand.
//
// - `schedule_routine`, `list_routines`, `pause_routine`: reversible. A routine is
//   a message Duck gets on a schedule ("every weekday at 8:30, my morning
//   briefing") or a worker task from a brief; it can be paused, resumed and
//   deleted, and the built-in ones only paused.
// - `git_push`: Duck's own backup push, now. Consequential, and the floor's one
//   named exception (`duck-data-push`): only Duck's data repo, only its `origin`,
//   never forced; the arguments are fixed, there's no force to ask for. A rule
//   allows it (a starter rule on a new install).
// - `set_up_backup`: create a private GitHub repo with `gh` as the backup remote.
//   Outward-facing, so it always asks.
// - `merge_housekeeping`: merge the weekly tidy-up's branch the user OK'd.

import { z } from "zod";

import type { BackupStatus } from "../../ipc/routines";
import type { Housekeeping } from "../housekeeping";
import { Schedule, scheduleText, UserAction, type Routine, type Routines } from "../routines";
import { defineTool, type ToolContext } from "./registry";

export interface RoutinesHost {
  routines: Routines;
  housekeeping: Housekeeping;
  backup: {
    status(): Promise<BackupStatus>;
    /** The new remote's URL. */
    create(name: string): Promise<string>;
  };
}

function host(ctx: ToolContext): RoutinesHost {
  if (!ctx.routines) throw new Error("Routines aren't available here.");
  return ctx.routines;
}

const when = (ms: number | null) =>
  ms === null ? null : new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function routineView(r: Routine) {
  return {
    id: r.id,
    title: r.title,
    when: scheduleText(r.schedule),
    does:
      r.action.kind === "message"
        ? `tells you: ${r.action.text}`
        : r.action.kind === "task"
          ? `a ${r.action.tier} ${r.action.taskKind} task`
          : `Duck's ${r.action.job} job`,
    on: r.enabled,
    builtIn: r.builtIn,
    next: r.enabled ? when(r.nextRun) : null,
    last: r.lastRun === null ? null : `${when(r.lastRun)}: ${r.lastResult ?? ""}`,
  };
}

function findRoutine(routines: Routines, ref: string): Routine {
  const all = routines.list();
  const r =
    all.find((x) => x.id === ref) ??
    all.find((x) => x.title.toLowerCase() === ref.trim().toLowerCase()) ??
    (() => {
      const hits = all.filter((x) => x.title.toLowerCase().includes(ref.trim().toLowerCase()));
      if (hits.length > 1) throw new Error(`Several routines match "${ref}": ${hits.map((h) => `${h.title} (${h.id})`).join(", ")}.`);
      return hits[0];
    })();
  if (!r) throw new Error(`No routine "${ref}": list_routines shows them.`);
  return r;
}

export const scheduleRoutine = defineTool({
  name: "schedule_routine",
  description: [
    'Set up a routine: something Duck does on a schedule while Workbench runs ("every weekday at 8:30, my morning briefing", "every Sunday evening, research new Rust releases"). A routine missed while the app was closed runs once at the next start.',
    "The action is either a message you get in this thread when it's due (then you do what it says, as if the user asked: use it for anything your tools do), or a worker task from a brief (for heavy research or writing).",
    "schedule: every hour; every day at a time; a weekday (0 Sunday … 6 Saturday) at a time; or a date of the month (1–28). `idle`: wait until the user has been away an hour from that time on (for things that shouldn't interrupt). Times are 24-hour HH:MM, local.",
    "There's one routine per call; a weekday-only routine is five weekly ones. Say back when it first runs.",
  ].join(" "),
  schema: z.object({
    title: z.string().trim().min(1).max(120),
    schedule: Schedule,
    action: UserAction,
  }),
  tier: "reversible",
  describe: ({ title, schedule }) => `Schedule "${title}", ${scheduleText(schedule)}`,
  async run({ title, schedule, action }, ctx) {
    const r = await host(ctx).routines.add({ title, schedule, action, threadId: ctx.threadId });
    return { ...routineView(r), reportsTo: "this thread" };
  },
});

export const listRoutines = defineTool({
  name: "list_routines",
  description:
    "List Duck's routines: yours and the built-in ones (the hourly backup of Duck's data, the weekly housekeeping, the monthly docs clean-up), with when each runs next and how its last run went, plus where Duck's data is backed up.",
  schema: z.object({}),
  tier: "read",
  async run(_input, ctx) {
    const h = host(ctx);
    const b = await h.backup.status().catch(() => null);
    return {
      routines: h.routines.list().map(routineView),
      backup: !b
        ? "unknown"
        : !b.repo
          ? "Duck's data has no repo yet (nothing remembered yet)"
          : !b.remote
            ? "not backed up: no remote (set_up_backup)"
            : `${b.remote}${b.ahead === null ? ", never pushed" : b.ahead ? `, ${b.ahead} commits not pushed yet` : ", up to date"}`,
      ...(h.housekeeping.pendingMerge() && { waitingForOk: `housekeeping task ${h.housekeeping.pendingMerge()!.id} (merge_housekeeping)` }),
    };
  },
});

export const pauseRoutine = defineTool({
  name: "pause_routine",
  description: "Pause, resume or delete a routine, by its id or title from list_routines. A built-in routine can be paused, not deleted. A resumed routine runs from its next slot, not the ones it missed.",
  schema: z.object({
    routine: z.string().trim().min(1).max(200),
    action: z.enum(["pause", "resume", "delete"]).default("pause"),
  }),
  tier: "reversible",
  describe: ({ routine, action }) => `${action[0].toUpperCase()}${action.slice(1)} the routine "${routine}"`,
  async run({ routine, action }, ctx) {
    const { routines } = host(ctx);
    const r = findRoutine(routines, routine);
    if (action === "delete") {
      await routines.remove(r.id);
      return { deleted: r.title };
    }
    return routineView(await routines.setEnabled(r.id, action === "resume"));
  },
});

export const gitPush = defineTool({
  name: "git_push",
  description:
    "Back up Duck's own data (memory, config, task results) now: push its repo to its private backup remote. Only that repo and remote, never forced; Duck also does this by itself every hour and after each nightly tidy. For a backup that isn't set up yet, use set_up_backup.",
  schema: z.object({
    repo: z.literal("duck-data").default("duck-data"),
    remote: z.literal("origin").default("origin"),
  }),
  tier: "consequential",
  describe: () => "Push Duck's data repo to its private backup remote (never forced)",
  trust: () => ({
    projectId: null,
    specifier: "duck-data origin",
    texts: ["git push origin HEAD (duck-data)"],
    floorException: "duck-data-push",
  }),
  timeoutMs: 120_000,
  async run(_input, ctx) {
    const { routines } = host(ctx);
    const r = routines.list().find((x) => x.action.kind === "job" && x.action.job === "backup");
    if (!r) throw new Error("The backup routine is missing.");
    return { result: await routines.runNow(r.id) };
  },
});

export const setUpBackup = defineTool({
  name: "set_up_backup",
  description:
    "Set up the backup of Duck's data: create a private GitHub repo with the GitHub CLI (gh), make it the data repo's remote, and push. Only when the user agrees; the card asks them. The repo is private because memory is personal.",
  schema: z.object({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,100}$/, "a repo name is letters, digits, - _ and .")
      .default("duck-data"),
  }),
  tier: "consequential",
  describe: ({ name }) => `Create a private GitHub repo "${name}" with gh and back up Duck's data to it`,
  trust: () => ({ projectId: null, asks: "creating a GitHub repo is outward-facing: always yours to approve" }),
  timeoutMs: 180_000,
  async run({ name }, ctx) {
    const h = host(ctx);
    const url = await h.backup.create(name);
    const r = h.routines.list().find((x) => x.action.kind === "job" && x.action.job === "backup");
    const pushed = r ? await h.routines.runNow(r.id) : "the backup routine is missing";
    return { remote: url, push: pushed, next: "Duck's data is pushed every hour and after each nightly tidy." };
  },
});

export const mergeHousekeeping = defineTool({
  name: "merge_housekeeping",
  description:
    "Merge the weekly housekeeping's memory tidy-up branch into Duck's data repo, after the user has seen what it removes and said yes. Only for the branch Duck reported as waiting for their OK.",
  schema: z.object({ task: z.string().trim().min(1).max(64).describe("The housekeeping task's id.") }),
  tier: "consequential",
  describe: ({ task }) => `Merge housekeeping task ${task}'s memory tidy-up into Duck's data`,
  trust: () => ({ projectId: null }),
  async run({ task }, ctx) {
    return { result: await host(ctx).housekeeping.merge(task) };
  },
});

export const ROUTINE_TOOLS = [scheduleRoutine, listRoutines, pauseRoutine, gitPush, setUpBackup, mergeHousekeeping];
