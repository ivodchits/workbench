// Duck's read-aloud tool (step V3): "read me what the backend session said", "read
// me that note", "continue reading". The tool resolves the source to text and hands
// it to the reader (`reader.ts`), which plays it a section at a time after Duck's
// reply, on the phone when the request came from one, otherwise on this PC.
//
// Modes: `verbatim` reads the text as it is (code blocks become "see the code on
// screen"), `narrate` has Haiku rewrite each section for listening as its turn
// comes (code and tool calls become what they do), `summary` reads a short spoken
// summary instead (one Haiku call).

import { z } from "zod";
import { readPlainText } from "../../transcript/plainText";
import { hashText, NARRATE_SECTION, sections, VERBATIM_SECTION, CHARS_PER_MINUTE, type Reader, type ReadPosition, type SourceRef, type Voice } from "../reader";
import { findProject, findSession, projectArg, sessionArg } from "./read";
import { defineTool, type ToolContext } from "./registry";

/** The reader as the tool reaches it. */
export interface ReaderHost {
  reader: Reader;
  /** Where `threadId`'s reads are heard: the phone that asked, else this PC.
   *  Throws when neither can speak. */
  voiceFor(threadId: string): Voice;
  /** The newest kept position, for "continue reading". */
  lastKept(): ReadPosition | null;
  /** A short spoken summary of `text` (the Haiku primitive `spoken_summary`). */
  summarize(text: string, signal: AbortSignal): Promise<string>;
}

/** The longest text read from a source (about 50 minutes). */
const MAX_TEXT = 45_000;
const DEFAULT_MINUTES = 20;

const Source = z.object({
  source: z.enum(["session", "summary", "note", "text", "continue"]),
  session: sessionArg.optional().describe('For "session" and "summary": the session, by id or title.'),
  project: projectArg.optional().describe('For "note": the note\'s project; for a session, to tell same-named sessions apart.'),
  name: z.string().optional().describe('For "note": the note\'s name, as list_notes gives it.'),
  items: z
    .number()
    .int()
    .min(2)
    .max(40)
    .optional()
    .describe('For "session": read this many recent items of its conversation (what the user typed, Claude\'s replies, its tool calls) instead of only its last reply.'),
  text: z.string().optional().describe('For "text": what to read, e.g. what a screenshot shows, written out.'),
  title: z.string().optional().describe('For "text": a few words naming it, shown on the reader bar.'),
});

interface Resolved {
  key: string;
  title: string;
  text: string;
  mode: "verbatim" | "narrate";
}

async function resolve(src: z.infer<typeof Source>, ctx: ToolContext): Promise<Resolved> {
  const { port } = ctx;
  switch (src.source) {
    case "session": {
      if (!src.session) throw new Error('source "session" needs `session`.');
      const s = findSession(port, src.session, src.project);
      if (src.items) {
        const read = await readPlainText((before) => port.readTranscriptBack(s.id, before), {
          maxItems: src.items,
          maxChars: MAX_TEXT,
        });
        if (!read.text) throw new Error(`${s.title} has no conversation yet.`);
        return { key: `session:${s.id}:recent`, title: `${s.title}, recent`, text: read.text, mode: "narrate" };
      }
      const last = await port.lastResponse(s.id);
      if (!last?.trim()) throw new Error(`${s.title} hasn't replied yet.`);
      return { key: `session:${s.id}:last`, title: `${s.title}'s last reply`, text: last, mode: "narrate" };
    }
    case "summary": {
      if (!src.session) throw new Error('source "summary" needs `session`.');
      if (!ctx.summaries) throw new Error("Summaries aren't available here.");
      const s = findSession(port, src.session, src.project);
      const r = await ctx.summaries.summarize(s, { signal: ctx.signal });
      if (!r.summary) throw new Error(`${s.title} has no activity to summarize.`);
      const { headline, done, open_questions, needs_you } = r.summary;
      const parts = [
        headline,
        done.length ? `Done: ${done.join("; ")}.` : "",
        open_questions.length ? `Still open: ${open_questions.join("; ")}.` : "",
        needs_you ? `It needs you: ${needs_you}` : "",
      ];
      return { key: `summary:${s.id}`, title: `${s.title}, summary`, text: parts.filter(Boolean).join("\n\n"), mode: "verbatim" };
    }
    case "note": {
      if (!src.project || !src.name) throw new Error('source "note" needs `project` and `name`.');
      const p = findProject(port, src.project);
      const n = await port.readNote(p.id, src.name);
      if (!n.content.trim()) throw new Error(`the note ${n.id} is empty.`);
      return { key: `note:${p.id}/${n.id}`, title: n.id, text: n.content, mode: "verbatim" };
    }
    case "text": {
      if (!src.text?.trim()) throw new Error('source "text" needs `text`.');
      return { key: `text:${hashText(src.text)}`, title: src.title?.trim() || "the text", text: src.text, mode: "verbatim" };
    }
    case "continue":
      throw new Error("continue is resolved by the tool");
  }
}

function need(ctx: ToolContext): ReaderHost {
  if (!ctx.reader) throw new Error("Reading aloud isn't available here.");
  return ctx.reader;
}

const AFTER = "It starts when your reply ends: reply in a few words at most (\"Reading it now.\"), and don't repeat or summarize what's being read.";

export const readAloud = defineTool({
  name: "read_aloud",
  description:
    "Read something aloud to the user, a section at a time, on the phone when they asked from it, otherwise on this PC: a session's last reply (or its recent conversation), a session's summary, a note, or any text (e.g. what a screenshot shows). Use it for \"read me…\", \"прочитай…\". A source read before picks up where it stopped; \"continue reading\" is source \"continue\". The user can pause, skip and stop it from the reader bar, and anything they say pauses it. Modes: verbatim (word for word; the default for notes and text), narrate (rewritten for listening: code and tool calls become what they do; the default for sessions), summary (a short spoken summary instead).",
  schema: Source.extend({
    mode: z.enum(["verbatim", "narrate", "summary"]).optional(),
    maxMinutes: z.number().min(1).max(60).optional().describe(`Stop after about this many minutes (default ${DEFAULT_MINUTES}).`),
    fromStart: z.boolean().optional().describe("Start from the beginning even if it was read halfway before."),
  }),
  tier: "read",
  timeoutMs: 60_000,
  async run(input, ctx) {
    const host = need(ctx);
    const { reader } = host;
    let src: z.infer<typeof Source> = input;
    let mode = input.mode;
    if (input.source === "continue") {
      const v = reader.view();
      if (v?.state === "reading") return { reading: v.title, note: "It's already reading." };
      if (v?.state === "paused") {
        reader.resume();
        return { resumed: v.title, section: `${v.section + 1} of ${v.sections}`, note: AFTER };
      }
      const kept = host.lastKept();
      if (!kept) throw new Error("Nothing was left half-read.");
      src = kept.source as z.infer<typeof Source>;
      mode = (kept.source.mode as typeof mode) ?? mode;
    }
    const r = await resolve(src, ctx);
    const chosen = mode ?? r.mode;
    let text = r.text.slice(0, MAX_TEXT);
    if (chosen === "summary") text = await host.summarize(text, ctx.signal);
    const narrate = chosen === "narrate";
    const job = {
      key: chosen === "summary" ? `${r.key}#summary` : r.key,
      title: r.title,
      sections: sections(text, narrate ? NARRATE_SECTION : VERBATIM_SECTION),
      narrate,
      threadId: ctx.threadId,
      maxChars: (input.maxMinutes ?? DEFAULT_MINUTES) * CHARS_PER_MINUTE,
      source: { ...src, mode: chosen } as SourceRef,
    };
    if (job.sections.length === 0) throw new Error("there's nothing in it to read.");
    const voice = host.voiceFor(ctx.threadId);
    const from = input.fromStart ? 0 : reader.resumable(job);
    reader.start(job, voice, from);
    return {
      reading: r.title,
      mode: chosen,
      where: voice.where === "phone" ? "on the phone" : "on this PC",
      sections: job.sections.length,
      from: from > 0 ? `section ${from + 1}, where it stopped last time` : "the start",
      about: `${Math.max(1, Math.round(text.length / CHARS_PER_MINUTE))} min`,
      cut: r.text.length > MAX_TEXT ? "the text was long; only its first part is read" : undefined,
      note: AFTER,
    };
  },
});

export const READ_ALOUD_TOOLS = [readAloud];
