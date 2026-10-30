// Duck's action tools (step W2): what lets it drive sessions the way you do from the
// phone. Every action goes through the port, which reuses the app's own paths (the
// prompt queue, the rail's new-instance and kill, the choice card's keys); there is
// no keystroke code here.
//
// Tiers: in-app actions that can be undone are `reversible` and run at once (the
// policy can still ask for prompts, a setting); answering a prompt, interrupting or
// stopping a session, replacing or deleting a note, and resuming over a running
// session are `consequential`: they ask on a card unless a trust rule allows them,
// or the user's own words asked for that call (`grantedBy`, step T1). Each tool's
// `trust` names the call's project, and what the floor should read (a prompt's
// text, the command a permission answer lets through).
//
// Notes writes carry the revision Duck read, so they never overwrite an edit made
// since, and each leaves a "Duck edited" chip in the thread with a diff and undo.

import { z } from "zod";
import { isStale } from "../../ipc/notes";
import { DUCK_PERMISSION_MODES, SESSION_MODELS } from "../../util/models";
import { MAX_ATTACHMENTS } from "../attachments";
import type { PromptDelivery, SessionPhase, SessionRef, WorkbenchPort, WorktreeLoss } from "../port";
import type { NoteEdit } from "../protocol";
import { quotes } from "../trust/mandate";
import {
  choiceLine,
  compact,
  findProject,
  findSession,
  NOTE_CHARS,
  projectArg,
  sessionArg,
} from "./read";
import { defineTool, type ToolContext } from "./registry";
import { remindersFor } from "./reminders";

const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const projectName = (port: WorkbenchPort, s: SessionRef) =>
  port.listProjects().find((p) => p.id === s.projectId)?.name ?? s.projectId;

/** A session Claude Code is running in (not offline, not ended). */
const isLive = (s: SessionRef) => s.phase !== "offline" && s.phase !== "ended";

const DELIVERY: Record<PromptDelivery, string> = {
  sent: "sent: Claude Code took it and the session is working on it",
  queued:
    "queued: the session is mid-turn or waiting on a prompt from the user; it goes in when the turn ends, together with anything else waiting",
  starting:
    "starting: the session wasn't running, so it was started with this prompt, continuing its last conversation",
  unsent:
    "unsent: it was typed into the session's prompt box but Claude Code didn't take it; check with read_screen, and press Enter there with press_keys if it's sitting in the input box",
};

const sessionArgs = { session: sessionArg, project: projectArg.optional() };

/** The trust facts of a call on one session, or on one project. */
const onSession = (
  { session, project }: { session: string; project?: string },
  port: WorkbenchPort,
) => ({ projectId: findSession(port, session, project).projectId });
const onProject = ({ project }: { project: string }, port: WorkbenchPort) => ({
  projectId: findProject(port, project).id,
});

/** The user's own words that ask for the call: with them a consequential call runs
 *  without a card (the trust engine checks they're really in the user's messages). */
export const grantArg = z
  .string()
  .max(500)
  .optional()
  .describe(
    "The user's own words in this thread that ask for or allow this exact call, quoted exactly (e.g. \"stop api and tests\"). With them it runs at once; leave it out when they didn't say so.",
  );

/** Trust facts for a session call that may carry the user's words. */
const onSessionGranted = (
  input: { session: string; project?: string; grantedBy?: string },
  port: WorkbenchPort,
) => ({ ...onSession(input, port), grant: input.grantedBy?.trim() || undefined });

// ── sessions ────────────────────────────────────────────────────────────────

export const sendPrompt = defineTool({
  name: "send_prompt",
  description:
    "Send a prompt to a Workbench session, as if the user typed it. A session between turns gets it now; a session that isn't running is started with it, continuing its last conversation. For a session mid-turn, choose `when`: `now` puts it into the running turn, read at the session's next step (a correction, a constraint, an answer to what it is doing, a stop or change of direction); `after_turn` (the default) waits for the turn to end (new work that shouldn't disturb the current task). Prompts waiting for the same turn end go in together as one. Put several requests for one session into one prompt yourself. Write the prompt as the user would: say what to do, not who is asking. `files`: ids of attachments in this thread (from <attachment id=…>, or files a worker made) to hand the session: images, PDFs, text, any file. They are copied into the session's folder (.duck-attachments/, ignored by git) and the prompt ends with their paths, so Claude Code reads them itself. Pass the id rather than describing or copying out what's in the file.",
  schema: z.object({
    ...sessionArgs,
    text: z.string().trim().min(1).max(20_000).describe("The prompt."),
    when: z
      .enum(["now", "after_turn"])
      .optional()
      .describe("For a session mid-turn: into the running turn, or after it (default)."),
    files: z
      .array(z.string().trim().min(1))
      .max(MAX_ATTACHMENTS)
      .optional()
      .describe("Attachment ids to copy into the session's folder; the prompt names their paths."),
  }),
  tier: "reversible",
  describe({ session, project, text, files }, port) {
    const s = findSession(port, session, project);
    const n = new Set(files ?? []).size;
    return `Send to "${s.title}"${n ? ` with ${n} file${n === 1 ? "" : "s"}` : ""}: ${cut(text, 240)}`;
  },
  trust: (input, port) => ({ ...onSession(input, port), texts: [input.text] }),
  timeoutMs: 20_000,
  async run({ session, project, text, when, files }, { port, later, attachment, toSession }) {
    const s = findSession(port, session, project);
    const paths = files?.length ? await filesFor(port, s, files, attachment, toSession) : [];
    const delivery = await port.sendPrompt(s.id, paths.length ? `${text}\n\n${filesLine(paths)}` : text, {
      now: when === "now",
      onFailed: (why) => later(`The prompt sent to "${s.title}" didn't go in: ${why}.`),
    });
    return {
      session: s.title,
      id: s.id,
      delivery: DELIVERY[delivery],
      ...(paths.length && { files: paths }),
    };
  },
});

/** What the prompt ends with when files go along: their paths, one a line. */
export const filesLine = (paths: readonly string[]) =>
  `Attached file${paths.length === 1 ? "" : "s"} (read with your Read tool):\n${paths.map((p) => `- ${p}`).join("\n")}`;

/** Copy the thread's files `ids` into the session's working directory; the paths. */
async function filesFor(
  port: WorkbenchPort,
  s: SessionRef,
  ids: readonly string[],
  attachment: ToolContext["attachment"],
  toSession: ToolContext["toSession"],
): Promise<string[]> {
  const refs = [...new Set(ids)].map((id) => {
    const f = attachment?.(id);
    if (!f) throw new Error(`There is no file ${id} in this thread: use the id from its <attachment> tag.`);
    return f;
  });
  if (port.listProjects().find((p) => p.id === s.projectId)?.remote)
    throw new Error(`"${s.title}" runs on another machine: files can only go to a session on this computer.`);
  if (!toSession) throw new Error("Files can't be sent to sessions here.");
  if (!s.workingDir) throw new Error(`"${s.title}" has no folder to put the files in.`);
  return toSession(s.workingDir, refs);
}

export const createSession = defineTool({
  name: "create_session",
  description:
    "Start a new Workbench session (a Claude Code console) in a project, optionally with a first prompt and in its own git worktree. Leave `model` out for coding or other professional work: it then runs on the coding model from Duck's settings. Pass `project` to use the project's own default model instead, or a model name when the user asks for one. `permissionMode` works the same way: leave it out for Duck's coding setting, `project` for the project's default, or a mode when the user asks for one (`acceptEdits` takes file edits without asking, `plan` only plans). When the user hands the session over to you (\"handle its questions\", \"don't bother me with it\"), quote those words of theirs in `delegatedBy`: you then answer its questions for them, and leave only the serious ones to them. The new session gets the focus, as when the user makes one.",
  schema: z.object({
    project: projectArg,
    prompt: z
      .string()
      .max(20_000)
      .optional()
      .describe("The first prompt, sent once Claude Code is ready."),
    title: z
      .string()
      .max(80)
      .optional()
      .describe("The session's title; defaults to the next free number."),
    worktree: z
      .boolean()
      .optional()
      .describe("Isolate it in a new git worktree (local projects only)."),
    model: z.enum([...SESSION_MODELS, "project"]).optional(),
    permissionMode: z.enum([...DUCK_PERMISSION_MODES, "project"]).optional(),
    delegatedBy: z
      .string()
      .max(500)
      .optional()
      .describe("The user's own words handing the session over to you, quoted from their latest message."),
  }),
  tier: "reversible",
  // A worktree's setup command (an install) can take a while.
  timeoutMs: 90_000,
  describe({ project, prompt }, port) {
    const p = findProject(port, project);
    return `Start a session in ${p.name}${prompt?.trim() ? ` and send: ${cut(prompt, 240)}` : ""}`;
  },
  trust: (input, port) => ({ ...onProject(input, port), texts: input.prompt ? [input.prompt] : [] }),
  async run(
    { project, prompt, title, worktree, model, permissionMode, delegatedBy },
    { port, settings, request, threadId, reminders },
  ) {
    // Handed over only on the user's own words (step T3).
    const delegated = !!delegatedBy?.trim() && quotes(request, delegatedBy);
    const p = findProject(port, project);
    if (worktree && p.remote)
      throw new Error(`${p.name} is a remote project: worktrees are local only.`);
    const m = model === "project" ? null : (model ?? settings.codingModel);
    const mode =
      permissionMode === "project" ? null : (permissionMode ?? settings.codingPermissionMode);
    const made = await port.createSession({
      projectId: p.id,
      title,
      prompt,
      worktree,
      model: m,
      permissionMode: mode,
      // What the session is for, in the user's words: its prompts are judged by it.
      mandate: request ? { text: request, threadId, ...(delegated && { delegated: true }) } : undefined,
    });
    return compact({
      id: made.id,
      title: made.title,
      project: p.name,
      model: m ?? "the project's default",
      permissionMode: mode ?? "the project's default",
      worktree: worktree ?? null,
      prompt: prompt?.trim() ? "sent once Claude Code is ready (queued on its card if it never is)" : null,
      delegated: delegatedBy?.trim()
        ? delegated
          ? "yes: you answer its questions, the serious ones go to the user"
          : "no: those words aren't in the user's latest message, so its questions go to them"
        : null,
      warning: made.message,
      // The project's reminders come up with every new session there (H8).
      ...remindersFor({ reminders }, p.id),
    });
  },
});

export const startSession = defineTool({
  name: "start_session",
  description:
    "Open a session's console and show it: starts Claude Code there if it isn't running (a fresh conversation), else just brings it to the front.",
  schema: z.object(sessionArgs),
  tier: "reversible",
  trust: onSession,
  run({ session, project }, { port }) {
    const s = findSession(port, session, project);
    port.startSession(s.id);
    return { session: s.title, id: s.id, started: !isLive(s) };
  },
});

export const resumeSession = defineTool({
  name: "resume_session",
  description:
    "Relaunch a session's console on a past Claude Code conversation: `sessionId` if given, else its most recent one. A session that is running is restarted, which the user must confirm.",
  schema: z.object({
    ...sessionArgs,
    sessionId: z.string().optional().describe("A past Claude Code session id."),
    grantedBy: grantArg,
  }),
  tier: "reversible",
  tierFor({ session, project }, port) {
    return isLive(findSession(port, session, project)) ? "consequential" : "reversible";
  },
  describe({ session, project, sessionId }, port) {
    const s = findSession(port, session, project);
    return `${isLive(s) ? "Restart" : "Resume"} "${s.title}" on ${sessionId ? `session ${sessionId}` : "its last conversation"}`;
  },
  trust: onSessionGranted,
  run({ session, project, sessionId }, { port }) {
    const s = findSession(port, session, project);
    port.resumeSession(s.id, sessionId);
    return { session: s.title, id: s.id, resumed: sessionId ?? "the last conversation" };
  },
});

// A number or a string: models send "1" as often as 1.
const optionArg = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe(
    'An option\'s key from get_pending_choice (1-9), or "deny" to dismiss the prompt. Leave it out when giving `text`.',
  );

type Answer = number | "deny" | { text: string };

/** The answer an input names, or an Error saying what's wrong with it. */
function answerOf(option: number | string | undefined, text: string | undefined): Answer {
  if (text?.trim()) {
    if (option !== undefined && String(option).trim() !== "")
      throw new Error("Give either `option` or `text`, not both.");
    return { text: text.trim() };
  }
  const o = String(option ?? "").trim().toLowerCase();
  if (o === "deny") return "deny";
  if (/^[1-9]$/.test(o)) return Number(o);
  throw new Error(
    `"${option ?? ""}" isn't an option: give its key (1-9), "deny", or a typed answer in \`text\`.`,
  );
}

function choiceLabel(s: SessionRef, answer: Answer): string {
  if (typeof answer === "object") return `typed answer "${cut(answer.text, 200)}"`;
  if (answer === "deny") return s.choice?.kind === "permission" ? "deny" : "dismiss";
  const o = s.choice?.options.find((x) => x.key === answer);
  return o ? `${o.key}. ${o.label}` : `option ${answer}`;
}

/** A question asked by one of Duck's own workers: Duck is its user (step D2). */
const workerQuestion = (s: SessionRef) => s.duckTask !== null && s.choice?.kind === "question";

export const answerChoice = defineTool({
  name: "answer_choice",
  description:
    "Answer the prompt a session is waiting on (a permission request, a question or a plan approval) with one of its options, or deny it. A question also takes a free-form answer in `text` (its \"Type something\" choice) instead of an option. Call get_pending_choice first: it gives the choiceId and the options. Answering a permission request or a plan asks the user on a card, unless their own message already allowed it (\"approve it if it asks\"): then quote those words in `grantedBy` and it runs at once. Never quote words that aren't the user's, and never pick a \"don't ask again\" option on their behalf. A question from one of your own workers you answer as its user, at once: give `reason`, which shows on its task card.",
  schema: z.object({
    ...sessionArgs,
    choiceId: z.string().describe("The prompt's choiceId from get_pending_choice."),
    option: optionArg,
    text: z
      .string()
      .max(2000)
      .optional()
      .describe("A free-form answer to a question, instead of an option."),
    grantedBy: grantArg,
    reason: z
      .string()
      .max(500)
      .optional()
      .describe("For a worker's question: what settles the answer (\"you said earlier you want Postgres\")."),
  }).superRefine(({ option, text }, ctx) => {
    // Checked with the schema, so a call that names no answer fails before a card.
    try {
      answerOf(option, text);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message, path: ["option"] });
    }
  }),
  tier: "consequential",
  tierFor: ({ session, project }, port) => (workerQuestion(findSession(port, session, project)) ? "reversible" : "consequential"),
  describe({ session, project, option, text }, port) {
    const s = findSession(port, session, project);
    const what = s.choice ? choiceLine(s.choice) : "its prompt";
    return `Answer "${s.title}" — ${what} — with: ${choiceLabel(s, answerOf(option, text))}`;
  },
  trust({ session, project, option, text, grantedBy }, port) {
    const s = findSession(port, session, project);
    const c = s.choice;
    const answer = answerOf(option, text);
    const label = typeof answer === "number" ? (c?.options.find((o) => o.key === answer)?.label ?? "") : "";
    return {
      projectId: s.projectId,
      specifier: c?.kind ?? "none",
      texts: typeof answer === "object" ? [answer.text] : label ? [label] : [],
      // What a "yes" lets the session do; a denial lets nothing through.
      call: c?.kind === "permission" && answer !== "deny" ? { tool: c.toolName, input: c.input } : undefined,
      // "Don't ask again" writes a rule into Claude Code: never on a quoted permission.
      grant: grantedBy?.trim() && !/don.?t ask again|always allow/i.test(label) ? grantedBy : undefined,
    };
  },
  run({ session, project, choiceId, option, text, reason }, { port, tasks }) {
    const s = findSession(port, session, project);
    const asked = workerQuestion(s) ? (s.choice?.questions[0]?.question ?? "") : null;
    const label = port.answerChoice(s.id, choiceId, answerOf(option, text));
    if (asked !== null) tasks?.noteAnswer(s.id, { question: asked, answer: label, reason: reason?.trim() || "" });
    return { session: s.title, answered: label };
  },
});

export const interruptSession = defineTool({
  name: "interrupt_session",
  description:
    "Stop a session's current turn (Esc in its console). The session stays open and waits for the next prompt.",
  schema: z.object(sessionArgs),
  tier: "consequential",
  describe({ session, project }, port) {
    return `Interrupt "${findSession(port, session, project).title}" (Esc)`;
  },
  trust: onSession,
  run({ session, project }, { port }) {
    const s = findSession(port, session, project);
    port.interruptSession(s.id);
    return { session: s.title, interrupted: true };
  },
});

export const stopSession = defineTool({
  name: "stop_session",
  description:
    "Close a session's console and end its Claude Code process. The session stays on the rail and can be resumed.",
  schema: z.object({ ...sessionArgs, grantedBy: grantArg }),
  tier: "consequential",
  describe({ session, project }, port) {
    return `Stop "${findSession(port, session, project).title}" (close its console)`;
  },
  trust: onSessionGranted,
  run({ session, project }, { port }) {
    const s = findSession(port, session, project);
    port.stopSession(s.id);
    return { session: s.title, stopped: true };
  },
});

export const killSession = defineTool({
  name: "kill_session",
  description:
    "Kill a session: end its Claude Code process and remove it from the rail for good (the rail's \"kill instance\"). Use it to clear away sessions that are finished or dead; use stop_session to keep one around for later. Its past conversations stay on disk. Refused for a session with a worktree (use dispose_worktree), and for a remote one in tmux: the user does that from the rail.",
  schema: z.object({ ...sessionArgs, grantedBy: grantArg }),
  tier: "consequential",
  describe({ session, project }, port) {
    return `Kill "${findSession(port, session, project).title}" (remove it from the rail)`;
  },
  trust: onSessionGranted,
  async run({ session, project }, { port }) {
    const s = findSession(port, session, project);
    await port.killSession(s.id);
    return { session: s.title, killed: true };
  },
});

/** What removing a worktree would lose, in a sentence's words; null for nothing. */
export function lossOf(l: WorktreeLoss): string | null {
  const parts: string[] = [];
  if (l.unmerged)
    parts.push(`${l.unmerged} commit${l.unmerged === 1 ? "" : "s"} on ${l.branch} not in ${l.base} (${l.commits.join("; ")}${l.unmerged > l.commits.length ? "; …" : ""})`);
  if (l.dirty.length)
    parts.push(`${l.dirty.length} uncommitted or untracked file${l.dirty.length === 1 ? "" : "s"} (${cut(l.dirty.join(", "), 400)})`);
  return parts.length ? parts.join(", and ") : null;
}

const disposeSchema = z.object({
  ...sessionArgs,
  force: z
    .boolean()
    .optional()
    .describe("Remove it even with unmerged commits or uncommitted files. Only with `grantedBy`."),
  grantedBy: grantArg,
});

export const disposeWorktree = defineTool<typeof disposeSchema, WorktreeLoss>({
  name: "dispose_worktree",
  description:
    "Clean up after a session that works in its own git worktree: end it, remove the worktree folder and delete its branch, and take it off the rail (kill_session refuses such sessions). It runs at once only when git confirms nothing would be lost: every commit of the branch is in the project's main branch and the worktree has no uncommitted or untracked files. Otherwise it is refused with exactly what would be lost; tell the user, and suggest merging (or committing) first. Only when the user has explicitly said to remove it anyway (\"remove it even though it isn't merged\", \"throw that work away\") pass `force: true` with their words quoted in `grantedBy`; the call then names the commits and files it will destroy. Never force on your own judgment.",
  schema: disposeSchema,
  tier: "consequential",
  // Nothing to lose: it runs like any reversible clean-up. Anything else asks.
  tierFor: (_input, _port, loss) => (loss && !lossOf(loss) ? "reversible" : "consequential"),
  async prepare({ session, project, force, grantedBy }, port) {
    const s = findSession(port, session, project);
    const loss = await port.worktreeLoss(s.id);
    const lost = lossOf(loss);
    if (lost && !force)
      throw new Error(`Not removed: ${lost}. Merge or commit it first, or remove it anyway only if the user explicitly says to (force, with their words in grantedBy).`);
    if (lost && !grantedBy?.trim())
      throw new Error(`Not removed: forcing it would destroy ${lost}, and that needs the user's own words allowing it in grantedBy.`);
    return loss;
  },
  describe({ session, project }, port, loss) {
    const s = findSession(port, session, project);
    const lost = lossOf(loss);
    return `End "${s.title}", remove its worktree and delete ${loss.branch}${lost ? `, DESTROYING ${lost}` : ` (merged into ${loss.base}, nothing uncommitted)`}`;
  },
  trust: onSessionGranted,
  timeoutMs: 60_000,
  async run({ session, project, force, grantedBy }, { port, request, prepared }) {
    const s = findSession(port, session, project);
    // Losing work needs the user's own words, checked here as well as by the gate.
    const forced = !!force && !!lossOf(prepared) && !!grantedBy && quotes(request, grantedBy);
    if (lossOf(prepared) && !forced)
      throw new Error(`Not removed: the user's latest message doesn't contain "${cut(grantedBy ?? "", 80)}", and forcing it would destroy ${lossOf(prepared)}.`);
    // git checks again: work made since the card was shown is never lost unforced.
    const done = await port.disposeWorktree(s.id, forced);
    const lost = lossOf(done);
    return {
      session: s.title,
      removed: { worktree: done.worktree, branch: done.branch, session: true },
      checkedAgainst: done.base,
      ...(lost ? { lost } : { lost: "nothing: the branch was merged and the worktree clean" }),
    };
  },
});

export const openPanel = defineTool({
  name: "open_panel",
  description:
    "Show a panel to the user: a session's console or its diff (needs `session`), or a project's git panel or notes.",
  schema: z.object({
    project: projectArg,
    kind: z.enum(["console", "diff", "git", "notes"]),
    session: sessionArg.optional(),
  }),
  tier: "reversible",
  trust: onProject,
  run({ project, kind, session }, { port }) {
    const p = findProject(port, project);
    const s = session ? findSession(port, session, p.id) : undefined;
    port.openPanel(p.id, kind, s?.id);
    return compact({ opened: kind, project: p.name, session: s?.title ?? null });
  },
});

// ── waiting ─────────────────────────────────────────────────────────────────

type Until = "done" | "needs_you" | "either";

const reached = (until: Until, phase: SessionPhase) =>
  phase === "ended" ||
  (until !== "needs_you" && phase === "done") ||
  (until !== "done" && phase === "needs_you");

/** Live watches, one per thread and session: watching again replaces it. */
const watches = new Map<string, () => void>();

/** The threads with a live watch (housekeeping leaves them, step L4). Keys are
 *  `${threadId}:${sessionId}`; session ids have no colon. */
export function watchedThreads(): Set<string> {
  return new Set([...watches.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))));
}

/** Stop every watch (tests). */
export function clearWatches(): void {
  for (const stop of [...watches.values()]) stop();
}

/** Before answering "already done": a prompt sent in the same batch of calls may
 *  not have reached the session yet (Duck's calls run side by side). */
export const ALREADY_GRACE_MS = 1_500;
/** How often a watch looks again, for an end its events didn't tell. */
const WATCH_LOOK_MS = 5_000;

/** Where the session is for a watch: at rest only when it isn't compacting and no
 *  prompt of Duck's is on its way in (its phase doesn't show those yet). A `/compact`
 *  from a finished turn leaves the phase at done throughout. */
const settledAs = (port: WorkbenchPort, s: SessionRef): SessionPhase | null =>
  s.compacting || port.promptPending(s.id) ? null : s.phase;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForSession = defineTool({
  name: "wait_for_session",
  description:
    "Watch a session and get told when it finishes its turn (done), starts waiting on the user (needs_you), or either. A compaction isn't the end: a session that is compacting, or that a prompt of yours is still going into, is waited for. Returns at once; the news arrives later as a <workbench_event> message, and then you tell the user. Use it for \"tell me when it's done\". Watches don't survive an app restart.",
  schema: z.object({
    ...sessionArgs,
    until: z.enum(["done", "needs_you", "either"]).default("either"),
    timeoutMin: z
      .number()
      .int()
      .min(1)
      .max(480)
      .default(60)
      .describe("Give up after this many minutes, with a message saying so."),
  }),
  tier: "reversible",
  trust: onSession,
  async run({ session, project, until, timeoutMin }, ctx: ToolContext) {
    const { port, threadId } = ctx;
    let s = findSession(port, session, project);
    const current = () => port.listSessions().find((x) => x.id === s.id);
    const there = (x: SessionRef | undefined) => {
      const phase = x ? settledAs(port, x) : null;
      return phase !== null && phase !== "working" && reached(until, phase);
    };
    // A session that has just started reports no phase yet ("offline"): wait
    // anyway, the timeout covers one that never runs.
    if (there(s)) {
      // A finished turn may be about to take a prompt sent alongside this call.
      if (s.phase === "done" || s.phase === "idle") await sleep(ALREADY_GRACE_MS);
      s = current() ?? s;
      if (there(s)) return { session: s.title, already: s.phase };
    }

    const key = `${threadId}:${s.id}`;
    watches.get(key)?.();
    const name = `"${s.title}" (${projectName(port, s)}, id ${s.id})`;
    const tell = (phase: SessionPhase) => {
      stop();
      const now = current();
      const why = phase === "needs_you" && now?.choice ? `: ${choiceLine(now.choice)}` : "";
      ctx.later(`Session ${name} is now ${phase}${why}. The user asked to be told.`);
    };
    const off = port.onPhase((id, phase) => {
      if (id !== s.id || !reached(until, phase)) return;
      // Done while it still compacts, or before Duck's prompt went in: not yet.
      const now = current();
      if (phase !== "ended" && now && settledAs(port, now) === null) return;
      tell(phase);
    });
    // A compaction from rest ends with no phase change.
    const offCompaction = port.onCompactionEnd((id) => {
      const now = current();
      if (id === s.id && now && there(now)) tell(now.phase);
    });
    // And for anything both missed (a prompt that wasn't taken, say).
    const look = setInterval(() => {
      const now = current();
      if (now && there(now)) tell(now.phase);
    }, WATCH_LOOK_MS);
    const timer = setTimeout(() => {
      stop();
      const now = current();
      ctx.later(
        `Session ${name} is still ${now?.compacting ? "compacting" : (now?.phase ?? "unknown")} after ${timeoutMin} minutes; stopped watching it.`,
      );
    }, timeoutMin * 60_000);
    function stop() {
      off();
      offCompaction();
      clearInterval(look);
      clearTimeout(timer);
      if (watches.get(key) === stop) watches.delete(key);
    }
    watches.set(key, stop);
    return { session: s.title, watching: until, forMinutes: timeoutMin };
  },
});

// ── notes ───────────────────────────────────────────────────────────────────

const noteName = z.string().trim().min(1).max(120).describe("The note's name.");

async function chip(ctx: ToolContext, text: string, edit: NoteEdit): Promise<void> {
  await ctx.notice({ kind: "note", text, note: edit });
}

export const createNote = defineTool({
  name: "create_note",
  description:
    "Make a new note in a project (markdown). A name already taken gets \" 2\", \" 3\", …; the result says the name used.",
  schema: z.object({
    project: projectArg,
    name: noteName,
    content: z.string().max(100_000),
  }),
  tier: "reversible",
  trust: onProject,
  async run({ project, name, content }, ctx) {
    const p = findProject(ctx.port, project);
    const n = await ctx.port.createNote(p.id, name, content);
    await chip(ctx, `Duck made note ${n.id}`, {
      projectId: p.id,
      project: p.name,
      name: n.id,
      before: null,
      after: content,
      revision: n.revision,
    });
    return { project: p.name, name: n.id, revision: n.revision };
  },
});

export const appendNote = defineTool({
  name: "append_note",
  description:
    "Add text to the end of a note, after a blank line. It reads the note's current text itself, so nothing written since is lost.",
  schema: z.object({
    project: projectArg,
    name: noteName,
    text: z.string().trim().min(1).max(50_000),
  }),
  tier: "reversible",
  trust: onProject,
  async run({ project, name, text }, ctx) {
    const p = findProject(ctx.port, project);
    // One retry: a save landing between the read and the write moves the revision.
    for (let attempt = 0; ; attempt++) {
      const n = await ctx.port.readNote(p.id, name);
      const sep = !n.content ? "" : n.content.endsWith("\n\n") ? "" : n.content.endsWith("\n") ? "\n" : "\n\n";
      const after = `${n.content}${sep}${text}\n`;
      try {
        const revision = await ctx.port.writeNote(p.id, n.id, after, n.revision);
        await chip(ctx, `Duck added to ${n.id}`, {
          projectId: p.id,
          project: p.name,
          name: n.id,
          before: n.content,
          after,
          revision,
        });
        return { project: p.name, name: n.id, revision };
      } catch (e) {
        if (attempt > 0 || !isStale(e)) throw e;
      }
    }
  },
});

export const writeNote = defineTool({
  name: "write_note",
  description:
    "Replace a note's whole text. Pass the revision read_note gave: if the user saved since, the write is refused, and you read the note again and redo the edit on its current text. For adding to a note use append_note instead.",
  schema: z.object({
    project: projectArg,
    name: noteName,
    content: z.string().max(100_000),
    baseRevision: z.string().min(1).describe("The revision from read_note."),
  }),
  tier: "consequential",
  describe({ project, name, content }, port) {
    const p = findProject(port, project);
    return `Rewrite note "${name}" in ${p.name} (${content.length} characters)`;
  },
  trust: onProject,
  async run({ project, name, content, baseRevision }, ctx) {
    const p = findProject(ctx.port, project);
    const n = await ctx.port.readNote(p.id, name);
    if (n.revision !== baseRevision)
      throw new Error(
        "stale: the note changed since you read it. Read it again and redo the edit on its current text.",
      );
    if (n.content.length > NOTE_CHARS)
      throw new Error(
        `The note is longer than read_note shows (${n.content.length} characters), so rewriting it would lose text. Use append_note, or ask the user to edit it.`,
      );
    const revision = await ctx.port.writeNote(p.id, n.id, content, n.revision);
    await chip(ctx, `Duck edited ${n.id}`, {
      projectId: p.id,
      project: p.name,
      name: n.id,
      before: n.content,
      after: content,
      revision,
    });
    return { project: p.name, name: n.id, revision };
  },
});

export const deleteNote = defineTool({
  name: "delete_note",
  description:
    "Delete a note. The user is asked first, unless a trust rule allows it or their own words asked for it (`grantedBy`).",
  schema: z.object({ project: projectArg, name: noteName, grantedBy: grantArg }),
  tier: "consequential",
  describe({ project, name }, port) {
    return `Delete note "${name}" in ${findProject(port, project).name}`;
  },
  trust: (input, port) => ({ ...onProject(input, port), grant: input.grantedBy?.trim() || undefined }),
  async run({ project, name }, ctx) {
    const p = findProject(ctx.port, project);
    const n = await ctx.port.readNote(p.id, name);
    await ctx.port.deleteNote(p.id, n.id);
    await chip(ctx, `Duck deleted note ${n.id}`, {
      projectId: p.id,
      project: p.name,
      name: n.id,
      before: n.content,
      after: null,
      revision: null,
    });
    return { project: p.name, deleted: n.id };
  },
});

export const ACT_TOOLS = [
  sendPrompt,
  createSession,
  startSession,
  resumeSession,
  answerChoice,
  interruptSession,
  stopSession,
  killSession,
  disposeWorktree,
  openPanel,
  waitForSession,
  createNote,
  appendNote,
  writeNote,
  deleteNote,
];
