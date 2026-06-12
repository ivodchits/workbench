// Prompt queue UI (step 3.5, design §7) — the modal for parking a follow-up prompt
// that auto-sends when an agent finishes its turn, plus the always-mounted host that
// (a) opens the modal on Ctrl+Shift+Q or a card's quick-queue action, and (b) owns
// the firing path: on an instance's `Stop` (live phase → "done"), send its queued
// prompt into the PTY.
//
// Behaviour (settled): one queued prompt per instance (replace). If the target is
// already at rest (idle/done) the prompt is sent immediately — that *is* the moment.
// If it's working it's held until the next turn boundary; if it's at a permission
// prompt (needs-you) it is **not** auto-sent (that could mis-answer the prompt) but
// held until the turn genuinely completes. Held prompts are cancelable from the card.

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { GLYPH } from "../theme";
import Modal from "./InstanceManager/Modal";
import { submitToTerminal } from "./terminalPool";
import { useConsoles } from "../state/consoles";
import { useRegistry } from "../state/registry";
import { onStatusTransition, useLiveStatuses, type LiveStatus } from "../state/status";
import { cancelQueued, getQueued, setQueued, useQueued } from "../state/queue";
import { bindQueueDialogOpener } from "./queueDialogControl";
import { registerCommand } from "../keyboard/bus";

/** True when an agent is between turns (so a prompt should send immediately rather
 *  than wait for a `Stop` that may never come). A freshly-launched console with no
 *  hook signal yet (undefined phase) is also "at rest" — it's sitting at the prompt. */
function atRest(live: LiveStatus | undefined): boolean {
  if (!live) return true;
  if (live.compacting) return false;
  return live.phase === "idle" || live.phase === "done";
}

// --- host -------------------------------------------------------------------

/** Always-mounted: registers the open command + the Stop→fire wiring, and renders
 *  the modal only while open. Mounted once from App (beside the template host).
 *  (The imperative `openQueueDialog` opener lives in `queueDialogControl` so this
 *  file stays a pure component export.) */
export default function QueuePromptHost() {
  // `undefined` = closed; otherwise the initial target (an id, or null = focused).
  const [target, setTarget] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    bindQueueDialogOpener((id) => setTarget(id ?? null));
    return () => bindQueueDialogOpener(null);
  }, []);

  useEffect(() => registerCommand("openQueue", () => setTarget(null)), []);

  // The firing path: when an instance transitions into "done" (its turn finished)
  // and it has a queued prompt, send it. Clear first so the prompt's *own* later
  // Stop can't re-fire a stale entry (single-shot). App-lifetime subscription.
  useEffect(
    () =>
      onStatusTransition((instanceId, phase) => {
        if (phase !== "done") return;
        const q = getQueued(instanceId);
        if (!q) return;
        cancelQueued(instanceId);
        submitToTerminal(instanceId, q.text); // false (no live terminal) → simply dropped
      }),
    [],
  );

  if (target === undefined) return null;
  return <QueuePromptDialog initialTarget={target} onClose={() => setTarget(undefined)} />;
}

// --- dialog -----------------------------------------------------------------

function QueuePromptDialog({
  initialTarget,
  onClose,
}: {
  initialTarget: string | null;
  onClose: () => void;
}) {
  const { open: consoles, activeId } = useConsoles();
  const { instances } = useRegistry();
  const live = useLiveStatuses();
  const queues = useQueued();

  // Only a running console can receive (or hold) a prompt.
  const targetIds = useMemo(
    () => consoles.filter((c) => c.status === "running").map((c) => c.instanceId),
    [consoles],
  );

  const [targetId, setTargetId] = useState<string | null>(initialTarget);
  const effectiveTarget =
    (targetId && targetIds.includes(targetId) && targetId) ||
    (activeId && targetIds.includes(activeId) && activeId) ||
    targetIds[0] ||
    null;

  const [text, setText] = useState("");
  const canQueue = effectiveTarget !== null && text.trim().length > 0;

  const instanceTitle = (id: string) => instances.find((i) => i.id === id)?.title ?? id.slice(0, 8);
  const targetLive = effectiveTarget ? live.get(effectiveTarget) : undefined;
  const sendsNow = atRest(targetLive);
  const existing = effectiveTarget ? queues.get(effectiveTarget) ?? null : null;

  const submit = () => {
    if (!effectiveTarget || !text.trim()) return;
    if (sendsNow) submitToTerminal(effectiveTarget, text);
    else setQueued(effectiveTarget, text);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd+Enter queues (plain Enter is a newline in the textarea). Esc closes
    // — handle it here (preventing it from also reaching the rail); stopping
    // propagation without closing was the bug that swallowed the Modal's own Esc.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <Modal title="queue a prompt" onClose={onClose} width={500}>
      <div onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>queue for</span>
          {targetIds.length === 0 ? (
            <span style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
              no running console — launch an agent first
            </span>
          ) : (
            <select
              value={effectiveTarget ?? ""}
              onChange={(e) => setTargetId(e.target.value)}
              style={inputStyle}
            >
              {targetIds.map((id) => (
                <option key={id} value={id}>
                  {instanceTitle(id)}
                </option>
              ))}
            </select>
          )}
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>prompt</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="the follow-up to send when this agent finishes its turn…"
            spellCheck={false}
            autoFocus
            rows={6}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
        </label>

        {/* What will happen, given the target's current state. */}
        {effectiveTarget && (
          <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-textDim2)", display: "flex", gap: 6 }}>
            {sendsNow ? (
              <>
                <span style={{ color: "var(--wb-done)" }}>{GLYPH.run}</span>
                <span>agent is between turns — this sends now.</span>
              </>
            ) : targetLive?.phase === "needs_you" ? (
              <>
                <span style={{ color: "var(--wb-needs)" }}>{GLYPH.queue}</span>
                <span>agent is waiting on you — held until the turn completes (won't answer the prompt).</span>
              </>
            ) : (
              <>
                <span style={{ color: "var(--wb-working)" }}>{GLYPH.queue}</span>
                <span>agent is working — held until it finishes this turn.</span>
              </>
            )}
          </div>
        )}

        {/* A prompt already queued for this target — queueing replaces it; clear it here. */}
        {existing && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 9px",
              border: "1px solid var(--wb-border)",
              background: "var(--wb-bg)",
              font: "11px var(--wb-mono)",
            }}
          >
            <span style={{ color: "var(--wb-accent)", flex: "0 0 auto" }}>{GLYPH.queue} queued</span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                color: "var(--wb-textDim2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={existing.text}
            >
              {existing.text.replace(/\s+/g, " ").trim()}
            </span>
            <button
              onClick={() => effectiveTarget && cancelQueued(effectiveTarget)}
              title="clear the queued prompt"
              style={{ ...buttonStyle, padding: "3px 8px", flex: "0 0 auto" }}
            >
              clear
            </button>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span style={{ flex: 1, font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
            <span style={{ color: "var(--wb-accent)" }}>⌃↵</span> queue ·{" "}
            <span style={{ color: "var(--wb-accent)" }}>esc</span> cancel
          </span>
          <button onClick={onClose} style={buttonStyle}>
            cancel
          </button>
          <button
            onClick={submit}
            disabled={!canQueue}
            style={{
              ...buttonStyle,
              borderColor: "var(--wb-borderActive)",
              color: canQueue ? "var(--wb-text)" : "var(--wb-textFaint)",
              opacity: canQueue ? 1 : 0.6,
            }}
          >
            {GLYPH.queue} {sendsNow ? "send" : "queue"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const labelStyle: CSSProperties = {
  font: "600 10px var(--wb-mono)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--wb-textDim2)",
};

const inputStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 8px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
};

const buttonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};
