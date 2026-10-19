// "Try Duck" (step A2): a minimal surface in the ◆ duck menu for talking to the
// engine before the drawer exists (A3 replaces it). It speaks only the Duck
// Protocol, like every surface: `sync` → the thread list, `thread.open` → the
// latest thread's history, then live events. Plain text, no markdown.

import { useEffect, useRef, useState } from "react";
import { getDuck } from "../assistant";
import type { StoredMessage, ThreadRow } from "../ipc/assistant";
import type { ConfirmRequest, Notice, TurnState } from "../assistant/protocol";

type Block = { type: string; text?: string; name?: string; is_error?: boolean };

/** One display line per message (tool results collapse into their call's line). */
function lines(m: StoredMessage): string[] {
  if (m.role === "notice") return [`! ${(m.content as Notice).text}`];
  if (m.role === "system") return [];
  const blocks: Block[] =
    typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : (m.content as Block[]);
  const who = m.role === "user" ? "you" : "duck";
  return blocks.flatMap((b) => {
    if (b.type === "text" && b.text?.trim())
      return [`${who}: ${b.text.trim()}`];
    if (b.type === "tool_use") return [`  ⚙ ${b.name}`];
    if (b.type === "tool_result" && b.is_error) return ["  ⚙ (failed)"];
    return [];
  });
}

export default function AssistantTry() {
  const duck = getDuck();
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [state, setState] = useState<TurnState>("idle");
  const [asks, setAsks] = useState<ConfirmRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<string | null>(null);
  const wantNew = useRef(false);

  useEffect(() => {
    if (!duck) return;
    const open = (t: ThreadRow | null) => {
      threadRef.current = t?.id ?? null;
      setThread(t);
      setMessages([]);
      setStreaming("");
      if (t) duck.send({ type: "thread.open", threadId: t.id });
    };
    const mine = (id: string) => id === threadRef.current;
    const off = duck.subscribe((e) => {
      switch (e.type) {
        case "threads":
          open(e.threads[0] ?? null);
          break;
        case "thread":
          if (mine(e.thread.id)) setThread(e.thread);
          else if (wantNew.current) {
            wantNew.current = false;
            open(e.thread);
          }
          break;
        case "history":
          if (mine(e.threadId)) {
            setMessages(e.messages);
            setState(e.state);
          }
          break;
        case "message":
          if (!mine(e.message.threadId)) break;
          setMessages((ms) => [...ms, e.message]);
          if (e.message.role === "assistant") setStreaming("");
          break;
        case "delta":
          if (mine(e.threadId)) setStreaming((s) => s + e.text);
          break;
        case "turnState":
          if (mine(e.threadId)) {
            setState(e.state);
            if (e.state === "idle") setStreaming("");
          }
          break;
        case "confirm":
          setAsks((a) => [
            ...a.filter((x) => x.toolUseId !== e.request.toolUseId),
            e.request,
          ]);
          break;
        case "confirmed":
          setAsks((a) => a.filter((x) => x.toolUseId !== e.toolUseId));
          break;
        case "error":
          setError(e.message);
          break;
      }
    });
    duck.send({ type: "sync" });
    return off;
  }, [duck]);

  if (!duck)
    return (
      <div style={{ padding: "4px 12px", color: "var(--wb-textFaint)" }}>
        Duck isn't running.
      </div>
    );

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError(null);
    if (!threadRef.current) wantNew.current = true;
    duck.send({
      type: "send",
      threadId: threadRef.current,
      text,
      source: "desktop",
    });
  };
  const shown = messages.flatMap(lines).slice(-8);
  const busy = state !== "idle";

  return (
    <div
      style={{
        padding: "2px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", gap: 6, color: "var(--wb-textFaint)" }}>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {thread ? thread.title || "untitled" : "new thread"} ·{" "}
          {messages.length} msgs · {state}
        </span>
        <button
          type="button"
          style={btn}
          onClick={() => {
            threadRef.current = null;
            setThread(null);
            setMessages([]);
            setStreaming("");
          }}
        >
          new
        </button>
      </div>
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--wb-text)",
          maxHeight: 180,
          overflowY: "auto",
        }}
      >
        {shown.join("\n")}
        {streaming && `${shown.length ? "\n" : ""}duck: ${streaming}`}
      </div>
      {asks.map((a) => (
        <div
          key={a.toolUseId}
          style={{ display: "flex", gap: 6, alignItems: "center" }}
        >
          <span style={{ flex: 1, color: "var(--wb-needs)" }}>
            run {a.name} {JSON.stringify(a.input)}?
          </span>
          <button
            type="button"
            style={btn}
            onClick={() =>
              duck.send({
                type: "confirm",
                threadId: a.threadId,
                toolUseId: a.toolUseId,
                allow: true,
              })
            }
          >
            allow
          </button>
          <button
            type="button"
            style={btn}
            onClick={() =>
              duck.send({
                type: "confirm",
                threadId: a.threadId,
                toolUseId: a.toolUseId,
                allow: false,
              })
            }
          >
            deny
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="ask duck…"
          style={input}
        />
        {busy && threadRef.current ? (
          <button
            type="button"
            style={btn}
            onClick={() =>
              duck.send({ type: "stop", threadId: threadRef.current! })
            }
          >
            stop
          </button>
        ) : (
          <button type="button" style={btn} onClick={send}>
            send
          </button>
        )}
      </div>
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "inherit",
  padding: "1px 6px",
  cursor: "pointer",
};

const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--wb-bg)",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "inherit",
  padding: "2px 6px",
};
