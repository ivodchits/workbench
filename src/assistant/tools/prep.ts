// Prep ahead of the day (the morning routine, phase 4): a meeting's prep notes or a
// deadline's checklist, written by a worker task (kind `writing`, never `browser`)
// from a fixed brief. The briefing offers it for today's meetings and near
// deadlines (`prepCandidates`); `prep_ahead` starts it only on the user's yes.
//
// Prep is a nice-to-have, so it never costs API credits: over the subscription's
// limits its task waits for room (`prep` in `tasks.ts`) instead of moving to the
// API as other tasks do. Drafts only: the worker reads and writes in its task
// folder and sends nothing.

import { z } from "zod";
import { isFinished, type Task, type TaskManager } from "../tasks";
import { compact } from "./read";
import { manager, view } from "./tasks";
import { defineTool } from "./registry";

export const PREP_KINDS = ["meeting", "deadline"] as const;
type PrepKind = (typeof PREP_KINDS)[number];

const TITLE: Record<PrepKind, string> = { meeting: "Prep", deadline: "Checklist" };

/** The task's title for a prep of `kind` for `title`. */
export const prepTitle = (kind: PrepKind, title: string) => `${TITLE[kind]}: ${title}`.slice(0, 80);

/** The fixed brief for a prep task. */
export function prepBrief(kind: PrepKind, title: string, when: string | undefined, context: string | undefined): string {
  const at = when ? ` (${when})` : "";
  const known = context?.trim() ? `\n\nWhat the user's calendar and notes say about it:\n${context.trim()}` : "";
  const ask =
    kind === "meeting"
      ? `Prepare the user for the meeting "${title}"${at}. Write a one-page brief in result.md: what the meeting is for as far as you can tell, the points to raise, the questions to ask, and open items from earlier work. Look in Duck's workspace (earlier tasks' results, notes) for anything about it.`
      : `Make a checklist for "${title}"${at}. In result.md: the steps left, in order, what each one needs, and the risks to the date. One page. Look in Duck's workspace (earlier tasks' results, notes) for anything about it.`;
  return `${ask}${known}\n\nThis is a draft for the user to review: don't contact anyone, send, publish or change anything outside this task's folder. Where something isn't known, say so rather than guess.`;
}

/** Today's prep tasks: started in the last day, with their state and headline. */
export function prepPart(tasks: TaskManager | null, now: number) {
  if (!tasks) return [];
  return tasks
    .list()
    .filter((t) => t.prep && t.state !== "closed" && now - t.created < 24 * 3600_000)
    .map((t) => compact({ id: t.id, title: t.title, state: t.state, headline: t.headline, why: isFinished(t.state) ? null : t.why }));
}

/** What could be prepped: today's timed meetings still ahead (starting after
 *  `after`, "HH:MM") and the overdue, dated or critical items, minus the invoice and
 *  those with prep already. At most three of each. */
export function prepCandidates(
  day: {
    schedule?: { time?: string; title?: string; type?: string }[];
    overdue?: { title?: string; due?: string | null }[];
    open?: { title?: string; due?: string | null; critical?: boolean }[];
  },
  invoiceTitle: string | undefined,
  prepped: Task[],
  after = "00:00",
) {
  const have = new Set(prepped.filter((t) => t.prep && t.state !== "closed").map((t) => t.title));
  const meetings = (day.schedule ?? [])
    .filter((s) => s.title && s.type === "event" && s.time && s.time !== "all day" && s.time.slice(0, 5) > after && !have.has(prepTitle("meeting", s.title)))
    .slice(0, 3)
    .map((s) => ({ for: "meeting", title: s.title!, when: s.time! }));
  const deadlines = [...(day.overdue ?? []), ...(day.open ?? []).filter((o) => o.due || o.critical)]
    .filter((o) => o.title && o.title !== invoiceTitle && !have.has(prepTitle("deadline", o.title)))
    .slice(0, 3)
    .map((o) => compact({ for: "deadline", title: o.title, when: o.due }));
  return [...meetings, ...deadlines];
}

export const prepAhead = defineTool({
  name: "prep_ahead",
  description:
    'Prep for the user\'s day, from the morning briefing\'s prepCandidates, when the user says yes to it: prep notes for a meeting, or a checklist for a deadline. Starts a writing worker (a Claude Code session on the subscription) with a fixed brief; it reports back when done. Put what you know about it (attendees, the entry\'s notes) in `context`. Over the subscription\'s limits it waits for room rather than use API credits. Drafts only: nothing is sent.',
  schema: z.object({
    for: z.enum(PREP_KINDS),
    title: z.string().trim().min(1).max(70).describe("The meeting's or the item's title, as in the briefing."),
    when: z.string().max(40).optional().describe('When it is, as in the briefing ("10:00–11:00", "2026-10-23 17:00").'),
    context: z.string().max(4000).optional().describe("What the calendar entry and notes say about it."),
  }),
  tier: "reversible",
  timeoutMs: 30_000,
  describe: (input) => `Start a writing worker: ${prepTitle(input.for, input.title)}`,
  trust: (input) => ({ projectId: null, texts: [input.title, input.context ?? ""] }),
  async run(input, ctx) {
    const tasks = manager(ctx);
    const title = prepTitle(input.for, input.title);
    const dup = tasks.list().find((t) => t.prep && t.title === title && t.state !== "closed" && !isFinished(t.state));
    if (dup) return { ...view(dup), next: "already being prepared; you'll get a <workbench_event> when it's done" };
    const t = await tasks.run({
      threadId: ctx.threadId,
      title,
      brief: prepBrief(input.for, input.title, input.when, input.context),
      kind: "writing",
      tier: "standard",
      prep: true,
      mandate: ctx.request ? { text: ctx.request, threadId: ctx.threadId } : undefined,
    });
    await ctx.notice({ kind: "task", text: `Task: ${t.title}`, task: { id: t.id } });
    return {
      ...view(t),
      next:
        t.state === "queued"
          ? t.why
            ? `waiting: ${t.why}; it starts by itself`
            : "waiting for a free worker; it starts by itself"
          : t.state === "running"
            ? "started; you'll get a <workbench_event> when it's done"
            : `it didn't start: ${t.error ?? t.state}`,
    };
  },
});

export const PREP_TOOLS = [prepAhead];
