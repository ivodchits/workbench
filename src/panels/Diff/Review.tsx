// The review panel's "review with a fresh agent" (step A1): the prompt dialog,
// and the strip that follows the review and lists its findings to tick.

import { useEffect, useState } from "react";

import { getPref, setPref } from "../../ipc/prefs";
import type { Instance } from "../../ipc/registry";
import { focusConsole, useConsoles } from "../../state/consoles";
import { DEFAULT_REVIEW_PROMPT, fillReviewPrompt, type Finding } from "../../state/reviewFindings";
import { dropReview, toggleFinding, useReview } from "../../state/reviews";
import { useRegistry } from "../../state/registry";
import { GLYPH } from "../../theme";
import Modal from "../InstanceManager/Modal";
import { confirmButtonStyle } from "../Git/format";
import { sendFindings, startReview } from "./reviewRun";

/** Write and start the review. The prompt is kept per project. */
export function ReviewDialog({
  impl,
  base,
  onClose,
  onStarted,
}: {
  impl: Instance;
  base: string;
  onClose: () => void;
  onStarted: (error: string | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPref("reviewPrompts", {}).then((all) => setText(all[impl.projectId] ?? DEFAULT_REVIEW_PROMPT));
  }, [impl.projectId]);

  const start = async () => {
    if (!text?.trim()) return;
    setBusy(true);
    try {
      const all = { ...(await getPref("reviewPrompts", {})) };
      if (text === DEFAULT_REVIEW_PROMPT) delete all[impl.projectId];
      else all[impl.projectId] = text;
      await setPref("reviewPrompts", all);
      await startReview(impl, fillReviewPrompt(text, base));
      onStarted(null);
    } catch (e) {
      onStarted(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="review with a fresh agent" onClose={onClose} width={640}>
      <div style={{ fontSize: 12, color: "var(--wb-textDim2)", lineHeight: 1.5, marginBottom: 8 }}>
        A new session starts in <span style={{ color: "var(--wb-text)" }}>{impl.workingDir}</span> with this
        prompt. Its findings come back here to tick, and the ticked ones go to “{impl.title}” as review
        comments. The prompt is kept for this project; <code>{"{base}"}</code> becomes <code>{base}</code>.
      </div>
      <textarea
        value={text ?? ""}
        disabled={text === null}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
        }}
        rows={16}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          background: "var(--wb-bg)",
          color: "var(--wb-text)",
          border: "1px solid var(--wb-borderActive)",
          outline: "none",
          padding: "6px 8px",
          font: "11.5px/1.5 var(--wb-mono)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <button
          onClick={() => setText(DEFAULT_REVIEW_PROMPT)}
          disabled={text === DEFAULT_REVIEW_PROMPT}
          style={{ ...confirmButtonStyle, marginRight: "auto" }}
        >
          reset to default
        </button>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => void start()}
          disabled={busy || !text?.trim()}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)", color: "var(--wb-accent)" }}
        >
          {busy ? "starting…" : "⌕ start review (Ctrl+Enter)"}
        </button>
      </div>
    </Modal>
  );
}

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  high: "var(--wb-needs)",
  medium: "var(--wb-working)",
  low: "var(--wb-textDim2)",
};

/** The review under way, or its findings to tick and send. */
export function ReviewStrip({
  impl,
  onShow,
  onSent,
}: {
  impl: Instance;
  /** Go to a finding's lines in the diff. */
  onShow: (f: Finding) => void;
  onSent: (text: string) => void;
}) {
  const review = useReview(impl.id);
  const { instances } = useRegistry();
  const { open: consoles } = useConsoles();
  const [sending, setSending] = useState(false);
  // The findings go to the implementing session's prompt: it must be running here.
  const live = consoles.some((c) => c.instanceId === impl.id && c.status === "running" && !c.tornOff);
  if (!review) return null;
  const reviewer = instances.find((i) => i.id === review.reviewerId);
  const findings = review.findings ?? [];
  const ticked = findings.filter((_, i) => review.ticked.has(i));

  const send = async () => {
    setSending(true);
    try {
      const sent = await sendFindings(impl, ticked);
      dropReview(impl.id);
      if (sent) {
        onSent(
          sent.how === "sent"
            ? `${GLYPH.ok} sent ${ticked.length} finding${ticked.length === 1 ? "" : "s"} to “${impl.title}”`
            : `queued ${ticked.length} finding${ticked.length === 1 ? "" : "s"} — sent when the agent finishes its turn`,
        );
      }
    } catch (e) {
      onSent(`${GLYPH.warn} ${String(e)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        flex: "0 1 auto",
        maxHeight: "40%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        font: "11px var(--wb-mono)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          padding: "4px 10px",
          background: "var(--wb-titlebar)",
          color: "var(--wb-textDim2)",
        }}
      >
        <span style={{ color: "var(--wb-accent)" }}>⌕ review</span>
        <button
          onClick={() => reviewer && focusConsole(reviewer.id)}
          title="show the reviewing session"
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--wb-textDim2)", font: "11px var(--wb-mono)" }}
        >
          {reviewer ? `“${reviewer.title}”` : "the reviewer"}
        </button>
        <span>
          {review.state === "running"
            ? "is reviewing…"
            : review.findings === null
              ? "replied without a findings block — read it in its console"
              : findings.length === 0
                ? "found nothing"
                : `found ${findings.length}`}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <StripButton onClick={() => dropReview(impl.id)} title="forget this review (its session stays)">
            dismiss
          </StripButton>
          {findings.length > 0 && (
            <StripButton
              onClick={() => void send()}
              disabled={sending || ticked.length === 0 || !live}
              accent
              title={live ? "send the ticked findings as review comments" : `“${impl.title}” has no running console here`}
            >
              ⏎ send {ticked.length} to “{impl.title}”
            </StripButton>
          )}
        </span>
      </div>
      {findings.length > 0 && (
        <div style={{ overflow: "auto", minHeight: 0 }}>
          {findings.map((f, i) => {
            const on = review.ticked.has(i);
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "4px 10px",
                  borderBottom: "1px solid var(--wb-border)",
                  opacity: on ? 1 : 0.6,
                }}
              >
                <button
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleFinding(impl.id, i)}
                  style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: on ? "var(--wb-done)" : "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}
                >
                  {on ? "▣" : "▢"}
                </button>
                <span style={{ color: SEVERITY_COLOR[f.severity], flex: "0 0 auto" }}>{f.severity}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button
                    onClick={() => onShow(f)}
                    title="show these lines"
                    style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--wb-accent)", font: "11px var(--wb-mono)" }}
                  >
                    {f.fromLine === f.toLine ? `${f.path}:${f.fromLine}` : `${f.path}:${f.fromLine}-${f.toLine}`}
                  </button>
                  <div style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.note}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StripButton({
  children,
  onClick,
  disabled,
  accent,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--wb-textFaint)" : accent ? "var(--wb-accent)" : "var(--wb-textDim2)",
        font: "10.5px var(--wb-mono)",
        padding: "2px 7px",
      }}
    >
      {children}
    </button>
  );
}
