// Duck's own threads (2026-10-20): when one message asks for several unrelated
// pieces of work ("continue on demiurge, and in a separate thread continue on
// workbench"), each piece gets a thread of its own, so each conversation stays
// small and on its topic.
//
// The new thread's first message is the user's own words, cut from their latest
// message here (the engine checks they're really there), so whatever the user
// allowed in those words holds there too, and nothing Duck writes passes as theirs.
// `reversible`: a thread is only a conversation; it can be deleted.
//
// Moving the conversation (step A7): "let's go to the thread with the auth research
// and tell me where it stands". `list_threads` finds it, `go_to_thread` moves the
// surface the user asked from (the drawer, or the phone) into it once this reply is
// over, and their words, quoted the same way, go there as their message, so the
// answer comes from there. `start_thread` with `go` makes a new thread and moves in;
// its brief of where things stand goes in as a system note, never as the user's.
//
// Cleaning up (2026-10-21): `delete_thread` deletes threads for good, so it's
// consequential: a card names each one, unless the user's own words asked for it.
//
// Compaction (step A6): `compact_thread` summarizes this thread's older turns once
// this reply is over, as the engine does by itself past the threshold. Reversible:
// the messages stay, only what the model is sent changes.
//
// Modes (step S1): `switch_mode` is `start_thread` with `go` into a thread of
// another mode ("let's rubber-duck the sync bug" opens a duck thread, and the
// words go there, so it answers with a question). A mode is a thread's for life,
// so switching always means a new thread, seeded with a brief.

import { z } from "zod";

import type { ThreadRow } from "../../ipc/assistant";
import { findMode, MODE_IDS, MODES, modeOf } from "../modes";
import { grantArg } from "./act";
import { defineTool } from "./registry";

/** Moving between threads (step A7), as the engine offers it to a tool. */
export interface ThreadMoves {
  /** Every thread, most recent first. */
  list(): readonly ThreadRow[];
  /** The first line of a thread's latest reply, when its messages are loaded. */
  lastReply(threadId: string): string | null;
  /** The threads the user was in before this one, on the surface they asked from,
   *  newest first. */
  trail(): string[];
  /** Move the surface the user asked from into `threadId` once this reply is over.
   *  `words` (theirs, quoted from their latest message here; it throws otherwise)
   *  go there as their message. */
  go(threadId: string, words?: string): void;
  /** Delete a thread with its messages (refused while a turn runs there). */
  remove(threadId: string): Promise<void>;
  /** Compact this thread once this reply is over (step A6). */
  compact(): void;
}

/** How many threads `list_threads` shows. */
export const LIST_MAX = 30;

const ago = (ms: number, now: number): string => {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** A thread named by id or title (a title must fit one thread; "back" is the last
 *  one the user was in). Throws with the candidates when it doesn't. */
export function findThread(moves: ThreadMoves, here: string, name: string): ThreadRow {
  const threads = moves.list();
  const q = name.trim().toLowerCase();
  if (q === "back" || q === "previous") {
    const id = moves.trail().find((t) => t !== here && threads.some((x) => x.id === t));
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error("there is no thread to go back to: the user hasn't moved here from another one");
    return t;
  }
  const byId = threads.find((t) => t.id === name.trim());
  if (byId) return byId;
  const exact = threads.filter((t) => t.title.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : threads.filter((t) => t.title.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  const names = (ts: readonly ThreadRow[]) =>
    ts
      .slice(0, 8)
      .map((t) => `"${t.title || "untitled"}" (${t.id})`)
      .join(", ");
  if (partial.length === 0)
    throw new Error(`no thread is called "${name}". Use list_threads to find it; the threads: ${names(threads)}`);
  throw new Error(`several threads fit "${name}": ${names(partial)}. Ask the user which one.`);
}

export const startThread = defineTool({
  name: "start_thread",
  description: [
    "Start a new Duck thread for one part of what the user asked, and hand it that part: the new thread takes it as the user's message and works on it.",
    "Use it when the user asks for something in a separate thread (\"in another thread…\", \"in a third thread…\"), or a message asks for unrelated pieces of work on different projects and the user wants them kept apart. Keep in this thread what they asked to do here.",
    "`words`: the user's own words for that part, copied exactly from their latest message (a sentence or clause; not paraphrased, not translated). Choose words that say the whole job. Call it once per new thread, then tell the user in a sentence what went where.",
    "`go: true` when the user wants to move there and carry on talking in it (\"new thread for the release plan, let's talk there\"): the conversation moves into the new thread once this reply is over, and it answers there. Then give a `brief`: a few sentences of where things stand that the new thread needs (it starts without this thread's history). Without `go`, the new thread works on its own, in parallel, and the user stays here.",
  ].join(" "),
  schema: z.object({
    words: z.string().trim().min(6).max(4_000),
    go: z.boolean().optional(),
    brief: z.string().trim().max(4_000).optional(),
  }),
  tier: "reversible",
  async run({ words, go, brief }, ctx) {
    const id = await ctx.startThread(words, { go: go === true, brief });
    return go
      ? { thread: id, started: true, moving: true, next: "the conversation moves there once this reply is over; say so in a few words (\"Moving to the new thread.\"), and don't answer the request here" }
      : { thread: id, started: true, next: "it works on its own; its replies show up in that thread (unread until the user opens it)" };
  },
});

export const listThreads = defineTool({
  name: "list_threads",
  description: [
    "List Duck's threads (the user's conversations with you), most recent first: each one's title, when it was last active, the first line of its latest reply when known, and the worker tasks and autopilots tied to it.",
    "Use it to find the thread the user means when they ask to go to one (\"the thread with the auth research\", \"the one about the backend task\"), then go_to_thread. `here` marks this thread; `before` marks the threads the user was in before this one, 1 being the last.",
  ].join(" "),
  schema: z.object({}),
  tier: "read",
  run(_input, ctx) {
    const now = Date.now();
    const trail = ctx.threads.trail();
    const tasks = ctx.tasks?.list() ?? [];
    const autopilots = ctx.autopilot?.list() ?? [];
    const sessions = new Map(ctx.port.listSessions().map((s) => [s.id, s.title]));
    const rows = ctx.threads
      .list()
      .slice(0, LIST_MAX)
      .map((t) => {
        const own = tasks.filter((k) => k.threadId === t.id).slice(0, 5);
        const pilots = autopilots.filter((a) => a.threadId === t.id && a.state !== "stopped");
        const before = trail.indexOf(t.id);
        const last = ctx.threads.lastReply(t.id);
        return {
          id: t.id,
          title: t.title || "untitled",
          active: ago(t.updated, now),
          ...(t.id === ctx.threadId && { here: true }),
          ...(before >= 0 && t.id !== ctx.threadId && { before: before + 1 }),
          ...(last && { lastReply: last }),
          ...(own.length && {
            tasks: own.map((k) => `${k.title} (${k.state})`),
          }),
          ...(pilots.length && {
            autopilots: pilots.map((a) => `${sessions.get(a.instanceId) ?? a.instanceId} (${a.state})`),
          }),
        };
      });
    return { threads: rows, ...(ctx.threads.list().length > LIST_MAX && { more: ctx.threads.list().length - LIST_MAX }) };
  },
});

export const goToThread = defineTool({
  name: "go_to_thread",
  description: [
    "Move the conversation into another Duck thread: once this reply is over, the user's view (the drawer, or the phone they asked from) opens that thread, and what they say next goes there.",
    "Use it when the user asks to go to a thread (\"let's go to the thread with that task\", \"go back\"). `thread`: its id from list_threads, or its exact title, or \"back\" for the one they were in before. If more than one thread could be the one they mean, ask which instead of guessing.",
    "`words`: when they also ask for something there (\"…and give me the details\"), their own words for it, copied exactly from their latest message: those go there as their message, and it answers there at once. Leave it out for a plain move.",
    "Reply here in a few words (\"Moving to the Demiurge thread.\"), and don't answer the request here.",
  ].join(" "),
  schema: z.object({
    thread: z.string().trim().min(1).max(300),
    words: z.string().trim().min(6).max(4_000).optional(),
  }),
  tier: "reversible",
  run({ thread, words }, ctx) {
    const t = findThread(ctx.threads, ctx.threadId, thread);
    if (t.id === ctx.threadId) throw new Error("the user is already in that thread");
    ctx.threads.go(t.id, words);
    return {
      thread: t.id,
      title: t.title || "untitled",
      moving: true,
      next: words ? "their words go there once this reply is over, and it answers there" : "the move happens once this reply is over",
    };
  },
});

/** How many threads one `delete_thread` call deletes at most. */
export const DELETE_MAX = 30;

const titled = (title: string) => `"${title.trim() || "untitled"}"`;

export const deleteThread = defineTool({
  name: "delete_thread",
  description: [
    "Delete Duck threads for good, with all their messages: to clean up threads the user is done with (\"delete the release thread\", \"clear out threads older than a week\").",
    "Find them with list_threads first and pass each one's id and its title exactly as listed; the user confirms on a card naming them, unless their own words asked for this deletion (quote them in grantedBy).",
    "Refused for this thread, for one Duck is still replying in, and for one a running worker task or autopilot reports to. Say which were deleted and which weren't, and why.",
  ].join(" "),
  schema: z.object({
    threads: z
      .array(z.object({ id: z.string().trim().min(1).max(200), title: z.string().max(300) }))
      .min(1)
      .max(DELETE_MAX),
    grantedBy: grantArg,
  }),
  tier: "consequential",
  describe({ threads }) {
    return threads.length === 1
      ? `Delete the Duck thread ${titled(threads[0].title)} and its messages, for good`
      : `Delete ${threads.length} Duck threads and their messages, for good: ${threads.map((t) => titled(t.title)).join(", ")}`;
  },
  trust: ({ grantedBy }) => ({ projectId: null, grant: grantedBy?.trim() || undefined }),
  timeoutMs: 30_000,
  async run({ threads }, ctx) {
    const known = new Map(ctx.threads.list().map((t) => [t.id, t]));
    const busyTasks = new Set(
      (ctx.tasks?.list() ?? []).filter((k) => k.state === "queued" || k.state === "running").map((k) => k.threadId),
    );
    const piloted = new Set((ctx.autopilot?.list() ?? []).filter((a) => a.state !== "stopped").map((a) => a.threadId));
    const deleted: string[] = [];
    const kept: { title: string; why: string }[] = [];
    for (const { id, title } of threads) {
      const t = known.get(id);
      const why = !t
        ? "no such thread (list_threads again)"
        : // The card named it by this title: a different one isn't what was allowed.
          t.title.trim().toLowerCase() !== title.trim().toLowerCase() && !(t.title === "" && /^untitled$/i.test(title.trim()))
          ? `its title is "${t.title}", not "${title}"`
          : id === ctx.threadId
            ? "it's this thread"
            : busyTasks.has(id)
              ? "a worker task still running reports to it"
              : piloted.has(id)
                ? "an autopilot reports to it"
                : null;
      if (why) {
        kept.push({ title: title || id, why });
        continue;
      }
      try {
        await ctx.threads.remove(id);
        deleted.push(t!.title || "untitled");
      } catch (e) {
        kept.push({ title: t!.title || id, why: e instanceof Error ? e.message : String(e) });
      }
    }
    return { deleted, ...(kept.length && { notDeleted: kept }) };
  },
});

export const compactThread = defineTool({
  name: "compact_thread",
  description: [
    "Compact this thread: once this reply is over, its older turns are replaced, in what you're sent from then on, by a summary you write of them; the last few turns stay as they are. The user still sees every message.",
    "Use it when the user asks (\"compact this thread\", \"summarize and carry on\"). Long threads are also compacted by themselves past a size set in Duck's settings, so don't offer it unasked.",
    "Reply in a few words that it will be compacted once you're done here.",
  ].join(" "),
  schema: z.object({}),
  tier: "reversible",
  run(_input, ctx) {
    ctx.threads.compact();
    return "This thread will be compacted as soon as this reply is over.";
  },
});

export const switchMode = defineTool({
  name: "switch_mode",
  description: [
    "Move the conversation into a new thread of another mode: once this reply is over, the user's view opens it, their words go there as their message, and it answers there.",
    `The modes: ${MODE_IDS.map((m) => `"${m}" (${MODES[m].about})`).join(", ")}, and the user's own modes listed in <skills>.`,
    "Use it when the user wants another kind of help than this thread gives: to think a problem through (\"let's rubber-duck the sync bug\", \"давай подумаем над…\") → duck; a general conversation (\"let's just chat\") → chat; anything that acts on the app, or needs the web, from a chat or duck thread → assistant.",
    "`words`: the user's own words for what they want there, copied exactly from their latest message (not paraphrased, not translated). `brief`: a few sentences of what the new thread needs to know (the project, the session, what was said here); it starts without this thread's history.",
    "Reply here in a few words (\"Let's think it through in a duck thread.\"), and don't answer the request here.",
  ].join(" "),
  schema: z.object({
    mode: z.string().trim().min(1).max(40),
    words: z.string().trim().min(6).max(4_000),
    brief: z.string().trim().max(4_000).optional(),
  }),
  tier: "reversible",
  async run({ mode, words, brief }, ctx) {
    const to = findMode(mode);
    if (!to) throw new Error(`no mode "${mode}": the modes are ${MODE_IDS.join(", ")}, and the ones in <skills>`);
    const here = modeOf(ctx.threads.list().find((t) => t.id === ctx.threadId)?.mode);
    if (here.id === mode) throw new Error(`this thread is already a ${here.title} thread; answer here`);
    const id = await ctx.startThread(words, { go: true, brief, mode });
    return {
      thread: id,
      mode,
      moving: true,
      next: "the conversation moves there once this reply is over; say so in a few words, and don't answer the request here",
    };
  },
});

export const THREAD_TOOLS = [startThread, listThreads, goToThread, deleteThread, compactThread, switchMode];
