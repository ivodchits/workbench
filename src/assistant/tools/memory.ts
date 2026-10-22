// Duck's core memory tools (step W4): `remember_core` adds a fact to a section of
// `memory/core.md`, `forget` takes one out. Both are reversible: they run at once,
// and each leaves a "Duck remembered" chip in the thread with the diff and an undo.
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
import { defineTool, type ToolContext } from "./registry";

const host = (ctx: ToolContext): CoreHost => {
  if (!ctx.core) throw new Error("Core memory isn't available here.");
  return ctx.core;
};

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
      await core.write(r.text, text);
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

export const forget = defineTool({
  name: "forget",
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

export const MEMORY_TOOLS = [rememberCore, forget];
