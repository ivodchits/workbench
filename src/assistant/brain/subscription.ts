// The subscription brain (step M3), the engine's side: what a turn sends to the
// headless Claude Code that answers it, and how its replies are kept.
//
// The brain runs its own loop and holds its own conversation; Duck's thread is
// still the record. Its replies are stored as API messages (thinking dropped, tool
// names without the `mcp__duck__` prefix, source "brain"), so the drawer shows them
// as any turn, and the thread carries on on the API whenever it goes back.
//
// What the brain hasn't seen of the thread goes in front of your message: all of
// it for a new session (the compaction's summary for the part it covers), and the
// turns since its last reply for a session that's running or resumed (the ones the
// API answered meanwhile).

import type Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage } from "../../ipc/assistant";
import {
  brainInterrupt,
  brainKill,
  brainSend,
  brainSpawn,
  brainToolResult,
  onBrainEvent,
  onBrainExited,
  onBrainToolCall,
  type BrainToolCall,
  type McpResult,
  type McpTool,
} from "../../ipc/brain";
import { CORE_OPEN } from "../core";
import type { Notice } from "../protocol";
import { SYSTEM_PROMPT } from "../prompt";

type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

/** The source of the messages the brain wrote. */
export const BRAIN_SOURCE = "brain";
/** The prefix Claude Code gives the tools of Duck's MCP server. */
export const TOOL_PREFIX = "mcp__duck__";
/** The brain's effort: fixed per process, so one for all (the plan's default). */
export const BRAIN_EFFORT = "medium";
/** A brain idle this long is stopped; its session is resumed when it's next needed. */
export const BRAIN_IDLE_MS = 30 * 60_000;
/** Brains running at once; another stops the one idle longest. */
export const BRAIN_MAX = 3;
/** The handoff covers at most this many of the thread's last turns, and this much text. */
export const HANDOFF_TURNS = 20;
export const HANDOFF_CHARS = 40_000;

/** Duck's prompt, and what's different about running inside Claude Code. */
export const BRAIN_PROMPT = `${SYSTEM_PROMPT}

[Running on the subscription brain]
You are answering inside Claude Code, headless, on the user's Claude subscription: Duck's API credits are low or spent, so this thread runs here until they're back. You are still Duck, with the same tools, named mcp__duck__<name> (this prompt names them without the prefix). They are all loaded: there is no tool search, so skip that step. Claude Code's own tools are off.
A call that needs the user's OK comes back at once saying a card is waiting for them: it has not run. Don't call it again; tell the user it's waiting for their OK and end your turn. Its result arrives later as a Workbench event.`;

/** What a call parked on a confirmation returns to the brain. */
export const ASKED = "Waiting for the user: a card asks them to allow this call. It has NOT run. Don't call it again; tell them it's waiting for their OK, and end your turn. Its result comes as a Workbench event once they answer.";

export interface BrainHost {
  spawn(threadId: string, tools: McpTool[]): Promise<{ resumed: boolean }>;
  send(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  kill(threadId: string): Promise<void>;
  answer(callId: string, result: McpResult): Promise<void>;
  onEvent(cb: (threadId: string, msg: BrainMessage) => void): void;
  onExit(cb: (threadId: string, code: number | null, stderr: string) => void): void;
  onToolCall(cb: (call: BrainToolCall) => void): void;
}

/** The protocol messages the brain's turn reads. */
export type BrainMessage =
  | { type: "stream_event"; event: { type: string; delta?: { type: string; text?: string } } }
  | { type: "assistant"; message: { id: string; content: Record<string, unknown>[] } }
  | { type: "user"; message: { content: unknown } }
  | { type: "result"; subtype: string; is_error?: boolean; result?: string; errors?: string[] }
  | { type: "system"; subtype: string };

/** The host over the backend, in Duck's workspace. */
export function createBrainHost(workspace: () => Promise<string>): BrainHost {
  return {
    spawn: async (threadId, tools) => brainSpawn(threadId, await workspace(), BRAIN_PROMPT, tools, BRAIN_EFFORT),
    send: brainSend,
    interrupt: brainInterrupt,
    kill: brainKill,
    answer: brainToolResult,
    onEvent: (cb) => void onBrainEvent((id, msg) => cb(id, msg as BrainMessage)),
    onExit: (cb) => void onBrainExited(cb),
    onToolCall: (cb) => void onBrainToolCall(cb),
  };
}

/** The registry's tools as the MCP server lists them (the API's server tools, such
 *  as tool search, have no schema and aren't listed). */
export function mcpTools(apiTools: readonly Anthropic.Beta.BetaToolUnion[]): McpTool[] {
  const out: McpTool[] = [];
  for (const t of apiTools) {
    if (!("input_schema" in t) || !t.input_schema) continue;
    out.push({ name: t.name, ...(t.description && { description: t.description }), inputSchema: t.input_schema });
  }
  return out;
}

/** A tool's result as MCP content. */
export function toMcpResult(r: ToolResult): McpResult {
  const content: McpResult["content"] = [];
  const blocks = typeof r.content === "string" ? [{ type: "text" as const, text: r.content }] : (r.content ?? []);
  for (const b of blocks) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "image" && b.source.type === "base64")
      content.push({ type: "image", data: b.source.data, mimeType: b.source.media_type });
    else content.push({ type: "text", text: JSON.stringify(b) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, ...(r.is_error && { isError: true }) };
}

/** A reply's blocks as the thread keeps them: no thinking (it's bound to the
 *  brain's own prompt), Duck's names for its tools, and only the API's fields. */
export function storedBlocks(content: readonly Record<string, unknown>[]): Block[] {
  const out: Block[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
      out.push({ type: "tool_use", id: b.id, name: b.name.replace(TOOL_PREFIX, ""), input: b.input ?? {} });
  }
  return out;
}

/** The tool results in a message the brain's loop added. */
export function storedResults(content: unknown): ToolResult[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: Record<string, unknown>) =>
    b?.type === "tool_result" && typeof b.tool_use_id === "string"
      ? [
          {
            type: "tool_result" as const,
            tool_use_id: b.tool_use_id,
            content: (b.content ?? "") as ToolResult["content"],
            ...(b.is_error === true && { is_error: true }),
          },
        ]
      : [],
  );
}

// ── the handoff ─────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  return blocksOf(c)
    .map((b) => (b.type === "text" ? String(b.text) : `[${String(b.type)}]`))
    .join(" ");
}

/** One stored message as lines of the handoff. */
function lines(m: StoredMessage): string[] {
  if (m.role === "notice" || m.role === "system") return [];
  const out: string[] = [];
  for (const b of blocksOf(m.content)) {
    if (b.type === "text" && String(b.text).trim())
      out.push(m.role === "assistant" ? `Duck: ${String(b.text).trim()}` : `${m.source === "event" ? "Workbench" : "User"}: ${String(b.text).trim()}`);
    else if (b.type === "tool_use") out.push(`  [Duck called ${String(b.name)} ${clip(JSON.stringify(b.input ?? {}), 200)}]`);
    else if (b.type === "tool_result")
      out.push(`  [${b.is_error ? "failed" : "result"}: ${clip(resultText(b.content).replace(/\s+/g, " "), 300)}]`);
  }
  return out;
}

/** The latest core memory block the thread started with, if any. */
function coreBlock(history: readonly StoredMessage[], before: number): string | null {
  let found: string | null = null;
  for (const m of history) {
    if (m.seq >= before) break;
    if (m.role !== "system") continue;
    for (const b of blocksOf((m.content as { content?: unknown })?.content))
      if (b.type === "text" && String(b.text).startsWith(CORE_OPEN)) found = String(b.text);
  }
  return found;
}

/** `ms` as a transcript, its last `HANDOFF_TURNS` turns within `HANDOFF_CHARS`. */
function transcript(ms: readonly StoredMessage[]): string {
  let starts = 0;
  let from = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.role === "user" && m.source !== BRAIN_SOURCE && m.source !== "duck" && lines(m).length) {
      if (++starts > HANDOFF_TURNS) break;
      from = i;
    }
  }
  const text = ms.slice(from).flatMap(lines).join("\n");
  return text.length > HANDOFF_CHARS ? `…${text.slice(text.length - HANDOFF_CHARS + 1)}` : text;
}

/**
 * The text of the brain's turn: what it hasn't seen of the thread, the notes the
 * turn opened with (core memory, the voice note, a brief) and your message.
 * `turnSeq` is your message's seq; `seen` is the last seq the brain's session has
 * seen (null: a new session, which has seen nothing).
 */
export function brainTurn(history: readonly StoredMessage[], turnSeq: number, seen: number | null): string {
  const turn = history.find((m) => m.seq === turnSeq);
  const words = turn ? lines(turn).map((l) => l.replace(/^(User|Workbench): /, "")).join("\n") : "";
  const parts: string[] = [];
  // The notes after your message (a system message), and whatever ran since.
  const after = history.filter((m) => m.seq > turnSeq);
  const notes: string[] = [];
  let i = 0;
  for (; i < after.length && after[i].role !== "user" && after[i].role !== "assistant"; i++) {
    const m = after[i];
    if (m.role !== "system") continue;
    for (const b of blocksOf((m.content as { content?: unknown })?.content))
      if (b.type === "text" && String(b.text).trim()) notes.push(String(b.text));
  }
  if (seen === null && !notes.some((n) => n.startsWith(CORE_OPEN))) {
    const core = coreBlock(history, turnSeq);
    if (core) notes.unshift(core);
  }
  // Before your message: the part the brain hasn't seen.
  let earlier = history.filter((m) => m.seq < turnSeq && m.seq > (seen ?? -1));
  let summary: string | null = null;
  for (let k = history.length - 1; k >= 0; k--) {
    const c = history[k].role === "notice" ? (history[k].content as Notice | null)?.compaction : undefined;
    if (c && history[k].seq < turnSeq) {
      if ((seen ?? -1) < c.through) {
        summary = c.summary;
        earlier = earlier.filter((m) => m.seq > c.through);
      }
      break;
    }
  }
  const so = transcript(earlier);
  const done = after.slice(i).flatMap(lines).join("\n");
  if (notes.length) parts.push(...notes);
  if (summary || so)
    parts.push(
      `<thread_so_far>\nThe conversation in this thread that you haven't seen (Duck answered it on the API). It is history: act only on the user's message below.\n${summary ? `\n<thread_summary>\n${summary.trim()}\n</thread_summary>\n` : ""}${so ? `\n${so}\n` : ""}</thread_so_far>`,
    );
  if (done) parts.push(`<done_this_turn>\nWhat Duck already did for this message before it moved to you:\n${done}\n</done_this_turn>`);
  if (!parts.length) return words;
  return `<duck_context>\nFrom Workbench, not the user:\n\n${parts.join("\n\n")}\n</duck_context>\n\n${words}`;
}

/** The last seq the brain wrote in the thread: what its session has seen. */
export function lastBrainSeq(history: readonly StoredMessage[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].source === BRAIN_SOURCE) return history[i].seq;
  return null;
}

/** The tool calls in `reply` that no stored result answers: the turn stopped
 *  between the call and its result. */
export function unanswered(history: readonly StoredMessage[], since: number): string[] {
  const calls = new Set<string>();
  for (const m of history) {
    if (m.seq < since) continue;
    for (const b of blocksOf(m.content)) {
      if (b.type === "tool_use") calls.add(String(b.id));
      if (b.type === "tool_result") calls.delete(String(b.tool_use_id));
    }
  }
  return [...calls];
}
