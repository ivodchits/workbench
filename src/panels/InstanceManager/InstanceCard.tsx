// One instance row in the rail (step 1.4; console wiring added in 1.5). Mirrors
// the design mockup: a status dot, the title (inline-renamable), a "needs you"
// badge, last-activity, the inline-editable task note, and a meta line with the
// ⑃ worktree marker + branch and a mini cost readout. Hover (or keyboard focus)
// reveals row actions: toggle worktree, open the working dir, edit note, and kill.
// The meta line's token readout (real figures land in 3.1) shows `0K` for now.
//
// Clicking the row launches (or focuses) the instance's claude console; a small
// live marker (`consoleStatus`) replaces the static status glyph while a console
// is open. The persisted `status` field stays a static placeholder — the live
// hook-fed state machine and real worktree provisioning land in Phase 2.

import { useState } from "react";
import { GLYPH, Spinner } from "../../theme";
import type { Instance } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import { openPath } from "../../ipc/os";
import { updateInstance } from "../../state/registry";
import { relativeTime, statusDisplay } from "./status";
import { formatTokens, totalTokens } from "../../util/format";
import InlineEdit from "./InlineEdit";

interface InstanceCardProps {
  instance: Instance;
  /** Live console state for this instance, or null when no console is open. */
  consoleStatus: ConsoleStatus | null;
  /** Launch or focus this instance's console (row click / Enter). */
  onActivate: () => void;
  onKill: () => void;
}

function InstanceCard({ instance, consoleStatus, onActivate, onKill }: InstanceCardProps) {
  const [hover, setHover] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const st = statusDisplay(instance.status);
  const dim = instance.status === "closed";
  const showActions = hover || editingNote || editingTitle;

  const toggleWorktree = () =>
    void updateInstance(instance.id, { worktreeOn: !instance.worktreeOn });

  // No persistent "selected" highlight: several instances are visible (and live)
  // at once, so there's no single active row — only hover reveals row actions.
  return (
    <div
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !editingNote && !editingTitle) {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        padding: "8px 11px 9px 13px",
        marginBottom: 3,
        cursor: "pointer",
        background: hover ? "var(--wb-sel)" : "transparent",
        borderLeft: "2px solid transparent",
        opacity: dim ? 0.55 : 1,
        outline: "none",
      }}
    >
      {/* Row 1 — status · title · needs badge · ago / actions */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            color: consoleStatus ? consoleMarker(consoleStatus).colorVar : st.colorVar,
            fontSize: 12,
            width: 12,
            flex: "0 0 12px",
            textAlign: "center",
            lineHeight: 1,
          }}
          title={consoleStatus ? `console ${consoleStatus}` : st.label}
        >
          {consoleStatus === "spawning" ? (
            <Spinner size={12} />
          ) : consoleStatus ? (
            consoleMarker(consoleStatus).glyph
          ) : st.working ? (
            <Spinner size={12} />
          ) : (
            st.glyph
          )}
        </span>
        <span
          style={{
            color: "var(--wb-text)",
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            minWidth: 0,
          }}
        >
          <InlineEdit
            value={instance.title}
            editing={editingTitle}
            onEditingChange={setEditingTitle}
            onCommit={(next) => void updateInstance(instance.id, { title: next })}
            required
            ariaLabel="rename instance"
            style={{ fontWeight: 600, fontSize: 13, color: "var(--wb-text)" }}
            textStyle={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          />
        </span>
        {instance.status === "needs_you" && (
          <span
            style={{
              font: "600 9px var(--wb-mono)",
              letterSpacing: "0.08em",
              color: "var(--wb-bg)",
              background: "var(--wb-needs)",
              padding: "1px 5px",
              borderRadius: 2,
              textTransform: "uppercase",
              flex: "0 0 auto",
            }}
          >
            needs you
          </span>
        )}
        {showActions ? (
          <span style={{ display: "flex", gap: 7, flex: "0 0 auto" }}>
            <RowAction
              label={instance.worktreeOn ? "worktree on" : "worktree off"}
              onClick={toggleWorktree}
              active={instance.worktreeOn}
            >
              {GLYPH.worktree}
            </RowAction>
            <RowAction label="edit note" onClick={() => setEditingNote(true)}>
              ✎
            </RowAction>
            <RowAction label="open working dir" onClick={() => void openPath(instance.workingDir)}>
              🗀
            </RowAction>
            <RowAction label="kill instance" onClick={onKill} danger>
              {GLYPH.fail}
            </RowAction>
          </span>
        ) : (
          <span style={{ color: "var(--wb-textFaint)", fontSize: 10.5, flex: "0 0 auto" }}>
            {relativeTime(instance.lastActivityAt)}
          </span>
        )}
      </div>

      {/* Row 2 — task note (inline-editable) */}
      <div
        style={{
          color: "var(--wb-textDim2)",
          fontSize: 11.5,
          fontStyle: "italic",
          margin: "3px 0 5px 20px",
        }}
      >
        <InlineEdit
          value={instance.taskNote}
          editing={editingNote}
          onEditingChange={setEditingNote}
          onCommit={(next) => void updateInstance(instance.id, { taskNote: next })}
          placeholder="add a task note…"
          ariaLabel="edit task note"
          style={{ fontSize: 11.5, fontStyle: "italic", color: "var(--wb-textDim2)" }}
          textStyle={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        />
      </div>

      {/* Row 3 — worktree marker + branch · tokens */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginLeft: 20,
          font: "10.5px var(--wb-mono)",
          color: "var(--wb-textFaint)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {instance.worktreeOn && <span style={{ color: "var(--wb-accent)" }}>{GLYPH.worktree}</span>}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 150,
            }}
          >
            {instance.branch ?? "—"}
          </span>
        </span>
        <span
          style={{ marginLeft: "auto", color: "var(--wb-textDim2)" }}
          title="tokens used (input + output + cache)"
        >
          {formatTokens(totalTokens(instance))}
        </span>
      </div>
    </div>
  );
}

/** The rail glyph + color for an open console (spawning is shown as a spinner). */
function consoleMarker(status: ConsoleStatus): { glyph: string; colorVar: string } {
  switch (status) {
    case "running":
      return { glyph: GLYPH.run, colorVar: "var(--wb-accent)" };
    case "error":
      return { glyph: GLYPH.fail, colorVar: "var(--wb-needs)" };
    default:
      return { glyph: GLYPH.run, colorVar: "var(--wb-working)" };
  }
}

function RowAction({
  children,
  onClick,
  label,
  danger,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
  active?: boolean;
}) {
  const color = danger
    ? "var(--wb-needs)"
    : active
      ? "var(--wb-accent)"
      : "var(--wb-textDim2)";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        lineHeight: 1,
        font: "11px var(--wb-mono)",
        color,
      }}
    >
      {children}
    </button>
  );
}

export default InstanceCard;
