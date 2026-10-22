// Memory consolidation (step L2): once a day Duck reads what happened since its
// last tidy (your threads, the worker tasks that finished, the entries it
// remembered) beside what its long-term memory already holds, in one Haiku call
// (`PRIMITIVES.consolidate`, `x-wb-purpose: consolidate`) with structured output:
// new entries, merges (old → new), contradictions, stale entries to retire, a
// journal paragraph, and requests you keep repeating that could be skills.
//
// Merges and retirements are applied at once and logged (in the commit's message
// and the run's record); the whole run is one commit (`memory.rs`'s `apply`). A
// contradiction becomes one question, asked the next time you talk: the recall
// note carries it (`memory.ts`'s `questionLine`). Skill ideas wait in duck.db for
// S2 to offer. Step L3: the call also reads the tool calls that kept failing, and
// may name a change to Duck that would fix a pattern (the same correction twice,
// the same error again and again); one is suggested a week at most, through the
// recall note (`suggestion`), and nothing starts unless you say yes.
//
// When: the first hour you're away after midnight (`tick`, every few minutes), or
// sooner when a run is overdue; or on demand ("tidy your memory", the Memory
// view). A thread you asked Duck not to remember is left out.

import { z } from "zod";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { MemoryApplied, MemoryEntry, MemoryPlan, MemoryStateKey } from "../ipc/memory";
import { MEMORY_TOPICS, memoryOff, today, type TidyReport } from "./memory";
import { USER_SOURCES } from "./protocol";
import type { Task } from "./tasks";

const EntryOut = {
  topic: z.string(),
  fact: z.string(),
  why: z.string().nullable(),
  conf: z.enum(["high", "med", "low"]),
  tags: z.string().nullable(),
};

export const Consolidation = z.object({
  new_entries: z.array(z.object(EntryOut)),
  merges: z.array(z.object({ ids: z.array(z.string()), ...EntryOut })),
  retire: z.array(z.object({ id: z.string(), why: z.string() })),
  contradictions: z.array(z.object({ ids: z.array(z.string()), question: z.string() })),
  journal: z.string(),
  skill_ideas: z.array(z.object({ request: z.string(), steps: z.array(z.string()), times: z.number() })),
  improvements: z.array(z.object({ request: z.string(), why: z.string() })),
});
export type Consolidation = z.infer<typeof Consolidation>;

/** The Haiku call; the app's is `oneShot("consolidate", …)`. */
export type ConsolidateCall = (input: string, signal?: AbortSignal) => Promise<Consolidation>;

/** A contradiction waiting to be asked. */
export interface PendingQuestion {
  question: string;
  /** The entries it is about, as their bullets. */
  entries: string[];
  at: number;
  asked: boolean;
}

/** A repeated request that could be a skill (for S2). */
export interface SkillOffer {
  request: string;
  steps: string[];
  times: number;
  at: number;
  /** When it was offered (step S2); absent or null: not yet. */
  offered?: number | null;
}

/** A change to Duck the tidy found a pattern for (step L3). */
export interface ImproveOffer {
  request: string;
  why: string;
  at: number;
  /** When it was suggested to you; null until then. */
  offered: number | null;
}

/** The last run, as stored. */
export interface RunRecord {
  /** The local date it ran on: a nightly run waits for the next one. */
  date: string;
  /** The end of the window it read (epoch ms): where the next one starts. */
  at: number;
  report: TidyReport;
}

export interface ConsolidateDeps {
  threads(): readonly ThreadRow[];
  messages(threadId: string): Promise<readonly StoredMessage[]>;
  tasks?: () => readonly Task[];
  list(): Promise<MemoryEntry[]>;
  apply(plan: MemoryPlan, message: string): Promise<MemoryApplied>;
  state: { get(key: MemoryStateKey): Promise<string | null>; set(key: MemoryStateKey, value: string | null): Promise<void> };
  call: ConsolidateCall;
  /** How long you've been away; a failure counts as here. */
  idleMs?: () => Promise<number>;
  now?: () => number;
}

export interface Consolidator {
  /** Tidy now. Two at once share one run. */
  run(): Promise<TidyReport>;
  /** The nightly check: runs when it's due and you're away; null when it didn't. */
  tick(): Promise<TidyReport | null>;
  /** The next contradiction to ask about, marked asked. */
  question(): Promise<string | null>;
  /** A change to Duck to suggest, marked offered: one a week at most. */
  suggestion(): Promise<string | null>;
  /** A request repeated about three times or more, to offer as a skill (step
   *  S2), marked offered: one a week at most. */
  skillOffer(): Promise<string | null>;
  last(): Promise<RunRecord | null>;
}

/** Away this long after midnight, the day's tidy runs. */
export const IDLE_MS = 60 * 60_000;
/** A run more than this overdue needs only `OVERDUE_IDLE_MS` away. */
const OVERDUE_MS = 36 * 3_600_000;
const OVERDUE_IDLE_MS = 10 * 60_000;
/** The first run reads this far back. */
const FIRST_WINDOW_MS = 24 * 3_600_000;
/** What the call reads, at most: about 20k tokens (~$0.02 in on Haiku). */
const ACTIVITY_CHARS = 60_000;
const MESSAGE_CHARS = 1_200;
const ENTRIES_MAX = 400;
const QUESTIONS_KEPT_MS = 30 * 86_400_000;
/** A nightly run that failed isn't tried again for this long. */
const RETRY_MS = 60 * 60_000;
const SKILL_OFFERS_MAX = 30;
const IMPROVE_OFFERS_MAX = 20;
/** At most one change to Duck is suggested this often. */
export const SUGGEST_EVERY_MS = 7 * 86_400_000;
/** A suggestion not taken up in this long is dropped. */
const SUGGESTION_KEPT_MS = 30 * 86_400_000;
/** How many tool errors the call reads. */
const TOOL_ERRORS_MAX = 15;

/** Text placed between the tags can't open or close one of them. */
const fence = (s: string) => s.replace(/<\/?\s*(?:memory|activity|thread|tasks|tool_errors)\b/gi, (m) => m.replace("<", "‹"));

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[cut]` : s);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${today(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Results that aren't the tool failing: the user said no, or stopped the turn. */
const NOT_FAILURES = /^The user (?:declined|stopped)/;

/** The tool calls that failed more than once in the window (step L3), by tool:
 *  how often, and the first error. */
export function toolErrors(threads: readonly { messages: readonly StoredMessage[] }[], from: number): string[] {
  const names = new Map<string, string>();
  const errors = new Map<string, { n: number; first: string }>();
  for (const t of threads)
    for (const m of t.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
        if (b.type === "tool_use" && b.id && b.name) names.set(b.id, b.name);
        if (b.type !== "tool_result" || !b.is_error || m.ts <= from) continue;
        const text = textOf(b.content).trim();
        if (NOT_FAILURES.test(text)) continue;
        const name = names.get(b.tool_use_id ?? "") ?? "a tool";
        const e = errors.get(name);
        if (e) e.n++;
        else errors.set(name, { n: 1, first: text });
      }
    }
  return [...errors]
    .filter(([, e]) => e.n >= 2)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, TOOL_ERRORS_MAX)
    .map(([name, e]) => `- ${name}, ${e.n} times: ${clip(e.first.replace(/\s+/g, " "), 200)}`);
}

/** An entry as the call reads it. */
function entryLine(id: string, e: MemoryEntry, fresh: boolean): string {
  const meta = [e.topic, e.date, e.conf && `conf ${e.conf}`, fresh && "new"].filter(Boolean).join(" · ");
  return `[${id}] ${meta}: ${e.text}${e.tags ? ` (tags: ${e.tags})` : ""}`;
}

/** The call's input, and what the ids in it stand for. */
export function consolidationInput(r: {
  date: string;
  from: number;
  entries: readonly MemoryEntry[];
  threads: readonly { title: string; messages: readonly StoredMessage[] }[];
  tasks: readonly Task[];
}): { text: string; ids: Map<string, MemoryEntry>; items: number; newest: number | null } {
  const fromDate = today(new Date(r.from));
  const ids = new Map<string, MemoryEntry>();
  const kept = [...r.entries]
    .filter((e) => !e.topic.startsWith("journal/"))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, ENTRIES_MAX);
  const lines = kept.map((e, i) => {
    const id = `e${i + 1}`;
    ids.set(id, e);
    return entryLine(id, e, (e.date ?? "") >= fromDate);
  });
  let budget = ACTIVITY_CHARS;
  let items = 0;
  let newest: number | null = null;
  const seen = (ts: number) => (newest = Math.max(newest ?? ts, ts));
  const threads: string[] = [];
  for (const t of r.threads) {
    const said: string[] = [];
    for (const m of t.messages) {
      if (m.ts <= r.from) continue;
      const who = m.role === "user" && USER_SOURCES.has(m.source) ? "user" : m.role === "assistant" ? "duck" : null;
      const text = who && textOf(m.content).trim();
      if (!who || !text) continue;
      said.push(`${who} (${clock(m.ts)}): ${clip(text, MESSAGE_CHARS)}`);
    }
    if (!said.length) continue;
    const body = said.join("\n");
    if (body.length > budget) break;
    budget -= body.length;
    items += said.length;
    t.messages.forEach((m) => m.ts > r.from && seen(m.ts));
    threads.push(`<thread title="${fence(t.title).replace(/"/g, "'")}">\n${fence(body)}\n</thread>`);
  }
  const tasks = r.tasks.map((t) => `- ${t.state} · ${t.title}${t.headline ? `: ${clip(t.headline, 400)}` : ""}`);
  const failed = toolErrors(r.threads, r.from);
  items += tasks.length;
  r.tasks.forEach((t) => t.finished !== null && seen(t.finished));
  const text = [
    `Today is ${r.date}. The activity since ${clock(r.from)}.`,
    "",
    "Your long-term memory now (entries marked new were remembered in this window):",
    `<memory>\n${fence(lines.join("\n")) || "(empty)"}\n</memory>`,
    "",
    "Your conversations with the user:",
    `<activity>\n${threads.join("\n") || "(none)"}\n</activity>`,
    "",
    "Worker tasks that finished:",
    `<tasks>\n${fence(tasks.join("\n")) || "(none)"}\n</tasks>`,
    "",
    "Your tool calls that failed more than once:",
    `<tool_errors>\n${fence(failed.join("\n")) || "(none)"}\n</tool_errors>`,
  ].join("\n");
  return { text, ids, items, newest };
}

const isTopic = (t: string) => (MEMORY_TOPICS as readonly string[]).includes(t) || /^projects\/\S/.test(t);

/** The plan from the call's answer: what to apply, the questions, the log. Ids the
 *  answer made up, or used twice, are dropped; a contradiction's entries are kept
 *  out of merges and retirements, since you're about to be asked. The journal is
 *  dated by the day it's about (`day`: a run at 01:30 writes up the evening
 *  before), the entries by the day they're remembered. */
export function planFrom(
  c: Consolidation,
  ids: ReadonlyMap<string, MemoryEntry>,
  date: string,
  day = date,
): {
  plan: MemoryPlan;
  questions: Omit<PendingQuestion, "at" | "asked">[];
  log: string[];
  added: number;
  merged: number;
  retired: number;
} {
  const used = new Set<string>();
  const take = (xs: readonly string[]) => [...new Set(xs)].filter((x) => ids.has(x) && !used.has(x));
  const plan: MemoryPlan = { remove: [], add: [], journal: null };
  const log: string[] = [];
  const questions: Omit<PendingQuestion, "at" | "asked">[] = [];
  for (const q of c.contradictions) {
    const xs = take(q.ids);
    if (!xs.length || !q.question.trim()) continue;
    xs.forEach((x) => used.add(x));
    questions.push({ question: q.question.trim(), entries: xs.map((x) => ids.get(x)!.raw) });
    log.push(`to ask: ${q.question.trim()}`);
  }
  let merged = 0;
  for (const m of c.merges) {
    const xs = take(m.ids);
    if (xs.length < 2 || !m.fact.trim() || !isTopic(m.topic)) continue;
    xs.forEach((x) => used.add(x));
    const olds = xs.map((x) => ids.get(x)!);
    const newest = [...olds].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
    plan.remove.push(...olds.map((e) => ({ file: e.file, raw: e.raw })));
    plan.add.push({
      topic: m.topic,
      entry: {
        date: newest.date ?? date,
        fact: m.fact.trim(),
        why: m.why?.trim() || undefined,
        src: newest.src ?? `tidy:${date}`,
        conf: m.conf,
        tags: m.tags?.trim() || undefined,
      },
    });
    merged += olds.length;
    log.push(`merged: ${olds.map((e) => e.text).join(" | ")} → ${m.fact.trim()}`);
  }
  let retired = 0;
  for (const r of c.retire) {
    const [x] = take([r.id]);
    if (!x) continue;
    used.add(x);
    const e = ids.get(x)!;
    plan.remove.push({ file: e.file, raw: e.raw });
    retired++;
    log.push(`retired: ${e.text}${r.why.trim() ? ` (${r.why.trim()})` : ""}`);
  }
  let added = 0;
  for (const n of c.new_entries) {
    if (!n.fact.trim() || !isTopic(n.topic)) continue;
    added++;
    plan.add.push({
      topic: n.topic,
      entry: {
        date,
        fact: n.fact.trim(),
        why: n.why?.trim() || undefined,
        src: `tidy:${date}`,
        conf: n.conf,
        tags: n.tags?.trim() || undefined,
      },
    });
    log.push(`new (${n.topic}): ${n.fact.trim()}`);
  }
  if (c.journal.trim()) plan.journal = { date: day, text: c.journal.trim() };
  return { plan, questions, log, added, merged, retired };
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function createConsolidator(deps: ConsolidateDeps): Consolidator {
  const now = deps.now ?? Date.now;
  let running: Promise<TidyReport> | null = null;
  let retryAfter = 0;

  const last = async () => parse<RunRecord | null>(await deps.state.get("consolidation"), null);

  async function once(): Promise<TidyReport> {
    const prev = await last();
    const end = now();
    const from = prev?.at ?? end - FIRST_WINDOW_MS;
    const date = today(new Date(end));
    const threads: { title: string; messages: readonly StoredMessage[] }[] = [];
    // Newest first, so a window too long for one call keeps the latest.
    for (const t of [...deps.threads()].filter((x) => x.updated > from).sort((a, b) => b.updated - a.updated)) {
      const messages = await deps.messages(t.id);
      if (!memoryOff(messages)) threads.push({ title: t.title, messages });
    }
    const tasks = (deps.tasks?.() ?? []).filter((t) => t.finished !== null && t.finished > from);
    const entries = await deps.list();
    const input = consolidationInput({ date, from, entries, threads, tasks });
    const empty: TidyReport = { ran: false, added: 0, merged: 0, retired: 0, questions: 0, skills: 0, journal: null, log: [], skipped: [] };
    if (!input.items) {
      await deps.state.set("consolidation", JSON.stringify({ date, at: end, report: empty } satisfies RunRecord));
      return empty;
    }
    const answer = await deps.call(input.text);
    const day = input.newest === null ? date : today(new Date(input.newest));
    const { plan, questions, log, added, merged, retired } = planFrom(answer, input.ids, date, day);
    const counts = `${added} new, ${merged} merged, ${retired} retired`;
    const message = [`memory: tidied ${date} (${counts})`, "", ...log.map((l) => `- ${l}`)].join("\n");
    const applied = await deps.apply(plan, message);
    // The questions wait for the next time you talk.
    if (questions.length) {
      const kept = parse<PendingQuestion[]>(await deps.state.get("questions"), []).filter(
        (q) => !q.asked || end - q.at < QUESTIONS_KEPT_MS,
      );
      kept.push(...questions.map((q) => ({ ...q, at: end, asked: false })));
      await deps.state.set("questions", JSON.stringify(kept));
    }
    const ideas = answer.skill_ideas.filter((s) => s.request.trim() && s.times >= 2);
    if (ideas.length) {
      const offers = parse<SkillOffer[]>(await deps.state.get("skill_offers"), []);
      const key = (s: string) => s.trim().toLowerCase();
      for (const s of ideas) {
        const had = offers.find((o) => key(o.request) === key(s.request));
        if (had) Object.assign(had, { steps: s.steps, times: Math.max(had.times, s.times), at: end });
        else offers.push({ request: s.request.trim(), steps: s.steps, times: s.times, at: end });
        log.push(`skill idea: ${s.request.trim()} (${s.times} times)`);
      }
      await deps.state.set("skill_offers", JSON.stringify(offers.slice(-SKILL_OFFERS_MAX)));
    }
    const better = answer.improvements.filter((x) => x.request.trim());
    if (better.length) {
      const key = (s: string) => s.trim().toLowerCase();
      const offers = parse<ImproveOffer[]>(await deps.state.get("improve_offers"), []).filter(
        (o) => o.offered !== null || end - o.at < SUGGESTION_KEPT_MS,
      );
      for (const x of better) {
        const had = offers.find((o) => key(o.request) === key(x.request));
        if (had) Object.assign(had, { why: x.why.trim(), at: end });
        else offers.push({ request: x.request.trim(), why: x.why.trim(), at: end, offered: null });
        log.push(`to suggest: ${x.request.trim()}`);
      }
      await deps.state.set("improve_offers", JSON.stringify(offers.slice(-IMPROVE_OFFERS_MAX)));
    }
    const report: TidyReport = {
      ran: true,
      added,
      merged,
      retired,
      questions: questions.length,
      skills: ideas.length,
      journal: plan.journal?.text ?? null,
      log,
      skipped: applied.skipped,
    };
    await deps.state.set("consolidation", JSON.stringify({ date, at: end, report } satisfies RunRecord));
    return report;
  }

  function run() {
    running ??= once().finally(() => (running = null));
    return running;
  }

  return {
    run,
    last,
    async tick() {
      if (running || now() < retryAfter) return null;
      const prev = await last();
      const n = now();
      if (prev && prev.date === today(new Date(n))) return null;
      const idle = await (deps.idleMs?.() ?? Promise.resolve(0)).catch(() => 0);
      const overdue = !prev || n - prev.at > OVERDUE_MS;
      if (idle < (overdue ? OVERDUE_IDLE_MS : IDLE_MS)) return null;
      try {
        return await run();
      } catch (e) {
        retryAfter = now() + RETRY_MS;
        throw e;
      }
    },
    async question() {
      const qs = parse<PendingQuestion[]>(await deps.state.get("questions"), []);
      const q = qs.find((x) => !x.asked);
      if (!q) return null;
      q.asked = true;
      await deps.state.set("questions", JSON.stringify(qs));
      return q.question;
    },
    async suggestion() {
      const offers = parse<ImproveOffer[]>(await deps.state.get("improve_offers"), []);
      const n = now();
      if (offers.some((o) => o.offered !== null && n - o.offered < SUGGEST_EVERY_MS)) return null;
      const o = offers.find((x) => x.offered === null && n - x.at < SUGGESTION_KEPT_MS);
      if (!o) return null;
      o.offered = n;
      await deps.state.set("improve_offers", JSON.stringify(offers));
      return o.why ? `${o.request} (${o.why.replace(/\.$/, "")})` : o.request;
    },
    async skillOffer() {
      const offers = parse<SkillOffer[]>(await deps.state.get("skill_offers"), []);
      const n = now();
      if (offers.some((o) => o.offered && n - o.offered < SUGGEST_EVERY_MS)) return null;
      const o = offers.find((x) => !x.offered && x.times >= 3 && n - x.at < SUGGESTION_KEPT_MS);
      if (!o) return null;
      o.offered = n;
      await deps.state.set("skill_offers", JSON.stringify(offers));
      const steps = o.steps.length ? `; the steps: ${o.steps.join("; ")}` : "";
      return `${o.request} (asked about ${o.times} times${steps})`;
    },
  };
}
