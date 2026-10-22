// What Duck's routines do (step L4): the message and task actions, and Duck's own
// jobs behind the built-in routines.
//
// - **Backup** (hourly, and after each nightly tidy): push Duck's data repo to its
//   private `origin` (`gitlane.rs`, behind the memory commits on the git queue).
//   Offline or a bad sign-in is retried hourly: told once as info, and as needs-you
//   after a day. A push the remote rejected (it moved) or a lock left behind needs
//   judgment: a quiet worker task (standard tier) repairs it on a branch, Duck
//   merges that and pushes again, and you hear of it only if the worker is
//   blocked. Without a remote, Duck mentions once a week that it isn't backed up.
// - **Housekeeping** (weekly, Sunday after the first idle hour, or at the next start
//   when Sunday went by):
//   - Duck's part, no model: the threads idle past "Delete threads idle for" are
//     deleted (`idleThreads` says which may go), old task folders are folded into
//     `tasks/INDEX.md`, leftovers committed, `git gc --auto`.
//   - The worker's part: a quiet code task (standard tier) in a worktree of the data
//     repo tidies `memory/` on its branch. Duck merges it when it only tidied: every
//     file in `memory/` or `skills/`, all committed, and every entry it drops listed
//     in its `result.json` with a reason and a source. Otherwise the thread gets
//     the branch for your OK (`merge_housekeeping`).
// - **Docs** (monthly): a change to Duck (`improve_duck`'s code task, `self`) that
//   brings the architecture doc and the plan's As-built notes in line with the
//   code; reviewed and merged by you, as any change to Duck.

import type { BackupStatus, BranchReview, HousekeepReport, PushOutcome } from "../ipc/routines";
import type { ThreadRow } from "../ipc/assistant";
import type { Level } from "./announce";
import type { WorkbenchPort } from "./port";
import { scheduleText, type Routine, type Routines } from "./routines";
import { improveBrief, selfProject } from "./selfdev";
import type { DuckSettings } from "./settings";
import { isFinished, type Task, type TaskManager } from "./tasks";

const DAY_MS = 86_400_000;
/** Task folders older than this are folded into the index. */
export const TASK_KEEP_DAYS = 30;
/** Without a remote, the reminder comes this often. */
const REMIND_EVERY_MS = 7 * DAY_MS;
/** A failing backup becomes needs-you after this long. */
const ESCALATE_AFTER_MS = DAY_MS;
/** The thread Duck's own routines report to. */
export const HOUSEKEEPING_THREAD = "Housekeeping";
/** Files a housekeeping branch may change and still be merged without asking. */
const TIDY_PATHS = /^(?:memory|skills)\//;

export interface GitLane {
  status(): Promise<BackupStatus>;
  push(): Promise<PushOutcome>;
  review(branch: string): Promise<BranchReview>;
  housekeep(cutoff: string): Promise<HousekeepReport>;
}

export interface HousekeepingDeps {
  routines: Routines;
  tasks: TaskManager;
  port: WorkbenchPort;
  settings(): DuckSettings;
  git: GitLane;
  /** The Duck project (the workspace). */
  duckProject(): Promise<string>;
  threads: {
    list(): readonly ThreadRow[];
    /** A new thread with this title; its id. */
    create(title: string): Promise<string>;
    /** `delete_thread`'s path. */
    remove(id: string): Promise<void>;
  };
  /** Why a thread can't go now (open on a surface, a turn running or parked on a
   *  card, a session watch), or null. */
  busy(threadId: string): string | null;
  /** The threads an autopilot that isn't stopped reports to. */
  piloted(): ReadonlySet<string>;
  /** Up to when the nightly tidy has read the threads (epoch ms); null: never. */
  consolidatedTo(): Promise<number | null>;
  /** A task's `result.json`, as written. */
  resultJson(t: Task): Promise<string | null>;
  tell(threadId: string, text: string, level: Level): void;
  now?: () => number;
}

export interface Housekeeping {
  /** `RoutinesDeps.run`. */
  run(r: Routine): Promise<string>;
  /** Merge a housekeeping branch you OK'd (`merge_housekeeping`). */
  merge(taskId: string): Promise<string>;
  /** The housekeeping task waiting for your OK, if any. */
  pendingMerge(): Task | null;
  /** Look at the routines' tasks once (also on every task change). */
  check(): Promise<void>;
  dispose(): void;
}

export interface IdleInput {
  threads: readonly ThreadRow[];
  now: number;
  days: number;
  consolidatedTo: number | null;
  /** Threads something reports to: a task not closed, an autopilot, a routine. */
  reportsTo: ReadonlySet<string>;
  busy(threadId: string): string | null;
}

/** The threads housekeeping may delete: idle `days` or more, not kept, nothing
 *  reporting to them, nothing open or running in them, and read by the nightly
 *  tidy since their last activity (so nothing is forgotten before it's
 *  remembered). */
export function idleThreads(i: IdleInput): ThreadRow[] {
  if (i.days <= 0) return [];
  const before = i.now - i.days * DAY_MS;
  return i.threads.filter(
    (t) =>
      t.updated < before &&
      !t.keep &&
      !i.reportsTo.has(t.id) &&
      i.busy(t.id) === null &&
      i.consolidatedTo !== null &&
      i.consolidatedTo >= t.updated,
  );
}

export const localDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function housekeepingBrief(date: string): string {
  return `Weekly housekeeping of Duck's long-term memory. You work in a git worktree of Duck's data repo, on a branch of your own. Today is ${date}. Duck has already folded old task folders into \`tasks/INDEX.md\` and committed what was left over, so this is only about \`memory/\` (and \`skills/\`, if there is one).

## Memory (\`memory/\`)

Each file is a topic (\`decisions.md\`, \`preferences.md\`, \`people.md\`, \`goals.md\`, \`lessons.md\`, \`projects/<name>.md\`). Each entry is one bullet line: \`- YYYY-MM-DD — fact. Why: … (src: …, conf: …, tags: …)\`. Leave \`core.md\` (the always-loaded profile) and \`journal/\` (the nightly journal) alone.

- Merge near-duplicates, within a file and across files, into one entry: the earliest date, every source.
- Move an entry that's in the wrong topic file to the right one.
- Tighten wording without changing what an entry says.
- Every entry needs a source (\`src:\`). Don't invent one: list the entries without one in result.md.
- Remove an entry only when the memory itself shows it's wrong or superseded (a later entry contradicts it). Every entry you remove, rather than move or merge, goes in result.json's \`removed\` with the reason and the entry or note that backs it.
- Keep the format exactly: Duck's index reads it.

## Skills (\`skills/\`, if there is one)

Check each skill's frontmatter (name, description). List problems and skills that look unused in result.md. Don't delete any.

## Done means

- Your changes committed on this branch, with a message saying what you tidied. Don't merge, don't push, don't touch other branches or the main checkout.
- result.json: the usual shape plus \`"removed": [{"entry": "<the bullet as it was>", "reason": "…", "source": "…"}]\` (\`[]\` when none).
- result.md: what you merged, moved, reworded and removed, with counts.

If \`memory/\` is already tidy, change nothing and say so.`;
}

export function repairBrief(o: PushOutcome): string {
  return `Duck's data repo (Duck's memory and config) couldn't be backed up: \`git push\` to its private \`origin\` failed. You work in a git worktree of that repo, on a branch of your own.

What git said:

\`\`\`
${o.detail.slice(0, 2000)}
\`\`\`

Fix it on your branch, so that Duck's next push goes through as a fast-forward:

- The remote moved (rejected, non-fast-forward, fetch first): \`git fetch origin\`, then merge \`origin\`'s branch into yours. On a conflict in a memory file, keep both sides' entries (each entry is one bullet line), dropping only exact duplicates. Commit the merge.
- A lock file left behind (a \`.lock\` in the message): check that no git process is running on the repo, remove that lock file, and say which in result.md.
- Anything else: don't guess. Set status \`blocked\` and say what you found.

Never push, never force anything, never rewrite history (no rebase of commits already on origin, no reset --hard). Duck merges your branch and pushes once you're done. result.md: what was wrong and what you did.`;
}

export const DOCS_REQUEST = `Monthly docs clean-up. Bring \`documentation/duck-architecture.md\` in line with the code as it is now: its module tables, the duck.db tables, the tools, the protocol messages, "Where to change X" and "Not built yet". Then tighten the As built notes in \`documentation/assistant-plan.md\` of the steps ticked since the last clean-up: cut repetition, keep every measured number, deviation and open item. Change only those two files, no code. If they're already right, change nothing and say so.`;

/** A routine's result line for a task it started. */
const started = (t: Task) => (t.state === "failed" ? `the task didn't start: ${t.error ?? "?"}` : `started task ${t.id}`);

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** The entries a worker's result.json says it removed, with a reason and a source. */
function declaredRemovals(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "null") as { removed?: unknown };
    if (!Array.isArray(v?.removed)) return [];
    return (v.removed as { entry?: unknown; reason?: unknown; source?: unknown }[])
      .filter((x) => typeof x.entry === "string" && str(x.reason)?.trim() && str(x.source)?.trim())
      .map((x) => (x.entry as string).trim());
  } catch {
    return [];
  }
}

const sameEntry = (a: string, b: string) => {
  const n = (s: string) => s.trim().replace(/^-\s+/, "").replace(/\s+/g, " ").toLowerCase();
  return n(a) === n(b);
};

export function createHousekeeping(deps: HousekeepingDeps): Housekeeping {
  const { routines, tasks, port, git } = deps;
  const now = deps.now ?? Date.now;
  /** Tasks already handled since the app started (the memo is cleared too). */
  const handled = new Set<string>();

  const routineOf = (job: string) => routines.list().find((r) => r.action.kind === "job" && r.action.job === job);
  const memoOf = (id: string) => routines.get(id)?.memo ?? {};

  /** The routine's thread, made when it has none (one "Housekeeping" thread for
   *  the built-in ones). */
  async function threadFor(r: Routine): Promise<string> {
    const live = new Set(deps.threads.list().map((t) => t.id));
    const cur = routines.get(r.id)?.threadId ?? r.threadId;
    if (cur && live.has(cur)) return cur;
    const shared = r.builtIn
      ? routines.list().find((x) => x.builtIn && x.threadId && live.has(x.threadId))?.threadId
      : undefined;
    const id = shared ?? (await deps.threads.create(r.builtIn ? HOUSEKEEPING_THREAD : r.title));
    await routines.setThread(r.id, id);
    return id;
  }

  async function tell(r: Routine, text: string, level: Level) {
    deps.tell(await threadFor(r), text, level);
  }

  // ── backup ──

  async function backup(r: Routine): Promise<string> {
    const st = await git.status();
    if (!st.repo) return "nothing to back up yet";
    if (!st.remote) {
      const at = num(memoOf(r.id).remindedAt);
      if (at === null || now() - at >= REMIND_EVERY_MS) {
        await routines.memo(r.id, { remindedAt: now() });
        await tell(
          r,
          "Duck's data (its memory, config and task results) isn't backed up: its repo has no remote. Mention it to the user once, briefly, and offer to set up a private GitHub repo for it (set_up_backup).",
          "info",
        );
      }
      return "not backed up: no remote";
    }
    const repairId = str(memoOf(r.id).repairTask);
    const repair = repairId ? tasks.get(repairId) : undefined;
    if (repair && !isFinished(repair.state)) return `waiting for the repair (task ${repair.id})`;
    if (st.ahead === 0 && !num(memoOf(r.id).failingSince)) return "up to date";
    const o = await git.push();
    if (o.outcome === "pushed" || o.outcome === "nothing") {
      const m = memoOf(r.id);
      if (num(m.failingSince) !== null) {
        await routines.memo(r.id, { failingSince: null, lastError: null, told: null });
        if (m.told) await tell(r, "Backing up Duck's data works again. Tell the user in a sentence.", "info");
      }
      return o.outcome === "pushed" ? "pushed" : "up to date";
    }
    const since = num(memoOf(r.id).failingSince) ?? now();
    await routines.memo(r.id, { failingSince: since, lastError: o.detail.slice(0, 500) });
    if ((o.outcome === "rejected" || o.outcome === "lock") && !repair) {
      const t = await tasks.run({
        threadId: await threadFor(r),
        title: "Repair Duck's data repo",
        brief: repairBrief(o),
        kind: "code",
        tier: "standard",
        projectId: await deps.duckProject(),
        quiet: true,
      });
      await routines.memo(r.id, { repairTask: t.id });
      return `push ${o.outcome}: ${started(t)} to repair it`;
    }
    const told = memoOf(r.id).told;
    if (now() - since >= ESCALATE_AFTER_MS && told !== "needs_you") {
      await routines.memo(r.id, { told: "needs_you" });
      await tell(
        r,
        `Duck's data hasn't been backed up for a day: the push to its remote fails (${o.outcome}: ${o.detail.slice(0, 300)}). Tell the user what git said and what would fix it.`,
        "needs_you",
      );
    } else if (!told) {
      await routines.memo(r.id, { told: "info" });
      await tell(r, `Backing up Duck's data failed (${o.outcome}: ${o.detail.slice(0, 300)}). Duck retries every hour. Mention it in a sentence.`, "info");
    }
    return `push failed (${o.outcome})`;
  }

  async function afterRepair(r: Routine, t: Task) {
    await routines.memo(r.id, { repairTask: null });
    if (t.state === "done" && t.instanceId) {
      try {
        const c = await port.worktreeChanges(t.instanceId);
        if (c.uncommitted.length) throw new Error(`${c.uncommitted.length} files on ${c.branch} aren't committed`);
        await port.mergeWorktree(t.instanceId);
        await tasks.close(t.id).catch(() => {});
        await routines.runNow(r.id);
        return;
      } catch (e) {
        await routines.memo(r.id, { told: "needs_you" });
        await tell(r, `The repair of Duck's data repo finished but couldn't be merged: ${e instanceof Error ? e.message : String(e)}. Tell the user; task ${t.id} has the branch.`, "needs_you");
        return;
      }
    }
    await routines.memo(r.id, { told: "needs_you" });
    await tell(
      r,
      `Duck's data can't be backed up: the push was refused, and the repair worker (task ${t.id}) ${t.state === "failed" ? `failed: ${t.error ?? "?"}` : `says: ${t.headline ?? t.state}`}. Tell the user what's wrong and what it needs from them.`,
      "needs_you",
    );
  }

  // ── housekeeping ──

  function reportsTo(): Set<string> {
    const out = new Set<string>(deps.piloted());
    for (const t of tasks.list()) if (t.state !== "closed") out.add(t.threadId);
    for (const r of routines.list()) if (r.threadId) out.add(r.threadId);
    return out;
  }

  async function cleanThreads(): Promise<string[]> {
    const gone = idleThreads({
      threads: deps.threads.list(),
      now: now(),
      days: deps.settings().deleteIdleThreadsDays,
      consolidatedTo: await deps.consolidatedTo().catch(() => null),
      reportsTo: reportsTo(),
      busy: deps.busy,
    });
    const deleted: string[] = [];
    for (const t of gone) {
      try {
        await deps.threads.remove(t.id);
        deleted.push(t.title || "untitled");
      } catch (e) {
        console.warn(`duck: housekeeping kept thread ${t.id}`, e);
      }
    }
    return deleted;
  }

  const threadsLine = (titles: readonly string[]) =>
    titles.length ? `Deleted ${titles.length} idle thread${titles.length === 1 ? "" : "s"}: ${titles.map((t) => `"${t}"`).join(", ")}.` : "No idle threads to delete.";

  async function housekeeping(r: Routine): Promise<string> {
    const going = str(memoOf(r.id).task);
    const prev = going ? tasks.get(going) : undefined;
    if (prev && !isFinished(prev.state)) return `the last run's worker is still going (task ${prev.id})`;
    const deleted = await cleanThreads();
    const mech = await git.housekeep(localDate(now() - TASK_KEEP_DAYS * DAY_MS));
    const mechLine = [
      mech.indexed.length && `folded ${mech.indexed.length} old task folders into tasks/INDEX.md`,
      mech.removed && `removed ${mech.removed} of their intermediate files (${Math.round(mech.bytes / 1024)} KB)`,
      mech.committed.length && `committed ${mech.committed.length} files no commit had taken`,
    ]
      .filter(Boolean)
      .join("; ");
    const st = await git.status();
    if (!st.repo) {
      await tell(r, `Weekly housekeeping ran. ${threadsLine(deleted)} ${mechLine ? `Also ${mechLine}.` : ""} Memory has no repo yet, so there was nothing to tidy. Report it in a line or two.`, "info");
      return `${threadsLine(deleted)} No memory repo yet.`;
    }
    const t = await tasks.run({
      threadId: await threadFor(r),
      title: `Housekeeping ${localDate(now())}`,
      brief: housekeepingBrief(localDate(now())),
      kind: "code",
      tier: "standard",
      projectId: await deps.duckProject(),
      quiet: true,
    });
    await routines.memo(r.id, { task: t.id, deleted, mech: mechLine });
    return `${threadsLine(deleted)} ${started(t)} to tidy memory.`;
  }

  async function afterHousekeeping(r: Routine, t: Task) {
    const m = memoOf(r.id);
    const deleted = Array.isArray(m.deleted) ? (m.deleted as string[]) : [];
    const mech = str(m.mech);
    const head = `Weekly housekeeping: ${threadsLine(deleted)}${mech ? ` Duck also ${mech}.` : ""}`;
    await routines.memo(r.id, { task: null });
    if (t.state !== "done" || !t.instanceId) {
      await tell(r, `${head} The memory tidy-up (task ${t.id}) ${t.state === "failed" ? `failed: ${t.error ?? "?"}` : `came back ${t.state}: ${t.headline ?? ""}`}. Report it, briefly.`, "report");
      return;
    }
    try {
      const c = await port.worktreeChanges(t.instanceId);
      if (!c.files.length) {
        await port.mergeWorktree(t.instanceId).catch(() => {});
        await tasks.close(t.id).catch(() => {});
        await tell(r, `${head} Memory was already tidy. Report it in a line or two.`, "info");
        return;
      }
      const review = await git.review(c.branch);
      const declared = declaredRemovals(await deps.resultJson(t));
      const unexplained = review.removed.filter((e) => !declared.some((d) => sameEntry(d, e)));
      const outside = c.files.filter((f) => !TIDY_PATHS.test(f.replace(/\\/g, "/")));
      if (!c.uncommitted.length && !outside.length && !unexplained.length) {
        await port.mergeWorktree(t.instanceId);
        await tasks.close(t.id).catch(() => {});
        const backupRoutine = routineOf("backup");
        if (backupRoutine) void routines.runNow(backupRoutine.id);
        await tell(
          r,
          `${head} The memory tidy-up changed ${c.files.length} files (${review.added} entries added or reworded, ${review.removed.length} removed, each with its reason) and was merged. Its summary: ${t.headline ?? ""}. Report it in a few lines, naming the deleted threads.`,
          "info",
        );
        return;
      }
      await routines.memo(r.id, { pendingMerge: t.id });
      const why = [
        unexplained.length && `it drops ${unexplained.length} memory entries without a sourced reason: ${unexplained.slice(0, 8).join(" | ")}`,
        outside.length && `it changes files outside memory/: ${outside.slice(0, 8).join(", ")}`,
        c.uncommitted.length && `${c.uncommitted.length} files aren't committed on its branch`,
      ]
        .filter(Boolean)
        .join("; ");
      await tell(
        r,
        `${head} The memory tidy-up (task ${t.id}, branch ${c.branch}, ${c.files.length} files) wasn't merged, because ${why}. Its summary: ${t.headline ?? ""}. Tell the user, list what it would remove, and point to "open diff" on its task card; merge it with merge_housekeeping only when they OK it.`,
        "report",
      );
    } catch (e) {
      await tell(r, `${head} The memory tidy-up (task ${t.id}) finished, but its branch couldn't be read or merged: ${e instanceof Error ? e.message : String(e)}. Tell the user.`, "report");
    }
  }

  // ── docs ──

  async function docs(r: Routine): Promise<string> {
    const going = str(memoOf(r.id).task);
    const prev = going ? tasks.get(going) : undefined;
    if (prev && prev.state !== "closed") return `last month's clean-up (task ${prev.id}) is still open`;
    const p = selfProject(port);
    const t = await tasks.run({
      threadId: await threadFor(r),
      title: "Duck: monthly docs clean-up",
      brief: improveBrief({ request: DOCS_REQUEST, lessons: [], wide: true }),
      kind: "code",
      tier: "serious",
      effort: "medium",
      projectId: p.id,
      self: true,
    });
    await routines.memo(r.id, { task: t.id });
    return started(t);
  }

  // ── watching the routines' tasks ──

  async function check(): Promise<void> {
    for (const r of routines.list()) {
      if (r.action.kind !== "job") continue;
      const field = r.action.job === "backup" ? "repairTask" : r.action.job === "housekeeping" ? "task" : null;
      const id = field ? str(r.memo[field]) : null;
      const t = id ? tasks.get(id) : undefined;
      if (!t || !isFinished(t.state) || handled.has(t.id)) continue;
      handled.add(t.id);
      if (r.action.job === "backup") await afterRepair(r, t);
      else await afterHousekeeping(r, t);
    }
  }
  const off = tasks.subscribe(() => void check().catch((e: unknown) => console.warn("duck: a routine's task wasn't followed up", e)));

  return {
    async run(r) {
      const a = r.action;
      if (a.kind === "message") {
        await tell(r, `Your routine "${r.title}" (${scheduleText(r.schedule)}) is due: ${a.text}`, "report");
        return "sent to Duck";
      }
      if (a.kind === "task") {
        const t = await tasks.run({ threadId: await threadFor(r), title: r.title, brief: a.brief, kind: a.taskKind, tier: a.tier });
        return started(t);
      }
      if (a.job === "backup") return backup(r);
      if (a.job === "housekeeping") return housekeeping(r);
      return docs(r);
    },
    async merge(taskId) {
      const r = routineOf("housekeeping");
      const pending = r ? str(r.memo.pendingMerge) : null;
      if (!r || !pending || (pending !== taskId && !pending.startsWith(taskId)))
        throw new Error("That isn't a housekeeping branch waiting for the user's OK.");
      const t = tasks.get(pending);
      if (!t?.instanceId) throw new Error(`Task ${pending} has no session to merge.`);
      const into = await port.mergeWorktree(t.instanceId);
      await tasks.close(t.id).catch(() => {});
      await routines.memo(r.id, { pendingMerge: null });
      const b = routineOf("backup");
      if (b) void routines.runNow(b.id);
      return `merged into ${into}`;
    },
    pendingMerge() {
      const id = str(routineOf("housekeeping")?.memo.pendingMerge);
      return (id && tasks.get(id)) || null;
    },
    check,
    dispose: off,
  };
}
