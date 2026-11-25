// The daily log window's arithmetic (improvement plan J2): moving by day, the
// calendar's month, the day's entries grouped by project (the busiest first), and
// the day as plain text for the clipboard. No DOM, no Tauri.

import { asDay, dayBounds, dayOf, hhmm, type DayEntries, type Entry } from "../assistant/daylog";

export { dayOf, hhmm };

/** The day `n` days after `day` (before, when negative). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  // Noon: no daylight-saving edge moves it to another date.
  return dayOf(new Date(y, m - 1, d + n, 12).getTime());
}

/** "Tuesday, 24 November" (and the year when it isn't `now`'s). */
export function dayTitle(day: string, now = Date.now()): string {
  const start = new Date(dayBounds(day).start);
  const sameYear = start.getFullYear() === new Date(now).getFullYear();
  return start.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export interface Cell {
  day: string;
  /** The day of the month. */
  n: number;
  inMonth: boolean;
  marked: boolean;
  future: boolean;
  today: boolean;
}

/** Month `month` (1–12) of `year` as weeks, Monday first, with the days around it
 *  to fill them. */
export function monthGrid(year: number, month: number, marked: ReadonlySet<string>, today: string): Cell[][] {
  const first = new Date(year, month - 1, 1, 12);
  const lead = (first.getDay() + 6) % 7;
  const weeks: Cell[][] = [];
  let cur = new Date(year, month - 1, 1 - lead, 12);
  do {
    const week: Cell[] = [];
    for (let i = 0; i < 7; i++) {
      const day = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      week.push({ day, n: cur.getDate(), inMonth: cur.getMonth() === month - 1, marked: marked.has(day), future: day > today, today: day === today });
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 12);
    }
    weeks.push(week);
  } while (cur.getMonth() === month - 1);
  return weeks;
}

export interface ProjectGroup {
  project: string;
  name: string;
  entries: Entry[];
}

/** A day's entries by project, the busiest first, each in time order. Hidden
 *  entries are left out unless `hidden`. */
export function byProject(entries: readonly Entry[], hidden = false): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const e of entries) {
    if (e.hidden && !hidden) continue;
    const g = groups.get(e.project) ?? { project: e.project, name: e.projectName, entries: [] };
    g.entries.push(e);
    groups.set(e.project, g);
  }
  for (const g of groups.values()) g.entries.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  return [...groups.values()].sort(
    (a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

const STATUS_WORDS: Record<Entry["status"], string> = { done: "", reverted: "reverted", in_progress: "in progress" };

export function statusWord(e: Entry): string {
  return STATUS_WORDS[e.status];
}

/** The day (or one project of it) as plain text, ready to paste into a chat. */
export function copyText(day: string, groups: readonly ProjectGroup[], now = Date.now()): string {
  const lines = [dayTitle(day, now)];
  for (const g of groups) {
    lines.push("", g.name);
    for (const e of g.entries) {
      const mark = statusWord(e);
      // A reverted title already says so ("…; reverted later that day").
      const said = mark && !e.title.toLowerCase().includes(mark) ? ` (${mark})` : "";
      lines.push(`- ${e.title}${said}`);
      if (e.detail) lines.push(`  ${e.detail}`);
    }
  }
  if (!groups.length) lines.push("", "Nothing logged.");
  return lines.join("\n");
}

/** What's stored for a day, read safely (null: no file). */
export function readDay(day: string, raw: unknown | null): DayEntries {
  return asDay(day, raw);
}
