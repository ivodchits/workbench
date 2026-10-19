// What the drawer shows for a thread (step A3): the stored messages folded into
// display items. An assistant message becomes its text and a chip per tool call;
// the tool results (which travel in the next user message) are attached to their
// chips; thinking and the mid-conversation system messages are not shown.

import type { StoredMessage } from "../../ipc/assistant";
import type { Notice } from "../../assistant/protocol";

export type Item =
  | { kind: "user"; key: string; text: string; source: string }
  | { kind: "reply"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      id: string;
      name: string;
      input: unknown;
      result: { text: string; isError: boolean } | null;
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
}

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

export function toItems(messages: readonly StoredMessage[]): Item[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of blocksOf(m))
      if (b.type === "tool_result" && b.tool_use_id)
        results.set(b.tool_use_id, {
          text: resultText(b.content),
          isError: !!b.is_error,
        });
  }

  const items: Item[] = [];
  for (const m of messages) {
    const key = `${m.threadId}:${m.seq}`;
    if (m.role === "notice") {
      items.push({ kind: "notice", key, notice: m.content as Notice });
      continue;
    }
    if (m.role === "user") {
      const text = blocksOf(m)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      if (text) items.push({ kind: "user", key, text, source: m.source });
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
    for (const b of blocksOf(m)) {
      if (b.type === "text") text += b.text ?? "";
      else if (b.type === "tool_use" && b.id) {
        flush();
        items.push({
          kind: "tool",
          key: `${key}:${b.id}`,
          id: b.id,
          name: b.name ?? "?",
          input: b.input,
          result: results.get(b.id) ?? null,
        });
      }
    }
    flush();
  }
  return items;
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
