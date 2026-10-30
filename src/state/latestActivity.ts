// What each session did last, for the phone's dashboard cards: the tool call it is
// on, the prompt that started its turn, and the start of its last reply. Folded
// from the hook stream, like the status engine, so no transcript has to be open.
// Read by `RemoteMirror` only.

import { onHookEvent, type HookEnvelope, type HookEvent } from "../ipc/hooks";
import { oneLine, toolTarget, toolTitle } from "../transcript/summary";
import type { ToolItem } from "../transcript/model";

/** The reply is cut to this many characters: the card shows three lines of it. */
const REPLY_CHARS = 400;
const PROMPT_CHARS = 200;

export interface LatestActivity {
  /** The latest tool call this turn, as its title and one-line target. */
  tool: { name: string; target: string } | null;
  /** The prompt that started this turn. */
  prompt: string | null;
  /** The start of the last reply, whitespace folded. */
  reply: string | null;
  /** Epoch seconds of the last event that changed this. */
  at: number;
}

let latest = new Map<string, LatestActivity>();
const listeners = new Set<() => void>();

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A hook's tool call as the transcript's one-line summary names it. */
export function hookTool(name: string, input: unknown): { name: string; target: string } {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const agent = name === "Agent" || name === "Task" ? { type: str("subagent_type"), description: str("description") } : null;
  // Just the fields `toolTitle` / `toolTarget` read.
  const item = { name, input: args, agent, questions: null } as unknown as ToolItem;
  const target = name === "AskUserQuestion" ? oneLine(questionText(args)) : toolTarget(item);
  return { name: toolTitle(item), target: cut(target, 160) };
}

function questionText(args: Record<string, unknown>): string {
  const qs = Array.isArray(args.questions) ? args.questions : [];
  const q = qs[0] as { question?: unknown } | undefined;
  return typeof q?.question === "string" ? q.question : "";
}

/** Pure transition: fold one hook event into an instance's latest activity.
 *  Returns `prev` itself when nothing changed. */
export function reduceLatest(prev: LatestActivity | undefined, event: HookEvent, at: number): LatestActivity | undefined {
  const base: LatestActivity = prev ?? { tool: null, prompt: null, reply: null, at };
  switch (event.hook_event_name ?? "") {
    case "UserPromptSubmit": {
      const prompt = typeof event.prompt === "string" ? cut(event.prompt, PROMPT_CHARS) : null;
      return { ...base, tool: null, prompt, at };
    }
    case "PreToolUse":
      return { ...base, tool: hookTool(event.tool_name ?? "", event.tool_input), at };
    case "Stop": {
      const msg = event.last_assistant_message;
      const reply = typeof msg === "string" && msg.trim() ? cut(msg, REPLY_CHARS) : base.reply;
      return { ...base, tool: null, reply, at };
    }
    case "StopFailure":
      return { ...base, tool: null, reply: "Stopped on an error.", at };
    default:
      return prev;
  }
}

function ingest(env: HookEnvelope): void {
  const prev = latest.get(env.instanceId);
  const next = reduceLatest(prev, env.event, env.receivedAt);
  if (!next || next === prev) return;
  latest = new Map(latest).set(env.instanceId, next);
  for (const cb of listeners) cb();
}

/** A reply read from the transcript, for a session that has sent no `Stop` since
 *  the app started. Ignored once the hooks have said anything newer. */
export function seedReply(instanceId: string, reply: string, at: number): void {
  if (latest.get(instanceId)) return;
  latest = new Map(latest).set(instanceId, { tool: null, prompt: null, reply: cut(reply, REPLY_CHARS), at });
  for (const cb of listeners) cb();
}

let subscription: Promise<unknown> | null = null;
/** Start following the hook stream. Idempotent and never torn down. */
export function initLatestActivity(): void {
  if (subscription) return;
  subscription = onHookEvent(ingest).catch(() => {});
}

export function getLatestActivity(): ReadonlyMap<string, LatestActivity> {
  return latest;
}

/** Call `cb` on every change; returns the unsubscribe. */
export function onLatestActivity(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
