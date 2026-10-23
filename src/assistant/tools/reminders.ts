// Reminders (step H8): "remind me to rotate the signing key next time I work on
// Workbench", "remind me to call the bank", "remind me on Friday at 10 to send the
// invoice". The records are `reminders.json` in Duck's repo (`../reminders.ts`);
// each change leaves a chip with an undo in the thread and is a commit.
//
// Step H4: "every weekday at 9" (`repeat`), "snooze it for an hour", and "10-minute
// timer" (`set_timer`, kept in `duck.db`, not the file). They run wherever the
// engine does (`any`).

import { z } from "zod";
import {
  comesUpAt,
  completed,
  dueAt,
  dueText,
  durationText,
  findReminder,
  localStamp,
  newId,
  parseDuration,
  repeatText,
  snoozed,
  SNOOZE_MINUTES,
  type ReminderRecord,
  type RemindersHost,
  type TimerRecord,
} from "../reminders";
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

const repeat = z
  .enum(["daily", "weekdays", "weekly", "monthly"])
  .describe("When it comes back once it's done: every day, every weekday, every week (the due's weekday), every month (the due's day). Needs a due.");

const due = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
  .describe(
    "When it's due, as an absolute local time you worked out from what they said (get_time has today): 2026-10-24T10:00, or a day, 2026-10-24, when they gave no time.",
  );

/** Write one record over what it was, reading the file again once if it changed
 *  since (a hand edit, the phone), and leave the chip. */
export async function change(
  ctx: Pick<ToolContext, "reminders" | "notice">,
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
    ...(r.repeat && { repeats: repeatText(r.repeat) }),
    ...(r.snoozedUntil && { snoozedUntil: dueText(r.snoozedUntil) }),
    ...(r.state !== "open" && { state: r.state }),
    created: r.created,
  };
}

export const listReminders = defineTool({
  name: "list_reminders",
  description:
    "The user's reminders (\"what are my reminders?\", \"anything for Backend?\"): the open ones by default, grouped as timed, by project, and general, each with its id, title, details and due time; and the running timers (\"how long's left on my timer?\").",
  schema: z.object({
    project: z.string().optional().describe("Only this project's (its name)."),
    state: z.enum(["open", "done", "dismissed", "all"]).optional().describe("Open when left out."),
  }),
  tier: "read",
  host: "any",
  run({ project, state = "open" }, ctx) {
    const r = host(ctx);
    const running = project ? [] : r.timers().map(timerShown);
    const timers = running.length ? { timers: running } : {};
    if (r.problem()) return { problem: `${r.problem()} The user can fix it at ${r.path()}.`, ...timers };
    const pid = project ? projectOf(ctx, project).id : null;
    const list = r.list().filter((x) => (state === "all" || x.state === state) && (!pid || x.project?.id === pid));
    if (!list.length) {
      const none = `No ${state === "all" ? "" : `${state} `}reminders${project ? ` for ${project}` : ""}.`;
      return running.length ? { reminders: none, ...timers } : none;
    }
    const now = Date.now();
    const at = (x: ReminderRecord) => dueAt(comesUpAt(x, now) ?? "");
    const timed = list.filter((x) => x.due || x.snoozedUntil).sort((a, b) => at(a) - at(b));
    const byProject: Record<string, ReturnType<typeof shown>[]> = {};
    for (const x of list) if (!timed.includes(x) && x.project) (byProject[x.project.name] ??= []).push(shown(x));
    const general = list.filter((x) => !timed.includes(x) && !x.project);
    return {
      ...timers,
      ...(timed.length && { timed: timed.map(shown) }),
      ...(Object.keys(byProject).length && { projects: byProject }),
      ...(general.length && { general: general.map(shown) }),
    };
  },
});

export const addReminder = defineTool({
  name: "add_reminder",
  description:
    "Remember something the user wants to be reminded of. With a project, it comes up each time a new session starts in that project; without, each time they start talking to you; with a due time, it's also announced then (on the desktop and pushed to their phone). All until it's done or dismissed. With repeat, done moves it to the next time. Read the due time back in your reply as the result gives it. For a countdown (\"10-minute timer\") use set_timer.",
  schema: z.object({
    title: z.string().trim().min(1).max(60).describe("A short header, at most about 60 characters, from their words (\"Rotate the signing key\")."),
    details: z.string().trim().max(2000).optional().describe("Their full wording, when the title shortens it."),
    project: z.string().optional().describe("The project it's for (its name), when they tie it to one."),
    due: due.optional(),
    repeat: repeat.optional(),
  }),
  tier: "reversible",
  host: "any",
  async run({ title, details, project, due: when, repeat: every }, ctx) {
    const p = project ? projectOf(ctx, project) : null;
    const d = when ? checkDue(when) : undefined;
    if (every && !d) throw new Error("A repeating reminder needs a due time: when is the first one?");
    const record: ReminderRecord = {
      id: newId(),
      title,
      ...(details && details !== title && { details }),
      ...(p && { project: { id: p.id, name: p.name } }),
      ...(d && { due: d }),
      ...(every && { repeat: every }),
      state: "open",
      created: localStamp(new Date()),
      createdIn: ctx.threadId,
    };
    await change(ctx, null, () => ({
      after: record,
      message: `reminders: added "${clip(title)}"${p ? ` (${p.name})` : ""}`,
      chip: `Reminder added: ${title}${p ? ` (${p.name})` : ""}${d ? `, ${dueText(d)}` : ""}${every ? `, ${repeatText(every)}` : ""}`,
    }));
    return {
      added: record.id,
      title,
      ...(p && { project: p.name }),
      ...(d && { due: dueText(d) }),
      ...(every && { repeats: repeatText(every) }),
    };
  },
});

const close = (state: "done" | "dismissed") =>
  defineTool({
    name: state === "done" ? "complete_reminder" : "dismiss_reminder",
    description:
      state === "done"
        ? "Mark a reminder done, when the user says they did it (\"that's done\"). It stops coming up; a repeating one moves on to its next time."
        : "Dismiss a reminder the user no longer wants (\"forget the bank reminder\"), without it being done. It stops coming up, and a repeating one stops repeating.",
    schema: z.object({ reminder: z.string().trim().min(1).describe("Its id, or its title or words from it.") }),
    tier: "reversible" as const,
    host: "any" as const,
    async run({ reminder }: { reminder: string }, ctx: ToolContext) {
      const { before, after } = await change(ctx, reminder, (now) => {
        if (!now) throw new Error("no reminder");
        if (now.state !== "open") throw new Error(`"${now.title}" is already ${now.state}.`);
        return closing(now, state, new Date());
      });
      return after?.state === "open" && after.due ? { done: before?.title, next: dueText(after.due) } : { [state]: before?.title };
    },
  });

/** `r` done or dismissed now: the record, the commit message and the chip. A
 *  repeating one done moves on to its next time. */
export function closing(r: ReminderRecord, state: "done" | "dismissed", now: Date) {
  if (state === "done" && r.repeat) {
    const after = completed(r, now);
    const next = after.due ? dueText(after.due) : "";
    return { after, message: `reminders: done "${clip(r.title)}", next ${next}`, chip: `Reminder done: ${r.title}; next ${next}` };
  }
  const after: ReminderRecord = state === "done" ? completed(r, now) : { ...r, state, closed: localStamp(now) };
  delete after.snoozedUntil;
  return { after, message: `reminders: ${state} "${clip(r.title)}"`, chip: `Reminder ${state}: ${r.title}` };
}

/** `r` put off until `until`: the record, the commit message and the chip. */
export function snoozing(r: ReminderRecord, until: string) {
  return {
    after: snoozed(r, until),
    message: `reminders: snoozed "${clip(r.title)}" to ${until.replace("T", " ")}`,
    chip: `Reminder snoozed: ${r.title}, until ${dueText(until)}`,
  };
}

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
    repeat: repeat.nullable().optional().describe("null stops it repeating."),
  }),
  tier: "reversible",
  host: "any",
  async run({ reminder, title, details, project, due: when, repeat: every }, ctx) {
    const p = project === null ? null : project ? projectOf(ctx, project) : undefined;
    const d = when === null ? null : when ? checkDue(when) : undefined;
    const { after } = await change(ctx, reminder, (now) => {
      if (!now) throw new Error("no reminder");
      const next: ReminderRecord = { ...now, ...(title && { title }), ...(details !== undefined && { details }) };
      if (p === null) delete next.project;
      else if (p) next.project = { id: p.id, name: p.name };
      if (d === null) delete next.due;
      else if (d) next.due = d;
      // A new time replaces a snooze.
      if (d !== undefined) delete next.snoozedUntil;
      if (every === null) delete next.repeat;
      else if (every) next.repeat = every;
      if (next.repeat && !next.due) throw new Error("A repeating reminder needs a due time.");
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

export const snoozeReminder = defineTool({
  name: "snooze_reminder",
  description: `Put a reminder off ("snooze it for an hour", "remind me again tomorrow morning"): it comes up, and is announced, at the new time instead. With neither for nor until, ${SNOOZE_MINUTES} minutes.`,
  schema: z.object({
    reminder: z.string().trim().min(1).describe("Its id, or its title or words from it."),
    for: z.string().optional().describe('How long: "10m", "1h30m", "2 hours".'),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional()
      .describe("Until this local time, YYYY-MM-DDTHH:MM, worked out from what they said."),
  }),
  tier: "reversible",
  host: "any",
  async run({ reminder, for: span, until }, ctx) {
    let to = until;
    if (to) checkDue(to);
    else {
      const ms = span ? parseDuration(span) : SNOOZE_MINUTES * 60_000;
      if (!(ms >= 60_000)) throw new Error(`"${span}" isn't a length of a minute or more ("10m", "1h30m").`);
      to = localStamp(new Date(Date.now() + ms));
    }
    const until_ = to;
    const { after } = await change(ctx, reminder, (now) => {
      if (!now) throw new Error("no reminder");
      if (now.state !== "open") throw new Error(`"${now.title}" is ${now.state}: edit_reminder can reopen it with a new due.`);
      return snoozing(now, until_);
    });
    return { snoozed: after?.title, until: dueText(until_) };
  },
});

/** A timer as a tool result shows it. */
function timerShown(t: TimerRecord) {
  const left = Math.max(0, t.ends - Date.now());
  return { id: t.id, ...(t.label && { label: t.label }), length: t.length, ends: localStamp(new Date(t.ends)).slice(11), left: durationText(left) };
}

/** The longest timer: anything longer is a reminder. */
const TIMER_MAX_MS = 24 * 3_600_000;

export const setTimer = defineTool({
  name: "set_timer",
  description:
    "A countdown (\"10-minute timer\", \"timer for the pasta, 8 minutes\"): it rings on the desktop, is spoken with Speak on, and is pushed to their phone. For something at a time of day, use add_reminder.",
  schema: z.object({
    duration: z.string().trim().min(1).describe('How long: "10m", "1h30m", "90s", "8 minutes".'),
    label: z.string().trim().max(60).optional().describe("What it's for, when they said (\"pasta\")."),
  }),
  tier: "reversible",
  host: "any",
  async run({ duration, label }, ctx) {
    const ms = parseDuration(duration);
    if (!(ms >= 1000) || ms > TIMER_MAX_MS)
      throw new Error(`"${duration}" isn't a length from a second to 24 hours ("10m", "1h30m", "90s"). For later than that, add_reminder.`);
    const t: TimerRecord = {
      id: `t-${Date.now().toString(36)}`,
      ...(label && { label }),
      ends: Date.now() + ms,
      length: durationText(ms),
      threadId: ctx.threadId,
    };
    await host(ctx).addTimer(t);
    return { timer: t.id, ...(label && { label }), length: t.length, ends: localStamp(new Date(t.ends)).slice(11) };
  },
});

export const cancelTimer = defineTool({
  name: "cancel_timer",
  description: "Stop a running timer (\"cancel the timer\"). Leave timer out when there's one.",
  schema: z.object({ timer: z.string().optional().describe("Its id or label, when there are several.") }),
  tier: "reversible",
  host: "any",
  async run({ timer }, ctx) {
    const r = host(ctx);
    const all = r.timers();
    const want = timer?.trim().toLowerCase();
    const hits = want ? all.filter((t) => t.id === timer?.trim() || t.label?.toLowerCase().includes(want)) : all;
    if (!hits.length) return all.length ? `No timer matches "${timer}": ${all.map((t) => t.label ?? t.id).join(", ")}.` : "No timer is running.";
    if (hits.length > 1) throw new Error(`Several timers are running: ${hits.map((t) => `${t.id} (${t.label ?? t.length})`).join(", ")}. Name one.`);
    await r.dropTimer(hits[0].id);
    return { cancelled: hits[0].label ?? hits[0].length };
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

export const REMINDER_TOOLS = [
  listReminders,
  addReminder,
  completeReminder,
  dismissReminder,
  editReminder,
  snoozeReminder,
  setTimer,
  cancelTimer,
];
