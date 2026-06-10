// One instance row in the rail (step 1.4; console wiring 1.5; live status 2.2).
// Mirrors the design mockup: a status dot, the title (inline-renamable), a "needs
// you" badge, last-activity, the inline-editable task note, and a meta line with
// the ⑃ worktree marker + branch and a mini cost readout. Hover (or keyboard
// focus) reveals row actions: toggle worktree, open the working dir, edit note,
// and kill. The meta line's token readout (real figures land in 3.1) shows `0K`.
//
// Clicking the row launches (or focuses) the instance's claude console. The status
// dot is the merged view (`mergeStatus`): the PTY lifecycle, the live hook-fed
// status (step 2.2 — working spinner, ● needs you, ○ done, compacting, nested
// subagents), and the persisted placeholder, in that precedence.

import { useState } from "react";
import { GLYPH, Spinner } from "../../theme";
import type { Instance } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import type { LiveStatus } from "../../state/status";
import { openPath } from "../../ipc/os";
import { ptyWrite } from "../../ipc/pty";
import { matchCommand } from "../../keyboard";
import { updateInstance } from "../../state/registry";
import { markInterrupted } from "../../state/status";
import { mergeStatus, relativeTime } from "./status";
import { formatTokens, totalTokens } from "../../util/format";
import InlineEdit from "./InlineEdit";

// The keystroke that interrupts a running agent: ESC stops the current generation
// in the claude TUI. Sent straight to the PTY (works without focusing the console).
// Keep this as the single source for the interrupt key (design §11 caveat).
const INTERRUPT_KEY = new Uint8Array([0x1b]);

interface InstanceCardProps {
  instance: Instance;
  /** Live console state for this instance, or null when no console is open. */
  consoleStatus: ConsoleStatus | null;
  /** Live hook-fed status for this instance, or null when none (step 2.2). */
  live: LiveStatus | null;
  /** Launch or focus this instance's console (row click / Enter). */
  onActivate: () => void;
  onKill: () => void;
}

function InstanceCard({ instance, consoleStatus, live, onActivate, onKill }: InstanceCardProps) {
  const [hover, setHover] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const view = mergeStatus(consoleStatus, live, instance.status);
  const dim = !live && !consoleStatus && instance.status === "closed";
  const showActions = hover || editingNote || editingTitle;

  const toggleWorktree = () =>
    void updateInstance(instance.id, { worktreeOn: !instance.worktreeOn });

  // Rail single-keys for a focused instance card (design §5.y). The guards defer
  // to an open inline editor (typing) and to events from child controls; nav /
  // new / add-project / return are left to bubble up to the rail container.
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingNote || editingTitle) return;
    if (e.target !== e.currentTarget) return;
    const m = matchCommand(e.nativeEvent, "rail");
    if (!m) return;
    switch (m.command) {
      case "railOpen":
        onActivate();
        break;
      case "railEditNote":
        setEditingNote(true);
        break;
      case "railRename":
        setEditingTitle(true);
        break;
      case "railKill":
        onKill();
        break;
      case "railWorktree":
        toggleWorktree();
        break;
      case "railOpenDir":
        void openPath(instance.workingDir);
        break;
      case "railInterrupt":
        if (consoleStatus === "running") {
          void ptyWrite(instance.id, INTERRUPT_KEY);
          markInterrupted(instance.id); // interrupting fires no hook — update the dot ourselves
        }
        break;
      default:
        return; // not a card concern
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // No persistent "selected" highlight: several instances are visible (and live)
  // at once, so there's no single active row — only hover reveals row actions.
  return (
    <div
      tabIndex={0}
      data-wb-rail-row
      data-wb-instance-id={instance.id}
      onClick={onActivate}
      onKeyDown={onCardKeyDown}
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
            color: view.colorVar,
            fontSize: 12,
            width: 12,
            flex: "0 0 12px",
            textAlign: "center",
            lineHeight: 1,
          }}
          title={view.label}
        >
          {view.spinning ? <Spinner size={12} color={view.colorVar} /> : view.glyph}
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
        {view.compacting && (
          <span
            style={{
              font: "600 9px var(--wb-mono)",
              letterSpacing: "0.08em",
              color: "var(--wb-working)",
              border: "1px solid var(--wb-working)",
              padding: "1px 5px",
              borderRadius: 2,
              textTransform: "uppercase",
              flex: "0 0 auto",
            }}
          >
            compacting
          </span>
        )}
        {view.needsYou && (
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
            {relativeTime(view.liveAt ?? instance.lastActivityAt)}
          </span>
        )}
      </div>

      {/* Nested subagent activity (SubagentStart/Stop), §4.4. */}
      {view.subagents > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            margin: "2px 0 0 20px",
            font: "10.5px var(--wb-mono)",
            color: "var(--wb-textDim2)",
          }}
        >
          <span style={{ color: "var(--wb-working)" }}>↳</span>
          <Spinner size={10} />
          <span>
            {view.subagents} subagent{view.subagents === 1 ? "" : "s"}
          </span>
        </div>
      )}

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
