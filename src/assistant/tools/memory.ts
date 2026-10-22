// Duck's memory tools. Core memory (step W4): `remember_core` adds a fact to a
// section of `memory/core.md`, `forget_core` takes one out. Long-term memory (step
// L1): `remember` adds an entry to a topic file, `recall` searches the entries and
// the project notes, `forget` previews the entries it matches on a card and then
// removes them. The writes leave a "Duck remembered" chip in the thread with the
// diff and an undo, and each is a commit in the workspace's repo.
//
// An edit is made on the file as it is now and written over that text; if you
// saved the file in between, it's read again and the edit redone on yours.

import { z } from "zod";
import {
  addFact,
  cleanFact,
  CORE_MAX_CHARS,
  CORE_SECTIONS,
  FACT_MAX_CHARS,
  removeFact,
  type CoreHost,
} from "../core";
import { MEMORY_TOPICS, today, type MemoryHost } from "../memory";
import type { MemoryEntry, MemoryFileEdit } from "../../ipc/memory";
import { defineTool, type ToolContext } from "./registry";

const host = (ctx: ToolContext): CoreHost => {
  if (!ctx.core) throw new Error("Core memory isn't available here.");
  return ctx.core;
};

/** The commit message for a core memory edit: the fact added or removed. */
function message(after: string, before: string | null): string {
  const was = new Set((before ?? "").split(/\r?\n/));
  const now = new Set(after.split(/\r?\n/));
  const added = [...now].find((l) => /^\s*[-*]\s/.test(l) && !was.has(l));
  const removed = [...was].find((l) => /^\s*[-*]\s/.test(l) && !now.has(l));
  const fact = (l: string) => l.replace(/^\s*[-*]\s+/, "").slice(0, 72);
  if (added) return `memory: core: ${fact(added)}`;
  if (removed) return `memory: core: forgot ${fact(removed)}`;
  return "memory: core memory edited";
}

/** Read, edit and write, redoing the edit once over a save made in between.
 *  `edit` returns the new text, or null for no change (with its reason). */
async function edit(
  ctx: ToolContext,
  change: (text: string | null) => { text: string | null; reason?: string },
): Promise<{ path: string; before: string | null; after: string | null; reason?: string }> {
  const core = host(ctx);
  for (let tries = 0; ; tries++) {
    const { path, text } = await core.read();
    const r = change(text);
    if (r.text === null || r.text === text) return { path, before: text, after: null, reason: r.reason };
    try {
      await core.write(r.text, text, message(r.text, text));
      return { path, before: text, after: r.text };
    } catch (e) {
      if (tries > 0 || !String(e).includes("stale:")) throw e;
    }
  }
}

export const rememberCore = defineTool({
  name: "remember_core",
  description:
    "Add a fact about the user to your core memory, which every new thread starts with. Use it when the user asks you to remember something lasting: who they are, a preference, a standing instruction, a name or nickname (\"the game\" means project Hollow). One short fact per call, in the third person or as a plain rule. Not for things that only matter in this thread.",
  schema: z.object({
    section: z.enum(CORE_SECTIONS).describe("Which part of the profile the fact belongs in."),
    fact: z.string().trim().min(1).max(FACT_MAX_CHARS).describe("The fact, one line."),
  }),
  tier: "reversible",
  async run({ section, fact }, ctx) {
    const f = cleanFact(fact);
    const r = await edit(ctx, (text) => {
      const next = addFact(text, section, f);
      if (next === text) return { text: null, reason: "already remembered" };
      if (next.length > CORE_MAX_CHARS)
        return { text: null, reason: `core memory is full (${CORE_MAX_CHARS} characters): ask the user what to forget, or to trim memory/core.md` };
      return { text: next };
    });
    if (r.after === null) return { remembered: false, why: r.reason, path: r.path };
    await ctx.notice({
      kind: "memory",
      text: `Duck remembered: ${f}`,
      memory: { path: r.path, before: r.before, after: r.after },
    });
    return { remembered: true, section, fact: f, path: r.path };
  },
});

export const forgetCore = defineTool({
  name: "forget_core",
  description:
    "Take a fact out of your core memory, when the user says to forget it or it's no longer true. Give the fact's text, or a distinctive part of it; when several facts contain it, nothing is removed and the result lists them, so you can name the one meant.",
  schema: z.object({
    fact: z.string().trim().min(1).max(FACT_MAX_CHARS).describe("The fact, or a distinctive part of it."),
  }),
  tier: "reversible",
  async run({ fact }, ctx) {
    let removed: string[] = [];
    let matches: string[] = [];
    const r = await edit(ctx, (text) => {
      if (!text) return { text: null, reason: "core memory is empty" };
      const x = removeFact(text, fact);
      ({ removed, matches } = x);
      if (!removed.length)
        return { text: null, reason: matches.length ? "several facts match: name the one meant" : "no fact matches" };
      return { text: x.text };
    });
    if (r.after === null) return { forgotten: [], why: r.reason, ...(matches.length > 1 && { matches }) };
    await ctx.notice({
      kind: "memory",
      text: `Duck forgot: ${removed.join("; ")}`,
      memory: { path: r.path, before: r.before, after: r.after },
    });
    return { forgotten: removed };
  },
});

// ── long-term memory (step L1) ──

const memory = (ctx: Pick<ToolContext, "memory">): MemoryHost => {
  if (!ctx.memory) throw new Error("Long-term memory isn't available here.");
  return ctx.memory;
};

/** The chip for an edit of a long-term memory file. */
const memoryNotice = (text: string, e: MemoryFileEdit) => ({
  kind: "memory" as const,
  text,
  memory: { path: e.path, file: e.file, before: e.before, after: e.after ?? "" },
});

export const remember = defineTool({
  name: "remember",
  description:
    "Save something to your long-term memory, which later threads are shown when it comes up again: a decision and why, a preference, a fact about a project or a person, a goal or a commitment, and (topic lessons) a mistake the user corrected with the right behavior. One short entry per call, written to make sense on its own months later. Give tags: other words to find it by, in both English and Russian, since recall matches words. For who the user is, standing instructions and nicknames, which every thread should start with, use remember_core. Never a password, key or token (it is refused).",
  schema: z.object({
    topic: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(`One of ${MEMORY_TOPICS.join(", ")}, or projects/<name> for a project.`),
    fact: z.string().trim().min(1).max(400).describe("The entry, one sentence or two."),
    why: z.string().trim().max(300).optional().describe("The reason, for a decision."),
    conf: z.enum(["high", "med", "low"]).optional().describe("How sure: high when the user said it outright."),
    tags: z.string().trim().max(200).optional().describe("Other words to find it by, English and Russian."),
  }),
  tier: "reversible",
  async run({ topic, fact, why, conf, tags }, ctx) {
    const m = memory(ctx);
    if (ctx.memoryOff) return { remembered: false, why: "the user asked you not to remember this conversation" };
    const r = await m.write(topic, { date: today(), fact, why, conf, tags, src: `thread:${ctx.threadId}` });
    if (!r.edit) return { remembered: false, why: "already remembered", entry: r.entry.raw };
    await ctx.notice(memoryNotice(`Duck remembered: ${r.entry.text}`, r.edit));
    return { remembered: true, topic: r.entry.topic, entry: r.entry.raw };
  },
});

export const recall = defineTool({
  name: "recall",
  description:
    "Search your long-term memory and the user's project notes, for a deliberate lookup (\"what did we decide about sync?\", \"what did I write about the auth refactor\"). Matches words, so search with the distinctive ones, and again in the other language (English or Russian) when nothing comes up. Note hits are labelled note: <project> / <name>.",
  schema: z.object({
    query: z.string().trim().min(1).max(300).describe("The words to look for."),
  }),
  tier: "read",
  async run({ query }, ctx) {
    const hits = await memory(ctx).search(query, 8);
    if (!hits.length) return { hits: [], note: "nothing matches: try other words, or the other language" };
    return {
      hits: hits.map((h) => ({
        from: h.label,
        text: h.text,
        ...(h.entry?.date && { date: h.entry.date }),
        ...(h.entry?.conf && { conf: h.entry.conf }),
        ...(h.entry?.src && { src: h.entry.src }),
        path: h.path,
        matched: `${h.matched}/${h.terms} words`,
      })),
    };
  },
});

/** The entries a forget will remove, worked out before its card. */
interface ForgetPlan {
  entries: MemoryEntry[];
}

const forgetSchema = z.object({
  query: z.string().trim().min(1).max(300).describe("Words every entry to forget holds."),
});

export const forget = defineTool<typeof forgetSchema, ForgetPlan>({
  name: "forget",
  description:
    "Remove entries from your long-term memory, when the user asks you to forget something (\"forget what I said about X\"). Matches the entries holding every word of the query; the user sees them on a card and confirms before they go. For a core memory fact, use forget_core.",
  schema: forgetSchema,
  tier: "consequential",
  async prepare({ query }, _port, env) {
    const entries = await memory(env ?? {}).matching(query);
    if (!entries.length) throw new Error(`nothing in long-term memory matches "${query}"`);
    return { entries };
  },
  describe: ({ query }, _port, p) => {
    const shown = p.entries
      .slice(0, 5)
      .map((e) => `"${e.text}"`)
      .join("; ");
    const more = p.entries.length > 5 ? ` and ${p.entries.length - 5} more` : "";
    return `Forget ${p.entries.length === 1 ? "this entry" : `${p.entries.length} entries`} matching "${query}": ${shown}${more}`;
  },
  async run({ query }, ctx) {
    const edits = await memory(ctx).forget(
      ctx.prepared.entries.map((e) => ({ file: e.file, raw: e.raw })),
      `memory: forgot ${query.slice(0, 72)}`,
    );
    if (!edits.length) return { forgotten: [], why: "they were already gone" };
    for (const e of edits) await ctx.notice(memoryNotice(`Duck forgot from ${e.file}: ${query}`, e));
    return { forgotten: ctx.prepared.entries.map((e) => e.text) };
  },
});

export const MEMORY_TOOLS = [rememberCore, forgetCore, remember, recall, forget];
