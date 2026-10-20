// Duck's own threads (2026-10-20): when one message asks for several unrelated
// pieces of work ("continue on demiurge, and in a separate thread continue on
// workbench"), each piece gets a thread of its own, so each conversation stays
// small and on its topic.
//
// The new thread's first message is the user's own words, cut from their latest
// message here (the engine checks they're really there), so whatever the user
// allowed in those words holds there too, and nothing Duck writes passes as theirs.
// `reversible`: a thread is only a conversation; it can be deleted.

import { z } from "zod";

import { defineTool } from "./registry";

export const startThread = defineTool({
  name: "start_thread",
  description: [
    "Start a new Duck thread for one part of what the user asked, and hand it that part: the new thread takes it as the user's message and works on it on its own, in parallel with this one.",
    "Use it when the user asks for something in a separate thread (\"in another thread…\", \"in a third thread…\"), or a message asks for unrelated pieces of work on different projects and the user wants them kept apart. Keep in this thread what they asked to do here.",
    "`words`: the user's own words for that part, copied exactly from their latest message (a sentence or clause; not paraphrased, not translated). Choose words that say the whole job. Call it once per new thread, then tell the user in a sentence what went where.",
  ].join(" "),
  schema: z.object({
    words: z.string().trim().min(6).max(4_000),
  }),
  tier: "reversible",
  async run({ words }, ctx) {
    const id = await ctx.startThread(words);
    return { thread: id, started: true, next: "it works on its own; its replies show up in that thread (unread until the user opens it)" };
  },
});

export const THREAD_TOOLS = [startThread];
