// What the drawer shows for a thread (step A3): the stored messages folded into
// display items. An assistant message becomes its text and a chip per tool call;
// the tool results (which travel in the next user message) are attached to their
// chips; thinking and the mid-conversation system messages are not shown. A
// Workbench event (W2) is a line of its own, not a bubble of yours, and a note or
// a toolbar (W5) or the core memory (W4) Duck changed is a chip with its diff.

import type { StoredMessage } from "../../ipc/assistant";
import type { MemoryEdit, NoteEdit, Notice, PluginsEdit, ReminderEdit } from "../../assistant/protocol";
import { attachmentsOf, type AttachmentRef } from "../../assistant/attachments";
import { withoutManifest } from "../../assistant/voiceFiles";

/** A reminder chip's diff (H8): the record as JSON, before and after. */
export function reminderFiles(e: ReminderEdit): { label: string; before: string; after: string }[] {
  const json = (r: unknown) => (r ? `${JSON.stringify(r, null, 2)}
` : "");
  return [{ label: "reminders.json", before: json(e.before), after: json(e.after) }];
}

export type Item =
  /** `files`: what was sent with it (G1). */
  | { kind: "user"; key: string; text: string; source: string; files?: AttachmentRef[] }
  /** Files a worker made (G1): chips to open or drag out. */
  | { kind: "files"; key: string; text: string; files: AttachmentRef[] }
  | { kind: "event"; key: string; text: string }
  | { kind: "note"; key: string; text: string; edit: NoteEdit }
  | { kind: "plugins"; key: string; text: string; edit: PluginsEdit }
  | { kind: "memory"; key: string; text: string; edit: MemoryEdit }
  /** Duck added, closed or changed a reminder (H8): a chip with an undo. */
  | { kind: "reminder"; key: string; text: string; edit: ReminderEdit }
  /** A worker task started here (D1): its card shows the task's live state. */
  | { kind: "task"; key: string; text: string; taskId: string }
  | { kind: "reply"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      id: string;
      name: string;
      input: unknown;
      result: { text: string; isError: boolean } | null;
      /** The Firefox profile a browser call ran in (B2). */
      profile?: "agent" | "personal";
    }
  | { kind: "notice"; key: string; notice: Notice };

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  /** A text block's sources (B1: web search results it cites). */
  citations?: { type: string; url?: string; title?: string | null }[] | null;
}

/** The server tools shown as chips (B1); the tool search's own calls aren't. */
const WEB_CALLS = new Set(["web_search", "web_fetch"]);
const WEB_RESULTS = new Set(["web_search_tool_result", "web_fetch_tool_result"]);

/** A web search's or fetch's result as the chip shows it: each page's title and
 *  link, or what went wrong. */
export function webResultText(content: unknown): { text: string; isError: boolean } {
  const c = content as { type?: string; error_code?: string; url?: string; content?: { title?: string | null; source?: { data?: string } } };
  if (Array.isArray(content)) {
    const lines = (content as { title?: string; url?: string }[]).map((r) => `${r.title ?? ""} — ${r.url ?? ""}`.trim());
    return { text: lines.length ? lines.join("\n") : "no results", isError: false };
  }
  if (c?.type?.endsWith("_error")) return { text: `failed: ${c.error_code ?? "unknown error"}`, isError: true };
  if (c?.type === "web_fetch_result") {
    const size = c.content?.source?.data?.length;
    return { text: [c.content?.title, c.url, size ? `${size} characters` : ""].filter(Boolean).join("\n"), isError: false };
  }
  return { text: "", isError: false };
}

/** The profile a hosted browser call names in its result, or its error (B2). */
export function profileOf(text: string | undefined): { profile?: "agent" | "personal" } {
  const m = text && (/^<mcp_result [^>]* profile="(agent|personal)"/.exec(text) ?? /\((agent|personal) profile\)/.exec(text));
  return m ? { profile: m[1] as "agent" | "personal" } : {};
}

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => [...String(n)].map((d) => SUPERSCRIPT[Number(d)]).join("");
/** A link target markdown won't misread. */
const safeUrl = (url: string) => url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
/** Link text without brackets. */
const safeTitle = (t: string) => t.replace(/[[\]]/g, "").trim();

const blocksOf = (m: StoredMessage): Block[] =>
  typeof m.content === "string"
    ? [{ type: "text", text: m.content }]
    : Array.isArray(m.content)
      ? (m.content as Block[])
      : [];

/** A tool result's content as plain text (a string, or text blocks). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`))
    .join("\n");
}

/** A compaction's line (step A6) is stored when it's made, after the turns it
 *  kept; it's shown where it cut, after the last message it covers. */
function compactedAtCut(messages: readonly StoredMessage[]): StoredMessage[] {
  const through = (m: StoredMessage) =>
    m.role === "notice" ? (m.content as Notice | null)?.compaction?.through : undefined;
  const seqs = new Set(messages.map((m) => m.seq));
  const moved = (m: StoredMessage) => {
    const t = through(m);
    return t !== undefined && t !== m.seq && seqs.has(t) ? t : undefined;
  };
  const at = new Map<number, StoredMessage[]>();
  for (const m of messages) {
    const t = moved(m);
    if (t !== undefined) at.set(t, [...(at.get(t) ?? []), m]);
  }
  if (at.size === 0) return [...messages];
  return messages.flatMap((m) => (moved(m) !== undefined ? [] : [m, ...(at.get(m.seq) ?? [])]));
}

export function toItems(messages: readonly StoredMessage[]): Item[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages) {
    if (m.role === "assistant") {
      // A web call's result comes in the same reply (B1).
      for (const b of blocksOf(m))
        if (WEB_RESULTS.has(b.type) && b.tool_use_id) results.set(b.tool_use_id, webResultText(b.content));
      continue;
    }
    if (m.role !== "user") continue;
    for (const b of blocksOf(m))
      if (b.type === "tool_result" && b.tool_use_id)
        results.set(b.tool_use_id, {
          text: resultText(b.content),
          isError: !!b.is_error,
        });
  }

  const items: Item[] = [];
  for (const m of compactedAtCut(messages)) {
    const key = `${m.threadId}:${m.seq}`;
    if (m.role === "notice") {
      const n = m.content as Notice;
      if (n.kind === "note" && n.note)
        items.push({ kind: "note", key, text: n.text, edit: n.note });
      else if (n.kind === "plugins" && n.plugins)
        items.push({ kind: "plugins", key, text: n.text, edit: n.plugins });
      else if (n.kind === "memory" && n.memory)
        items.push({ kind: "memory", key, text: n.text, edit: n.memory });
      else if (n.kind === "reminder" && n.reminder)
        items.push({ kind: "reminder", key, text: n.text, edit: n.reminder });
      else if (n.kind === "task" && n.task)
        items.push({ kind: "task", key, text: n.text, taskId: n.task.id });
      else if (n.kind === "files" && n.files?.length)
        items.push({ kind: "files", key, text: n.text, files: n.files });
      else items.push({ kind: "notice", key, notice: n });
      continue;
    }
    if (m.role === "user") {
      const text = withoutManifest(blocksOf(m))
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      const files = attachmentsOf(m.content).map(({ id, name, mime, size, path, thumb }) => ({ id, name, mime, size, path, thumb }));
      if (!text && !files.length) continue;
      if (m.source === "event")
        items.push({ kind: "event", key, text: eventBody(text) });
      else items.push({ kind: "user", key, text, source: m.source, ...(files.length && { files }) });
      continue;
    }
    if (m.role !== "assistant") continue;
    let text = "";
    let part = 0;
    const flush = () => {
      if (text.trim())
        items.push({ kind: "reply", key: `${key}:${part++}`, text });
      text = "";
    };
    // The pages the reply cites, numbered in the order it first cites them (B1).
    const sources: { url: string; title: string }[] = [];
    for (const b of blocksOf(m)) {
      if (b.type === "text") {
        text += b.text ?? "";
        const marks = new Set<number>();
        for (const c of b.citations ?? []) {
          if (!c.url) continue;
          let i = sources.findIndex((s) => s.url === c.url);
          if (i < 0) i = sources.push({ url: c.url, title: safeTitle(c.title ?? "") || c.url }) - 1;
          marks.add(i);
        }
        for (const i of [...marks].sort((a, z) => a - z)) text += `[${sup(i + 1)}](${safeUrl(sources[i].url)})`;
      } else if ((b.type === "tool_use" || (b.type === "server_tool_use" && WEB_CALLS.has(b.name ?? ""))) && b.id) {
        flush();
        items.push({
          kind: "tool",
          key: `${key}:${b.id}`,
          id: b.id,
          name: b.name ?? "?",
          input: b.input,
          result: results.get(b.id) ?? null,
          ...profileOf(results.get(b.id)?.text),
        });
      }
    }
    if (sources.length)
      text += `\n\nSources: ${sources.map((s, i) => `${sup(i + 1)} [${s.title}](${safeUrl(s.url)})`).join(" · ")}`;
    flush();
  }
  return items;
}

/** An event's text without its `<workbench_event>` wrapper. */
export function eventBody(text: string): string {
  return text.replace(/<\/?workbench_event>/g, "").trim();
}

export type DiffLine = { op: " " | "-" | "+"; text: string };

/** Lines past which `lineDiff` stops comparing and shows the whole change. */
const DIFF_MAX = 1500;

/**
 * A line diff of two texts (longest common subsequence), with unchanged runs cut
 * to `context` lines around each change. Notes are small; a very long one is shown
 * as all-removed then all-added rather than compared.
 */
export function lineDiff(before: string, after: string, context = 2): (DiffLine | null)[] {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  let lines: DiffLine[];
  if (a.length * b.length > DIFF_MAX * DIFF_MAX) {
    lines = [
      ...a.map((text) => ({ op: "-" as const, text })),
      ...b.map((text) => ({ op: "+" as const, text })),
    ];
  } else {
    // lcs[i][j]: the longest common run of a[i..] and b[j..].
    const lcs = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i][j] =
          a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    lines = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        lines.push({ op: " ", text: a[i++] });
        j++;
      } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
        // On a tie the removal goes first, as diffs read.
        lines.push({ op: "-", text: a[i++] });
      } else {
        lines.push({ op: "+", text: b[j++] });
      }
    }
  }
  // Keep the changes and `context` lines either side; a gap becomes null.
  const keep = lines.map((l) => l.op !== " ");
  const near = lines.map((_, k) =>
    keep.slice(Math.max(0, k - context), k + context + 1).some(Boolean),
  );
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, k) => {
    if (near[k]) out.push(l);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  if (out[0] === null) out.shift();
  if (out[out.length - 1] === null) out.pop();
  return out;
}

/** A tool call's input as `field: value` lines, for a person to read (a card that
 *  has no sentence from its tool, and the card's details). */
export function readableInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return JSON.stringify(input, null, 2) ?? "";
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** A tool call in one line: its input as compact JSON, cut to `max` characters. */
export function oneLine(input: unknown, max = 60): string {
  let s: string;
  try {
    s = JSON.stringify(input) ?? "";
  } catch {
    s = String(input);
  }
  if (s === "{}") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The instance id in a `#session/<id>` link Duck wrote, or null. */
export function sessionLink(href: string | null): string | null {
  const m = href?.match(/^#session\/([^/?#\s]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ── threads at a glance (2026-10-20) ──

interface Glance {
  threads: { id: string; updated: number }[];
  unread: Record<string, number>;
  autopilots: { threadId: string; state: string }[];
  tasks: { threadId: string; state: string }[];
}

/** Replies not seen yet, in every thread. */
export const unreadTotal = (d: Pick<Glance, "unread">): number => Object.values(d.unread).reduce((n, x) => n + x, 0);

/** The overview's order: unread first, then the ones at work (replying, an
 *  autopilot running, a task working or waiting), then the most recent. */
export function overviewOrder<T extends Glance["threads"][number]>(d: Glance & { threads: T[] }, running: (id: string) => boolean): T[] {
  const live = (id: string) =>
    running(id) ||
    d.autopilots.some((a) => a.threadId === id && a.state === "running") ||
    d.tasks.some((t) => t.threadId === id && (t.state === "running" || t.state === "queued"));
  const rank = (id: string) => (d.unread[id] ? 0 : live(id) ? 1 : 2);
  return [...d.threads].sort((a, b) => rank(a.id) - rank(b.id) || b.updated - a.updated);
}
