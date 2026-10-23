// Reminders (step H8): "remind me to rotate the signing key next time I work on
// Workbench", "remind me to call the bank", "remind me on Friday at 10 to send the
// invoice". The records are `reminders.json` in Duck's repo (`../reminders.ts`);
// each change leaves a chip with an undo in the thread and is a commit.

import { z } from "zod";
import { dueAt, dueText, findReminder, localStamp, newId, type ReminderRecord, type RemindersHost } from "../reminders";
import type { ProjectRef } from "../port";
import { defineTool, type ToolContext } from "./registry";

const host = (ctx: Pick<ToolContext, "reminders">): RemindersHost => {
  if (!ctx.reminders) throw new Error("Reminders aren't available here.");
  return ctx.reminders;
};

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The project `name` means (its name or id). */
function projectOf(ctx: ToolContext, name: string): ProjectRef {
  const all = ctx.port.listProjects();
  const want = name.trim().toLowerCase();
  const p = all.find((x) => x.id === name.trim()) ?? all.find((x) => x.name.toLowerCase() === want);
  if (p) return p;
  const near = all.filter((x) => x.name.toLowerCase().includes(want));
  if (near.length === 1) return near[0];
  throw new Error(`No project is called "${name}". Projects: ${all.map((x) => x.name).join(", ")}.`);
}

/** A due the model worked out, checked: a real local time, not in the past. */
function checkDue(due: string): string {
  const at = dueAt(due);
  if (Number.isNaN(at)) throw new Error(`"${due}" isn't a date (YYYY-MM-DD) or a local time (YYYY-MM-DDTHH:MM).`);
  const day = !due.includes("T");
  const today = localStamp(new Date()).slice(0, 10);
  if (day ? due < today : at < Date.now() - 60_000)
    throw new Error(`${dueText(due)} is in the past: check the date with get_time.`);
  return due;
}

const due = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
  .describe(
    "When it's due, as an absolute local time you worked out from what they said (get_time has today): 2026-10-24T10:00, or a day, 2026-10-24, when they gave no time.",
  );

/** Write one record over what it was, reading the file again once if it changed
 *  since (a hand edit, the phone), and leave the chip. */
async function change(
  ctx: ToolContext,
  ref: string | null,
  make: (now: ReminderRecord | null) => { after: ReminderRecord | null; message: string; chip: string },
): Promise<{ before: ReminderRecord | null; after: ReminderRecord | null }> {
  const r = host(ctx);
  if (r.problem()) throw new Error(`${r.problem()} Ask the user to fix the file first.`);
  for (let tries = 0; ; tries++) {
    const before = ref === null ? null : findReminder(r.list(), ref);
    const { after, message, chip } = make(before);
    const id = after?.id ?? before?.id;
    if (!id) throw new Error("nothing to change");
    try {
      await r.put(id, before, after, message);
      await ctx.notice({ kind: "reminder", text: chip, reminder: { path: r.path() ?? "", id, before, after } });
      return { before, after };
    } catch (e) {
      if (tries > 0 || !String(e).includes("stale:")) throw e;
      await r.load();
    }
  }
}

/** A record as a tool result shows it. */
function shown(r: ReminderRecord) {
  return {
    id: r.id,
    title: r.title,
    ...(r.details && { details: r.details }),
    ...(r.project && { project: r.project.name }),
    ...(r.due && { due: dueText(r.due) }),
    ...(r.state !== "open" && { state: r.state }),
    created: r.created,
  };
}

export const listReminders = defineTool({
  name: "list_reminders",
  description:
    "The user's reminders (\"what are my reminders?\", \"anything for Backend?\"): the open ones by default, grouped as timed, by project, and general, each with its id, title, details and due time.",
  schema: z.object({
    project: z.string().optional().describe("Only this project's (its name)."),
    state: z.enum(["open", "done", "dismissed", "all"]).optional().describe("Open when left out."),
  }),
  tier: "read",
  run({ project, state = "open" }, ctx) {
    const r = host(ctx);
    if (r.problem()) return { problem: `${r.problem()} The user can fix it at ${r.path()}.` };
    const pid = project ? projectOf(ctx, project).id : null;
    const list = r.list().filter((x) => (state === "all" || x.state === state) && (!pid || x.project?.id === pid));
    if (!list.length) return `No ${state === "all" ? "" : `${state} `}reminders${project ? ` for ${project}` : ""}.`;
    const timed = list.filter((x) => x.due).sort((a, b) => dueAt(a.due ?? "") - dueAt(b.due ?? ""));
    const byProject: Record<string, ReturnType<typeof shown>[]> = {};
    for (const x of list) if (!x.due && x.project) (byProject[x.project.name] ??= []).push(shown(x));
    return {
      ...(timed.length && { timed: timed.map(shown) }),
      ...(Object.keys(byProject).length && { projects: byProject }),
      ...(list.some((x) => !x.due && !x.project) && { general: list.filter((x) => !x.due && !x.project).map(shown) }),
    };
  },
});

export const addReminder = defineTool({
  name: "add_reminder",
  description:
    "Remember something the user wants to be reminded of. With a project, it comes up each time a new session starts in that project; without, each time they start talking to you; with a due time, it's also announced then. All until it's done or dismissed. Read the due time back in your reply as the result gives it.",
  schema: z.object({
    title: z.string().trim().min(1).max(60).describe("A short header, at most about 60 characters, from their words (\"Rotate the signing key\")."),
    details: z.string().trim().max(2000).optional().describe("Their full wording, when the title shortens it."),
    project: z.string().optional().describe("The project it's for (its name), when they tie it to one."),
    due: due.optional(),
  }),
  tier: "reversible",
  async run({ title, details, project, due: when }, ctx) {
    const p = project ? projectOf(ctx, project) : null;
    const d = when ? checkDue(when) : undefined;
    const record: ReminderRecord = {
      id: newId(),
      title,
      ...(details && details !== title && { details }),
      ...(p && { project: { id: p.id, name: p.name } }),
      ...(d && { due: d }),
      state: "open",
      created: localStamp(new Date()),
      createdIn: ctx.threadId,
    };
    await change(ctx, null, () => ({
      after: record,
      message: `reminders: added "${clip(title)}"${p ? ` (${p.name})` : ""}`,
      chip: `Reminder added: ${title}${p ? ` (${p.name})` : ""}${d ? `, ${dueText(d)}` : ""}`,
    }));
    return { added: record.id, title, ...(p && { project: p.name }), ...(d && { due: dueText(d) }) };
  },
});

const close = (state: "done" | "dismissed") =>
  defineTool({
    name: state === "done" ? "complete_reminder" : "dismiss_reminder",
    description:
      state === "done"
        ? "Mark a reminder done, when the user says they did it (\"that's done\"). It stops coming up."
        : "Dismiss a reminder the user no longer wants (\"forget the bank reminder\"), without it being done. It stops coming up.",
    schema: z.object({ reminder: z.string().trim().min(1).describe("Its id, or its title or words from it.") }),
    tier: "reversible" as const,
    async run({ reminder }: { reminder: string }, ctx: ToolContext) {
      const { before } = await change(ctx, reminder, (now) => {
        if (!now) throw new Error("no reminder");
        if (now.state !== "open") throw new Error(`"${now.title}" is already ${now.state}.`);
        return {
          after: { ...now, state, closed: localStamp(new Date()) },
          message: `reminders: ${state} "${clip(now.title)}"`,
          chip: `Reminder ${state}: ${now.title}`,
        };
      });
      return { [state]: before?.title };
    },
  });

export const completeReminder = close("done");
export const dismissReminder = close("dismissed");

export const editReminder = defineTool({
  name: "edit_reminder",
  description:
    "Change a reminder: its title, details, project or due time (\"move it to Monday\"). null clears the project or the due time.",
  schema: z.object({
    reminder: z.string().trim().min(1).describe("Its id, or its title or words from it."),
    title: z.string().trim().min(1).max(60).optional(),
    details: z.string().trim().max(2000).optional(),
    project: z.string().nullable().optional().describe("The project's name; null makes it general."),
    due: due.nullable().optional(),
  }),
  tier: "reversible",
  async run({ reminder, title, details, project, due: when }, ctx) {
    const p = project === null ? null : project ? projectOf(ctx, project) : undefined;
    const d = when === null ? null : when ? checkDue(when) : undefined;
    const { after } = await change(ctx, reminder, (now) => {
      if (!now) throw new Error("no reminder");
      const next: ReminderRecord = { ...now, ...(title && { title }), ...(details !== undefined && { details }) };
      if (p === null) delete next.project;
      else if (p) next.project = { id: p.id, name: p.name };
      if (d === null) delete next.due;
      else if (d) next.due = d;
      // Edited back open: a done reminder moved to a new time is wanted again.
      if (d && now.state !== "open") {
        next.state = "open";
        delete next.closed;
      }
      return { after: next, message: `reminders: edited "${clip(next.title)}"`, chip: `Reminder changed: ${next.title}` };
    });
    return after ? { edited: shown(after) } : "not changed";
  },
});

/** A project's reminders, for the result of a session Duck starts there. */
export function remindersFor(ctx: Pick<ToolContext, "reminders">, projectId: string) {
  const list = ctx.reminders?.forProject(projectId) ?? [];
  if (!list.length) return {};
  return {
    reminders: list.map((r) => r.title),
    remindersNote: "The user's reminders for this project: mention them in a sentence in your reply.",
  };
}

export const REMINDER_TOOLS = [listReminders, addReminder, completeReminder, dismissReminder, editReminder];
