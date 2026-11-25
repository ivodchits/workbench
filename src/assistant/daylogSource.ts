// What a machine did since the daily log last read it (improvement plan J1): run on
// each machine, asked by the main (`WorkbenchPort.daylogActivity`, over the fleet's
// link for another machine). For each of its projects: what its sessions said past
// the offsets the main holds, as dated lines, and its commits and branch resets.
//
// Only data travels, and only what's new: a session the main has an offset for is
// read on from there; one it hasn't seen is read back from its end to the floor
// (`since`). The answer says where each read stopped, which the main keeps once
// it has noted what was read. No Tauri here: the reads are passed in.

import type { SessionSummary } from "../ipc/sessions";
import type { TranscriptPage } from "../ipc/transcript";
import type { GitActivity, GitCommit, GitReset } from "../ipc/daylog";
import { createTranscript, type Item } from "../transcript/model";
import { itemText } from "../transcript/plainText";
import { normalizeRemote } from "./remotes";

export interface ActivityRequest {
  /** Session id → the byte offset it was read to. */
  offsets: Record<string, number>;
  /** Project folder (as `folderKey`) → git read to, epoch seconds. */
  git: Record<string, number>;
  /** Epoch ms: a session not seen before is read from here on, and git too. */
  since: number;
  /** Epoch ms: only sessions written to after this are looked at. */
  touched: number;
  /** Raw transcript bytes read per session, at most. */
  maxBytes?: number;
}

export interface ActivityLine {
  /** Epoch ms; undated lines take their turn's. */
  at: number;
  text: string;
}

export interface SessionChunk {
  sessionId: string;
  /** Its first prompt, for the notes' context. */
  title: string;
  /** The offset read from (the source key) and to (the next capture's start). */
  from: number;
  to: number;
  lines: ActivityLine[];
  /** More is there than was read this time. */
  more: boolean;
}

export interface GitChunk {
  commits: GitCommit[];
  resets: GitReset[];
  /** Read to, epoch seconds. */
  to: number;
}

export interface ProjectActivity {
  /** The same project on every machine: its git remote, else its name (F9.1). */
  key: string;
  name: string;
  folder: string;
  sessions: SessionChunk[];
  git: GitChunk | null;
}

export interface Activity {
  projects: ProjectActivity[];
  /** It stopped before reading everything (the answer's size): ask again. */
  more?: boolean;
}

export interface SourceDeps {
  /** This machine's own projects (not ones on an SSH host). */
  projects(): readonly { name: string; rootPath: string }[];
  sessions(rootPath: string): Promise<SessionSummary[]>;
  readForward(sessionId: string, from: number, maxBytes: number): Promise<TranscriptPage>;
  readBack(sessionId: string, before?: number): Promise<TranscriptPage>;
  git(dir: string, since: number): Promise<GitActivity>;
  /** A folder's `origin`, as written. */
  origin(rootPath: string): Promise<string | null>;
}

export const MAX_BYTES = 2 * 1024 * 1024;
/** Paging back for a session not seen before stops after this much. */
const BACK_BYTES = 8 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
/** One answer's lines, at most (it travels over the fleet's link). */
const ANSWER_CHARS = 3_000_000;

/** A folder as a key: the same folder however it's written. */
export function folderKey(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** A project's key across machines (F9.1's matching: the remote, else the name). */
export function projectKey(name: string, remote: string | null): string {
  return remote ? `git:${remote}` : `name:${name.trim().toLowerCase()}`;
}

function itemAt(i: Item): number | null {
  if (!i.timestamp) return null;
  const t = Date.parse(i.timestamp);
  return Number.isNaN(t) ? null : t;
}

/** The shown lines of `raw` (whole JSONL lines), dated, after `since`. */
export function linesOf(raw: readonly string[], since: number): ActivityLine[] {
  const t = createTranscript();
  t.append(raw);
  const out: ActivityLine[] = [];
  let last: number | null = null;
  for (const item of t.items) {
    const at: number | null = itemAt(item) ?? last;
    last = at;
    if (at === null || at <= since) continue;
    const text = itemText(item);
    if (text) out.push({ at, text: text.replace(/^\[\d\d:\d\d\] /, "") });
  }
  return out;
}

async function readOn(deps: SourceDeps, s: SessionSummary, from: number, max: number): Promise<SessionChunk | null> {
  const raw: string[] = [];
  let at = from;
  let more = false;
  let read = 0;
  for (;;) {
    const page = await deps.readForward(s.sessionId, at, Math.min(PAGE_BYTES, max));
    if (!page.lines.length || page.nextOffset <= at) break;
    raw.push(...page.lines);
    read += page.nextOffset - at;
    at = page.nextOffset;
    if (at >= page.end) break;
    if (read >= max) {
      more = true;
      break;
    }
  }
  if (at === from) return null;
  return { sessionId: s.sessionId, title: s.firstPrompt.slice(0, 160), from, to: at, lines: linesOf(raw, -Infinity), more };
}

/** A session not seen before: back from its end to the first line before `since`. */
async function readNew(deps: SourceDeps, s: SessionSummary, since: number): Promise<SessionChunk | null> {
  const pages: TranscriptPage[] = [];
  let before: number | undefined;
  let read = 0;
  for (;;) {
    const page = await deps.readBack(s.sessionId, before);
    if (!page.lines.length) break;
    pages.unshift(page);
    read += page.nextOffset - page.offset;
    const first = linesOf(page.lines.slice(0, 20), -Infinity)[0];
    if (page.offset === 0 || read >= BACK_BYTES || (first && first.at <= since)) break;
    before = page.offset;
  }
  if (!pages.length) return null;
  const to = pages[pages.length - 1].nextOffset;
  const from = pages[0].offset;
  return {
    sessionId: s.sessionId,
    title: s.firstPrompt.slice(0, 160),
    from,
    to,
    lines: linesOf(pages.flatMap((p) => p.lines), since),
    more: false,
  };
}

/** What's new on this machine since the offsets in `req`. */
export async function readActivity(deps: SourceDeps, req: ActivityRequest): Promise<Activity> {
  const max = req.maxBytes ?? MAX_BYTES;
  const projects: ProjectActivity[] = [];
  let size = 0;
  let more = false;
  for (const p of deps.projects()) {
    if (size > ANSWER_CHARS) {
      more = true;
      break;
    }
    const folder = folderKey(p.rootPath);
    const listed = await deps.sessions(p.rootPath).catch(() => [] as SessionSummary[]);
    const sessions: SessionChunk[] = [];
    for (const s of listed.filter((x) => x.modifiedAt * 1000 > req.touched).sort((a, b) => a.modifiedAt - b.modifiedAt)) {
      const off = req.offsets[s.sessionId];
      if (size > ANSWER_CHARS) {
        more = true;
        break;
      }
      const chunk = await (off !== undefined ? readOn(deps, s, off, max) : readNew(deps, s, req.since)).catch(() => null);
      if (chunk) {
        sessions.push(chunk);
        size += chunk.lines.reduce((n, l) => n + l.text.length + 16, 0);
      }
    }
    const gitFrom = req.git[folder] ?? Math.floor(req.since / 1000);
    const g = await deps.git(p.rootPath, gitFrom).catch(() => null);
    const latest = g ? Math.max(gitFrom, ...g.commits.map((c) => c.at), ...g.resets.map((r) => r.at)) : gitFrom;
    const git = g && (g.commits.length || g.resets.length) ? { commits: g.commits, resets: g.resets, to: latest } : null;
    if (!sessions.length && !git) continue;
    const remote = normalizeRemote((await deps.origin(p.rootPath).catch(() => null)) ?? "");
    projects.push({ key: projectKey(p.name, remote), name: p.name, folder, sessions, git });
  }
  return more ? { projects, more } : { projects };
}
