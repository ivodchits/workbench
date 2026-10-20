// Duck's summary tools (step W3), over `ctx.summaries`: one session's activity since
// its last summary, and "since I was away" across every session that did something
// since a moment. Each summary is one Haiku call (`summarize.ts`); one with nothing
// new costs nothing.

import { z } from "zod";
import type { SessionRef } from "../port";
import type { Summarizer, SummaryResult } from "../summarize";
import { compact, findProject, findSession, projectArg, sessionArg, when } from "./read";
import { defineTool, type ToolContext } from "./registry";

/** Sessions summarized at once, and at most, by `summarize_activity`. */
const PARALLEL = 4;
const MAX_SESSIONS = 8;

const sinceArg = z
  .string()
  .describe('A local date and time, ISO 8601 ("2026-10-20T14:30"); get_time gives now.');

function sinceMs(since: string, now = Date.now()): number {
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`"${since}" isn't a date and time; use ISO 8601, like 2026-10-20T14:30.`);
  if (t > now) throw new Error(`${since} is in the future.`);
  return t;
}

/** `f` over `xs`, a few at a time; results in order. */
async function inBatches<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += PARALLEL) out.push(...(await Promise.all(xs.slice(i, i + PARALLEL).map(f))));
  return out;
}

function need(ctx: ToolContext): Summarizer {
  if (!ctx.summaries) throw new Error("Summaries aren't available here.");
  return ctx.summaries;
}

function shape(r: SummaryResult, projects: ToolContext["port"]) {
  const project = projects.listProjects().find((p) => p.id === r.session.projectId)?.name;
  return compact({
    session: r.session.title,
    id: r.session.id,
    project,
    phase: r.session.phase,
    window: r.from === null ? "its latest activity" : `since ${when(r.from)}`,
    headline: r.summary?.headline,
    done: r.summary?.done,
    open: r.summary?.open_questions,
    needsYou: r.summary?.needs_you,
    note: !r.summary
      ? "nothing to summarize: no activity in the window"
      : r.fresh
        ? r.truncated
          ? "the window's oldest part was too long and was left out"
          : null
        : "no activity since this summary was made",
  });
}

export const summarizeSession = defineTool({
  name: "summarize_session",
  description:
    "A short summary of what a session did: a headline, what it got done, what's still open, and what it needs from the user. By default it covers what happened since the last summary of that session (or its recent activity if there was none), with nothing new costing nothing; `since` covers from that moment instead. Use it for \"what did X do\" or \"catch me up on X\"; use read_session when the user wants the actual messages.",
  schema: z.object({
    session: sessionArg,
    project: projectArg.optional(),
    since: sinceArg.optional(),
  }),
  tier: "read",
  timeoutMs: 45_000,
  async run({ session, project, since }, ctx) {
    const s = findSession(ctx.port, session, project);
    const r = await need(ctx).summarize(s, {
      since: since === undefined ? undefined : sinceMs(since),
      signal: ctx.signal,
    });
    return shape(r, ctx.port);
  },
});

export const summarizeActivity = defineTool({
  name: "summarize_activity",
  description:
    "\"What happened while I was away\": a summary of every session with activity since a moment, the most recent first (at most 8). Each one has a headline, what it got done, what's open and what it needs from the user. Sessions that need the user are worth saying first.",
  schema: z.object({
    since: sinceArg,
    project: projectArg.optional(),
  }),
  tier: "read",
  timeoutMs: 90_000,
  async run({ since, project }, ctx) {
    const summaries = need(ctx);
    const from = sinceMs(since);
    const projectId = project ? findProject(ctx.port, project).id : undefined;
    // A session with no activity time (not run since the app started) is checked
    // in its transcript, which costs a file read, not a call.
    const candidates = ctx.port
      .listSessions(projectId)
      .filter((s) => s.lastActivity === null || s.lastActivity * 1000 >= from);
    const times = await inBatches(candidates, (s) =>
      s.lastActivity !== null ? Promise.resolve(s.lastActivity * 1000) : summaries.newest(s, from).catch(() => null),
    );
    const active = candidates
      .map((s, i) => ({ s, at: times[i] }))
      .filter((x): x is { s: SessionRef; at: number } => x.at !== null)
      .sort((a, b) => b.at - a.at)
      .map((x) => x.s);
    const picked = active.slice(0, MAX_SESSIONS);
    const sessions: unknown[] = [];
    const quiet: string[] = [];
    const results = await inBatches(picked, (s) =>
      summaries.summarize(s, { since: from, signal: ctx.signal }).catch((e: unknown) => ({
        session: s,
        error: e instanceof Error ? e.message : String(e),
      })),
    );
    for (const r of results) {
      if ("error" in r) sessions.push({ session: r.session.title, id: r.session.id, error: r.error });
      else if (r.summary) sessions.push(shape(r, ctx.port));
      // Activity that left no transcript lines (a resume, a status blip).
      else quiet.push(r.session.title);
    }
    return compact({
      since: when(from),
      note: active.length === 0 ? "no session was active since then" : null,
      sessions,
      quiet,
      more: active.length > picked.length ? `${active.length - picked.length} more sessions were active` : null,
    });
  },
});

export const SUMMARY_TOOLS = [summarizeSession, summarizeActivity];
