// Session summaries (step W3): one Haiku call (`PRIMITIVES.summary`, `x-wb-purpose:
// summary`) over the transcript text since the session's last summary, with that
// summary as background. The result is structured: a headline, what was done, what's
// still open, and what the session needs from you.
//
// Each session's last summary is kept in duck.db `meta` with the time of the newest
// item it covered (`at`), so the next one reads only what came after. Asking again
// with nothing new costs nothing: the stored summary comes back. A summary of a
// window that starts later than `at` ("since I was away" after a gap) isn't stored,
// since it doesn't continue the chain.

import { z } from "zod";
import { summaryGet, summarySet } from "../ipc/assistant";
import { readPlainText } from "../transcript/plainText";
import type { SessionRef, WorkbenchPort } from "./port";

export const Summary = z.object({
  headline: z.string(),
  done: z.array(z.string()),
  open_questions: z.array(z.string()),
  needs_you: z.string().nullable(),
});
export type Summary = z.infer<typeof Summary>;

/** A session's last summary, as stored. */
export interface StoredSummary {
  summary: Summary;
  /** The window's start (epoch ms); null when it read from the transcript's start
   *  (as far as the reader went). */
  from: number | null;
  /** The newest item it covered (epoch ms): where the next summary starts. */
  at: number;
  /** When it was made (epoch ms). */
  made: number;
}

export interface SummaryBackend {
  get(instanceId: string): Promise<string | null>;
  set(instanceId: string, json: string): Promise<void>;
}

export const ipcSummaryBackend: SummaryBackend = { get: summaryGet, set: summarySet };

/** The Haiku call; the app's is `oneShot("summary", …)`. */
export type SummaryCall = (input: string, signal?: AbortSignal) => Promise<Summary>;

export interface SummaryResult {
  session: SessionRef;
  /** Null when there's nothing to summarize (no transcript, or nothing since). */
  summary: Summary | null;
  /** The window's start, epoch ms; null from the transcript's start. */
  from: number | null;
  /** The newest item covered, epoch ms. */
  to: number | null;
  /** A call was made; false when the stored summary came back (nothing new). */
  fresh: boolean;
  /** The window's oldest part didn't fit and was left out. */
  truncated: boolean;
}

export interface SummarizeOptions {
  since?: number;
  /** The turn's final reply, from the Stop hook: the hook fires before the reply
   *  reaches the transcript file, so a done alert's summary would miss it. */
  reply?: string;
  signal?: AbortSignal;
}

/** A final reply is cut to this in the activity, as transcript items are. */
const REPLY_CHARS = 1200;

/** The activity with the turn's final reply as its last line, unless it's there. */
export function withReply(activity: string, reply: string | undefined): string {
  const r = reply?.trim();
  if (!r) return activity;
  const head = r.slice(0, 200);
  // The reply is the newest item, so it would be in the activity's last stretch.
  if (activity.slice(-(REPLY_CHARS + 400)).includes(head)) return activity;
  const line = `claude: ${r.length > REPLY_CHARS ? `${r.slice(0, REPLY_CHARS)} …[cut]` : r}`;
  return activity ? `${activity}\n${line}` : line;
}

export interface Summarizer {
  /** Summarize a session's activity since its last summary, or since `since`
   *  (epoch ms) when given. */
  summarize(session: SessionRef, opts?: SummarizeOptions): Promise<SummaryResult>;
  /** The stored summary, without a call. */
  last(instanceId: string): Promise<StoredSummary | null>;
  /** The newest transcript item after `since` (epoch ms), read without a call; null
   *  when there is none. For sessions with no activity time of their own. */
  newest(session: SessionRef, since: number): Promise<number | null>;
}

/** The transcript text a summary reads, at most. About 12k tokens: ~$0.0015 in. */
const MAX_CHARS = 40_000;
const MAX_ITEMS = 400;

/** Text placed between the tags can't open or close one of them. */
const fence = (s: string) => s.replace(/<\/?\s*(?:activity|earlier)\b/gi, (m) => m.replace("<", "‹"));

function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function state(s: SessionRef): string {
  if (s.phase === "needs_you" && s.choice) {
    const q = s.choice.questions[0]?.question;
    return `waiting on the user: a ${s.choice.kind} prompt for ${s.choice.toolName}${q ? ` ("${q.slice(0, 200)}")` : ""}`;
  }
  return {
    idle: "idle",
    working: "working",
    needs_you: "waiting on the user",
    done: "finished its turn",
    ended: "ended",
    offline: "not running",
  }[s.phase];
}

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");

/** The summary call's user message. */
export function summaryText(r: {
  session: SessionRef;
  project: string | null;
  activity: string;
  from: number | null;
  truncated: boolean;
  earlier: Summary | null;
}): string {
  const s = r.session;
  return [
    `Session: ${r.project ? `${r.project} · ` : ""}${s.title}`,
    ...(s.taskNote ? [`Task note: ${s.taskNote}`] : []),
    `State now: ${state(s)}`,
    ...(r.earlier
      ? [
          "",
          "Summary of its earlier activity:",
          `<earlier>\n${fence(`${r.earlier.headline}\nDone:\n${list(r.earlier.done)}\nOpen:\n${list(r.earlier.open_questions)}`)}\n</earlier>`,
        ]
      : []),
    "",
    `${r.from === null ? "Its activity" : `Its activity since ${clock(r.from)}`}${r.truncated ? " (the oldest part was cut)" : ""}:`,
    `<activity>\n${fence(r.activity)}\n</activity>`,
  ].join("\n");
}

function parseStored(json: string | null): StoredSummary | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<StoredSummary>;
    const summary = Summary.safeParse(v.summary);
    if (!summary.success || typeof v.at !== "number") return null;
    return {
      summary: summary.data,
      from: typeof v.from === "number" ? v.from : null,
      at: v.at,
      made: typeof v.made === "number" ? v.made : v.at,
    };
  } catch {
    return null;
  }
}

export function createSummarizer(deps: {
  port: WorkbenchPort;
  backend: SummaryBackend;
  call: SummaryCall;
  now?: () => number;
}): Summarizer {
  const { port, backend, call } = deps;
  const now = deps.now ?? Date.now;
  /** instance id → its stored summary, as read or written this run. */
  const cache = new Map<string, StoredSummary | null>();
  /** The same request made twice at once (a done alert and a tool) shares a call. */
  const inflight = new Map<string, Promise<SummaryResult>>();

  async function last(id: string): Promise<StoredSummary | null> {
    if (cache.has(id)) return cache.get(id) ?? null;
    const s = parseStored(await backend.get(id).catch(() => null));
    cache.set(id, s);
    return s;
  }

  async function run(s: SessionRef, { since, reply, signal }: SummarizeOptions): Promise<SummaryResult> {
    const prev = await last(s.id);
    const from = since ?? prev?.at;
    const read = await readPlainText((before) => port.readTranscriptBack(s.id, before), {
      maxItems: MAX_ITEMS,
      maxChars: MAX_CHARS,
      since: from,
    });
    const activity = withReply(read.text, reply);
    if (!activity) {
      // Nothing new: the last summary stands, when this asks for what it covers.
      if (since === undefined && prev)
        return { session: s, summary: prev.summary, from: prev.from, to: prev.at, fresh: false, truncated: false };
      return { session: s, summary: null, from: from ?? null, to: null, fresh: false, truncated: false };
    }
    // The last summary is background when it ends where this window starts, or before.
    const earlier = prev && (from === undefined || prev.at <= from) ? prev.summary : null;
    const project = port.listProjects().find((p) => p.id === s.projectId)?.name ?? null;
    const summary = await call(
      summaryText({ session: s, project, activity, from: from ?? null, truncated: read.truncated, earlier }),
      signal,
    );
    const to = read.lastAt ?? now();
    // Stored only when it continues the chain (no gap after the last one).
    if (!prev || from === undefined || from <= prev.at) {
      const rec: StoredSummary = { summary, from: from ?? null, at: Math.max(to, prev?.at ?? 0), made: now() };
      cache.set(s.id, rec);
      void backend
        .set(s.id, JSON.stringify(rec))
        .catch((e: unknown) => console.warn("duck: a summary wasn't saved", e));
    }
    return { session: s, summary, from: from ?? null, to, fresh: true, truncated: read.truncated };
  }

  return {
    last,
    async newest(s, since) {
      const read = await readPlainText((before) => port.readTranscriptBack(s.id, before), {
        maxItems: 1,
        maxChars: 2_000,
        since,
      });
      return read.items ? (read.lastAt ?? since + 1) : null;
    },
    summarize(s, opts = {}) {
      const key = `${s.id}|${opts.since ?? ""}|${opts.reply ? "reply" : ""}`;
      const going = inflight.get(key);
      if (going) return going;
      const p = run(s, opts).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
