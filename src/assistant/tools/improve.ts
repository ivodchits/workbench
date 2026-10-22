// Duck improving itself (step L3), cheapest first:
//
// - `improve_duck` with scope `config`: Duck's prompts are files (`config.ts`), so
//   the request comes back with them, and Duck drafts the change itself as
//   `propose_config_change`: a diff on a card, always yours to approve (the floor),
//   taking effect in the threads started after it.
// - `improve_duck` with scope `code`: a serious-tier worker (Opus, `medium` unless
//   you say) in a worktree of the Workbench repo, with the brief `selfdev.ts`
//   writes. Its card offers the diff; changes go to the worker with
//   `task_followup`.
// - `merge_duck_change`: merging Duck's own code is on the floor, and a branch
//   touching the safety layer asks twice, in code: the second card comes only
//   after the first was confirmed.
// - `rebuild_duck`: Duck never hot-patches itself; after a merge it offers a dev
//   build, or a release build to restart into.

import { z } from "zod";

import { EFFORTS } from "../../util/models";
import { applyEdits, CONFIG_ABOUT, CONFIG_FILES, DEFAULT_PROMPTS, problemsWith, type ConfigFile, type ConfigHost } from "../config";
import { improveBrief, REBUILD, safetyFiles, selfProject } from "../selfdev";
import type { WorkbenchPort } from "../port";
import type { TaskManager } from "../tasks";
import { defineTool, type PrepareEnv, type ToolContext } from "./registry";
import { findTask, manager, view } from "./tasks";

function config(env: Pick<PrepareEnv, "config">): ConfigHost {
  if (!env.config) throw new Error("Duck's config files aren't available here.");
  return env.config;
}

const DEFAULT_TEXT: Record<ConfigFile, string> = { "system.md": DEFAULT_PROMPTS.system, "voice.md": DEFAULT_PROMPTS.voice };

const configSchema = z.object({
  file: z.enum(CONFIG_FILES),
  edits: z
    .array(
      z.object({
        find: z.string().max(20_000).describe("Text from the file as it is now, exactly, found once; empty appends `replace` at the end."),
        replace: z.string().max(20_000),
      }),
    )
    .min(1)
    .max(20),
  why: z.string().trim().min(1).max(300).describe("What the change is for, in a sentence: the commit message and the card's line."),
});

interface ConfigPlan {
  /** On disk now (null: no file, so the default is changed). */
  before: string | null;
  after: string;
}

export const proposeConfigChange = defineTool<typeof configSchema, ConfigPlan>({
  name: "propose_config_change",
  description: [
    "Change one of Duck's own prompt files (read them first with improve_duck, scope config): system.md is your system prompt (how you work, routing rules and examples, tiers, safety), voice.md the note on a spoken message.",
    "Give the smallest edits that do it: each `find` is text copied exactly from the file, found once. The user sees the diff on a card and approves it; it takes effect in threads started after it (this one keeps its prompts).",
    "The safety rules section must stay as it is.",
  ].join(" "),
  schema: configSchema,
  tier: "consequential",
  async prepare({ file, edits }, _port, env) {
    const st = await config(env ?? {}).current();
    const f = st.files.find((x) => x.file === file);
    const before = f?.text ?? null;
    const after = applyEdits(before ?? DEFAULT_TEXT[file], edits);
    if (after === (before ?? DEFAULT_TEXT[file])) throw new Error("the edits change nothing");
    const problems = problemsWith(file, after);
    if (problems.length) throw new Error(`config/${file} can't be used like that: ${problems.join("; ")}`);
    return { before, after };
  },
  describe: ({ file, why }) => `Change Duck's config/${file}: ${why}. It takes effect in threads started after it.`,
  review: ({ file }, p) => [{ label: `config/${file}`, before: p.before, after: p.after }],
  trust: () => ({ projectId: null, asks: "a change to Duck's own prompts is always yours to approve" }),
  async run({ file, why }, ctx) {
    await config(ctx).write(file, ctx.prepared.after, ctx.prepared.before, `config: ${why.slice(0, 72)}`);
    return { changed: `config/${file}`, takesEffect: "in threads started from now on; this thread keeps the prompts it started with" };
  },
});

const improveSchema = z.object({
  request: z.string().trim().min(1).max(8000).describe("What the user wants changed about you, in their words."),
  scope: z
    .enum(["config", "code"])
    .describe("config: what you say, how you route, your examples (your prompt files, no code). code: a new tool or behavior, which needs a change to Duck's code."),
  effort: z.enum(EFFORTS).optional().describe("code only: the worker's effort, when the user names it (medium by default)."),
  title: z.string().trim().min(1).max(80).optional(),
  project: z.string().trim().min(1).optional().describe("code only: the Workbench repo's project, when it isn't the one called workbench."),
  wide: z.boolean().default(false).describe("code only: the user asked for a change outside Duck's own modules."),
});

/** The `lessons` entries that may bear on a request. */
async function lessonsFor(ctx: ToolContext, request: string): Promise<string[]> {
  if (!ctx.memory) return [];
  const hits = await ctx.memory.search(request, 20).catch(() => []);
  return hits
    .filter((h) => h.kind === "memory" && h.entry?.topic === "lessons")
    .slice(0, 8)
    .map((h) => h.text);
}

export const improveDuck = defineTool({
  name: "improve_duck",
  description: [
    'Improve yourself, when the user asks ("Duck, when I say the backend always pick backend-api", "Duck, add a tool that lists my git stashes"). Cheapest first:',
    "scope config for what you say, how you route and your examples: it returns your prompt files, and you draft the change yourself with propose_config_change.",
    "scope code for a new tool or behavior: a serious-tier worker (Opus) changes Duck's code in a worktree of the Workbench repo and tests it; you report when it's done, the user reviews the diff, and merging is theirs (merge_duck_change).",
    "A standing fact or nickname for one thread's worth isn't this: that's remember_core.",
  ].join(" "),
  schema: improveSchema,
  tier: "reversible",
  timeoutMs: 30_000,
  describe: ({ scope, request }) => `${scope === "code" ? "Start an Opus worker on Duck's code" : "Read Duck's prompt files"}: ${request.slice(0, 120)}`,
  trust: (input) => ({ projectId: null, texts: [input.request] }),
  async run({ request, scope, effort, title, project, wide }, ctx) {
    if (scope === "config") {
      const st = await config(ctx).current();
      return {
        files: st.files.map((f) => ({
          file: f.file,
          about: CONFIG_ABOUT[f.file],
          ...(f.used === "default" && f.text !== null && { note: `the file isn't used (${f.problems.join("; ")}); the built-in default is` }),
          ...(f.defaultChanged && { defaultChanged: "the built-in default changed since this file was edited" }),
          text: f.text ?? DEFAULT_TEXT[f.file],
        })),
        next: "Draft the change with propose_config_change: the smallest edits, each `find` copied exactly from the text above. If these files can't do what the user wants, say so and offer scope code.",
      };
    }
    const tasks = manager(ctx);
    const p = selfProject(ctx.port, project);
    const brief = improveBrief({ request, lessons: await lessonsFor(ctx, request), wide });
    const firstLine = request.split("\n")[0].trim();
    const t = await tasks.run({
      threadId: ctx.threadId,
      title: title ?? `Duck: ${firstLine.length > 70 ? `${firstLine.slice(0, 69)}…` : firstLine}`,
      brief,
      kind: "code",
      tier: "serious",
      effort: effort ?? "medium",
      projectId: p.id,
      mandate: ctx.request ? { text: ctx.request, threadId: ctx.threadId } : undefined,
      self: true,
    });
    await ctx.notice({ kind: "task", text: `Task: ${t.title}`, task: { id: t.id } });
    return {
      ...view(t),
      repo: p.name,
      next:
        t.state === "failed"
          ? `it didn't start: ${t.error ?? t.state}`
          : "an Opus worker is on it in a worktree of the Workbench repo; you'll get a <workbench_event> when it's done. Nothing is merged without the user.",
    };
  },
});

const mergeSchema = z.object({
  task: z.string().trim().min(1).describe("The change's task id."),
  safetyConfirmed: z
    .boolean()
    .default(false)
    .describe("Only on the second call, after the user confirmed the first card of a change touching the safety layer."),
});

interface MergePlan {
  taskId: string;
  title: string;
  instanceId: string;
  branch: string;
  base: string;
  files: string[];
  safety: string[];
  stage: "only" | "first" | "second";
}

/** First confirmations of changes touching the safety layer, by task, with the
 *  files they were for: the second card is shown only after one of these. */
const firstConfirms = new Map<string, string>();
const signature = (p: Pick<MergePlan, "branch" | "files">) => `${p.branch}\n${p.files.join("\n")}`;

export const mergeDuckChange = defineTool<typeof mergeSchema, MergePlan>({
  name: "merge_duck_change",
  description:
    "Merge a finished change to Duck (an improve_duck code task) into the Workbench repo's current branch, when the user asks: its worktree and branch go, and the change is active after a rebuild (offer rebuild_duck). Always confirmed by the user. A change touching the safety layer asks twice: after the first card is confirmed, call again with safetyConfirmed.",
  schema: mergeSchema,
  tier: "consequential",
  timeoutMs: 60_000,
  prepare: ({ task, safetyConfirmed }, port, env) => planMerge(env?.tasks ?? null, port, task, safetyConfirmed),
  describe: (_i, _port, p) => {
    const what = `"${p.title}": ${p.files.length} files on ${p.branch} into ${p.base}`;
    if (p.stage === "only") return `Merge Duck's change ${what}.`;
    const safety = `It touches the safety layer: ${p.safety.join(", ")}.`;
    return p.stage === "first"
      ? `Merge Duck's change ${what}. ${safety} This is the first of two confirmations.`
      : `Second confirmation: merge ${what}. ${safety}`;
  },
  trust: () => ({ projectId: null, asks: "merging Duck's own code is always yours" }),
  async run(_input, ctx) {
    const p = ctx.prepared;
    const tasks = manager(ctx);
    if (p.stage === "first") {
      firstConfirms.set(p.taskId, signature(p));
      return {
        merged: false,
        next: "The user confirmed once. The change touches the safety layer, so it needs a second confirmation: call merge_duck_change again with safetyConfirmed: true.",
      };
    }
    const into = await ctx.port.mergeWorktree(p.instanceId);
    firstConfirms.delete(p.taskId);
    await tasks.close(p.taskId).catch(() => {});
    return {
      merged: true,
      branch: p.branch,
      into,
      files: p.files.length,
      next: "It isn't active until Workbench is rebuilt: offer rebuild_duck (a dev build, or a release build and a restart).",
    };
  },
});

/** What a merge would do, read fresh from the branch: refused while the worker
 *  runs, with nothing on the branch, or with changes not committed on it. */
async function planMerge(tasks: TaskManager | null, port: WorkbenchPort, ref: string, safetyConfirmed: boolean): Promise<MergePlan> {
  if (!tasks) throw new Error("Worker tasks aren't available here.");
  const t = findTask(tasks, ref);
  if (!t.self) throw new Error(`"${t.title}" isn't a change to Duck (only improve_duck's code tasks merge this way).`);
  if (!t.instanceId) throw new Error(`"${t.title}" never started.`);
  if (t.state === "queued" || t.state === "running") throw new Error(`"${t.title}" is still ${t.state}: wait for its result.`);
  const c = await port.worktreeChanges(t.instanceId);
  if (!c.files.length) throw new Error(`"${t.title}" changed nothing on ${c.branch}.`);
  if (c.uncommitted.length)
    throw new Error(
      `${c.uncommitted.length} files aren't committed on ${c.branch} (${c.uncommitted.slice(0, 5).join(", ")}): have the worker commit them (task_followup) first.`,
    );
  const safety = safetyFiles(c.files);
  const plan = { taskId: t.id, title: t.title, instanceId: t.instanceId, branch: c.branch, base: c.base, files: c.files, safety };
  const stage = !safety.length ? "only" : safetyConfirmed && firstConfirms.get(t.id) === signature(plan) ? "second" : "first";
  return { ...plan, stage };
}

const rebuildSchema = z.object({
  build: z.enum(["dev", "release"]).describe("dev: `npm run tauri:dev`, a dev build beside this one. release: `npm run tauri:build`, then restart Workbench into it."),
  project: z.string().trim().min(1).optional().describe("The Workbench repo's project, when it isn't the one called workbench."),
});

export const rebuildDuck = defineTool({
  name: "rebuild_duck",
  description:
    "After a change to Duck is merged, build Workbench with it, in a new shell in the Workbench repo: a dev build (starts beside this app) or a release build (then the user restarts into it). Threads, memory and tasks survive a restart. Offer it; run it when the user says which.",
  schema: rebuildSchema,
  tier: "consequential",
  describe: ({ build }, port) => {
    const name = (() => {
      try {
        return selfProject(port).name;
      } catch {
        return "the Workbench repo";
      }
    })();
    return build === "dev"
      ? `Run \`${REBUILD.dev.command}\` in a new shell in ${name}: a dev build with the change starts beside this app.`
      : `Run \`${REBUILD.release.command}\` in a new shell in ${name}; once it's built, restart Workbench to run it.`;
  },
  trust: (input, port) => {
    try {
      return { projectId: selfProject(port, input.project).id };
    } catch {
      return { projectId: null };
    }
  },
  async run({ build, project }, ctx) {
    const p = selfProject(ctx.port, project);
    const r = REBUILD[build];
    await ctx.port.runInShell(p.id, r.command, r.label);
    return {
      started: r.command,
      in: p.name,
      next:
        build === "dev"
          ? "The dev build runs in its shell; a second Workbench window opens when it's built (a few minutes the first time)."
          : "The release build runs in its shell; when it's done, the user restarts Workbench (threads, memory and tasks survive).",
    };
  },
});

export const IMPROVE_TOOLS = [improveDuck, proposeConfigChange, mergeDuckChange, rebuildDuck];
