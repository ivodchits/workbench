// Every thread at a glance (2026-10-20): what each one is doing, its news since you
// last looked, and the autopilots and worker tasks it runs. A view of what the
// drawer already holds, with no model call: the "master thread" without a
// conversation to pay for. A row opens its thread.

import type { DuckState } from "./duckState";
import { isRunning } from "./duckState";
import { Shell } from "./TrustViews";
import { overviewOrder } from "./view";

export function OverviewPanel({
  duck,
  onBack,
  onOpen,
}: {
  duck: DuckState;
  onBack: () => void;
  onOpen: (threadId: string) => void;
}) {
  const threads = overviewOrder(duck, isRunning);
  return (
    <Shell title="all threads" onBack={onBack}>
      {threads.length === 0 && <div style={{ color: "var(--wb-textFaint)" }}>No threads yet.</div>}
      {threads.map((t) => {
        const unread = duck.unread[t.id] ?? 0;
        const autopilots = duck.autopilots.filter((a) => a.threadId === t.id);
        const tasks = duck.tasks.filter((x) => x.threadId === t.id && (x.state === "running" || x.state === "queued"));
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(t.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              width: "100%",
              textAlign: "left",
              padding: "6px 8px",
              marginBottom: 4,
              background: t.id === duck.current ? "var(--wb-sel)" : "transparent",
              border: "1px solid var(--wb-border)",
              color: "var(--wb-text)",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <span style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              {unread > 0 && <span style={{ color: "var(--wb-accent)" }}>● {unread}</span>}
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: unread ? 600 : 400 }}>
                {t.title || "untitled"}
              </span>
              {isRunning(t.id) && <span style={{ color: "var(--wb-working)" }}>replying…</span>}
            </span>
            {duck.news[t.id] && (
              <span style={{ color: unread ? "var(--wb-textDim2)" : "var(--wb-textFaint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {duck.news[t.id]}
              </span>
            )}
            {autopilots.map((a) => (
              <span key={a.instanceId} style={{ color: a.state === "paused" ? "var(--wb-needs)" : "var(--wb-textDim2)" }}>
                ⟳ {a.session} · {a.text}
              </span>
            ))}
            {tasks.map((x) => (
              <span key={x.id} style={{ color: "var(--wb-textDim2)" }}>
                ▸ task {x.title} · {x.state === "queued" ? "waiting" : "working"}
              </span>
            ))}
          </button>
        );
      })}
    </Shell>
  );
}
