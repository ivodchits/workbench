// One instance row in the rail (step 1.4; console wiring 1.5; live status 2.2).
// Mirrors the design mockup: a status dot, the title (inline-renamable), a "needs
// you" badge, last-activity, the inline-editable task note, and a meta line with
// the ⑃ worktree marker + branch and a mini token readout. Hover (or keyboard
// focus) reveals row actions: toggle worktree, open the working dir, edit note,
// and kill. The meta line's token readout is the live context-window occupancy
// (matches Claude Code's /context), tracked by the transcript tailer (step 3.1);
// its tooltip carries the input/cache-write/cache-read breakdown.
//
// Step 2.6 adds the "shared working dir" warning: when this instance shares its
// working dir with another worktree-off instance (`shared`), the meta line shows
// a non-blocking ⚠ marker that doubles as a one-click "isolate in a worktree"
// (the 2.4 provision flow) — design §6 caveat, decision 6.
//
// Clicking the row launches (or focuses) the instance's claude console. The status
// dot is the merged view (`mergeStatus`): the PTY lifecycle, the live hook-fed
// status (step 2.2 — working spinner, ● needs you, ○ done, compacting, nested
// subagents), and the persisted placeholder, in that precedence.

import { useState } from "react";
import { ACCENT_SWATCHES, GLYPH, Spinner } from "../../theme";
import { accentVars } from "./accent";
import type { Instance } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import type { LiveStatus } from "../../state/status";
import { openPath } from "../../ipc/os";
import { ptyWrite } from "../../ipc/pty";
import { matchCommand } from "../../keyboard";
import { updateInstance } from "../../state/registry";
import { markInterrupted } from "../../state/status";
import { cancelQueued, useQueued } from "../../state/queue";
import { openQueueDialog } from "../queueDialogControl";
import { mergeStatus, relativeTime } from "./status";
import { contextWindowTokens, formatTokens, tokenBreakdown } from "../../util/format";
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
  /** True when this worktree-off instance shares its working dir with another
   *  (step 2.6) — shows the non-blocking ⚠ "shared" warning + one-click isolate. */
  shared: boolean;
  /** Launch or focus this instance's console (row click / Enter). */
  onActivate: () => void;
  /** Provision (or revert) this instance's worktree — opens a confirm (step 2.4). */
  onToggleWorktree: () => void;
  /** Open (or focus) this instance's Diff/Review panel (step 2.7). */
  onReview: () => void;
  onKill: () => void;
}

function InstanceCard({
  instance,
  consoleStatus,
  live,
  shared,
  onActivate,
  onToggleWorktree,
  onReview,
  onKill,
}: InstanceCardProps) {
  const [hover, setHover] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [pickingAccent, setPickingAccent] = useState(false);
  const view = mergeStatus(consoleStatus, live, instance.status);
  const queued = useQueued().get(instance.id) ?? null;
  const dim = !live && !consoleStatus && instance.status === "closed";
  const showActions = hover || editingNote || editingTitle || pickingAccent;

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
        onToggleWorktree();
        break;
      case "railDiff":
        onReview();
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
      case "railQueue":
        if (consoleStatus === "running") openQueueDialog(instance.id);
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
        // Per-instance accent (step 3.9): re-tints every `var(--wb-accent)` inside.
        ...accentVars(instance.accent),
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
        {queued && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              cancelQueued(instance.id);
            }}
            title={`queued: ${queued.text}\n(click to cancel)`}
            style={{
              font: "600 9px var(--wb-mono)",
              letterSpacing: "0.08em",
              color: "var(--wb-accent)",
              background: "transparent",
              border: "1px solid var(--wb-accent)",
              padding: "1px 5px",
              borderRadius: 2,
              textTransform: "uppercase",
              cursor: "pointer",
              flex: "0 0 auto",
              lineHeight: 1.4,
            }}
          >
            {GLYPH.queue} queued
          </button>
        )}
        {showActions ? (
          <span style={{ display: "flex", gap: 7, flex: "0 0 auto" }}>
            <RowAction
              label={instance.worktreeOn ? "return to project root" : "isolate in a worktree"}
              onClick={onToggleWorktree}
              active={instance.worktreeOn}
              fontSize={16.5}
            >
              {GLYPH.worktree}
            </RowAction>
            {consoleStatus === "running" && (
              <RowAction label="queue a prompt (sends when the agent finishes)" onClick={() => openQueueDialog(instance.id)}>
                {GLYPH.queue}
              </RowAction>
            )}
            <RowAction label="review changes (diff)" onClick={onReview}>
              ±
            </RowAction>
            <RowAction
              label="accent color"
              onClick={() => setPickingAccent((v) => !v)}
              active={instance.accent != null}
            >
              ◣
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

      {pickingAccent && (
        <AccentPicker
          current={instance.accent}
          onPick={(color) => {
            void updateInstance(instance.id, { accent: color });
            setPickingAccent(false);
          }}
          onClose={() => setPickingAccent(false)}
        />
      )}

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
          // A manual edit takes the note off auto-mirror, so the agent's terminal
          // title stops overwriting what the user typed (live-mirror feature).
          onCommit={(next) =>
            void updateInstance(instance.id, { taskNote: next, taskNoteAuto: false })
          }
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
        {shared && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleWorktree();
            }}
            aria-label="shared working dir — isolate in a worktree"
            title={
              "Shared working dir: another instance runs here too — they can " +
              "overwrite each other's edits. Click to isolate this one in a worktree."
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              flex: "0 0 auto",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              font: "10.5px var(--wb-mono)",
              color: "var(--wb-working)",
            }}
          >
            {GLYPH.warn} shared
          </button>
        )}
        <span
          style={{ marginLeft: "auto", color: "var(--wb-textDim2)" }}
          title={tokenBreakdown(instance)}
        >
          {formatTokens(contextWindowTokens(instance))}
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
  fontSize = 11,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
  active?: boolean;
  fontSize?: number;
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
        font: `${fontSize}px var(--wb-mono)`,
        color,
      }}
    >
      {children}
    </button>
  );
}

/** A small swatch popover for the per-instance accent (step 3.9). Fixed palette
 *  (design decision) + a "none" that clears back to the theme accent. A full-screen
 *  transparent backdrop closes it on an outside click; the swatch click itself is
 *  stopped from bubbling to the card's row-activate. */
function AccentPicker({
  current,
  onPick,
  onClose,
}: {
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Outside-click catcher (under the popover). */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 50 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 28,
          right: 11,
          zIndex: 51,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          background: "var(--wb-panel)",
          border: "1px solid var(--wb-border)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}
      >
        {ACCENT_SWATCHES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-label={`accent ${s.id}`}
            title={s.id}
            onClick={(e) => {
              e.stopPropagation();
              onPick(s.color);
            }}
            style={{
              width: 14,
              height: 14,
              padding: 0,
              cursor: "pointer",
              background: s.color,
              border:
                current === s.color
                  ? "2px solid var(--wb-text)"
                  : "1px solid rgba(0,0,0,0.4)",
            }}
          />
        ))}
        <button
          type="button"
          aria-label="no accent (theme default)"
          title="none (theme default)"
          onClick={(e) => {
            e.stopPropagation();
            onPick(null);
          }}
          style={{
            width: 14,
            height: 14,
            padding: 0,
            cursor: "pointer",
            background: "transparent",
            color: "var(--wb-textDim2)",
            border: current == null ? "2px solid var(--wb-text)" : "1px solid var(--wb-border)",
            font: "10px var(--wb-mono)",
            lineHeight: 1,
          }}
        >
          ∅
        </button>
      </div>
    </>
  );
}

export default InstanceCard;
