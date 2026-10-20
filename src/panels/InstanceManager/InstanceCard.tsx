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
import { INTERRUPT_KEY, ptyWrite } from "../../ipc/pty";
import { matchCommand } from "../../keyboard";
import { updateInstance } from "../../state/registry";
import { markInterrupted } from "../../state/status";
import { cancelQueued, useQueued } from "../../state/queue";
import { useTrustLine } from "../../state/trustLines";
import { useDuckTask } from "../../state/duckOwned";
import { useAutopilotBadge } from "../../state/autopilotBadges";
import { askForAutopilot, controlAutopilot, showDuckThread } from "../Assistant/duckState";
import { openQueueDialog } from "../queueDialogControl";
import { mergeStatus, relativeTime } from "./status";
import { contextWindowTokens, formatTokens, tokenBreakdown } from "../../util/format";
import { SESSION_MODELS } from "../../util/models";
import { usePermissionModes } from "../../util/permissionModes";
import InlineEdit from "./InlineEdit";

interface InstanceCardProps {
  instance: Instance;
  /** Live console state for this instance, or null when no console is open. */
  consoleStatus: ConsoleStatus | null;
  /** Live hook-fed status for this instance, or null when none (step 2.2). */
  live: LiveStatus | null;
  /** True when this worktree-off instance shares its working dir with another
   *  (step 2.6) — shows the non-blocking ⚠ "shared" warning + one-click isolate. */
  shared: boolean;
  /** True when the owning project is remote (step 3.12): the card badges as remote
   *  and hides local-only affordances (worktree, diff, queue, token readout). */
  isRemote: boolean;
  /** The SSH destination, for the remote badge (e.g. `ssh:myserver`). */
  remoteDest: string | null;
  /** The project's default model (step M1), shown when the instance has none. */
  projectModel: string | null;
  /** The project's default permission mode (step M4), likewise. */
  projectPermissionMode: string | null;
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
  isRemote,
  remoteDest,
  projectModel,
  projectPermissionMode,
  onActivate,
  onToggleWorktree,
  onReview,
  onKill,
}: InstanceCardProps) {
  const [hover, setHover] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [pickingAccent, setPickingAccent] = useState(false);
  const [pickingModel, setPickingModel] = useState(false);
  const model = instance.model ?? projectModel;
  const permissionMode = instance.permissionMode ?? projectPermissionMode;
  const view = mergeStatus(consoleStatus, live, instance.status);
  const queued = useQueued().get(instance.id) ?? null;
  const trustLine = useTrustLine(instance.id);
  const duckTask = useDuckTask(instance.id);
  const autopilot = useAutopilotBadge(instance.id);
  const dim = !live && !consoleStatus && instance.status === "closed";
  const showActions = hover || editingNote || editingTitle || pickingAccent || pickingModel;

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
        if (isRemote) break; // worktrees are local-only (step 3.12)
        onToggleWorktree();
        break;
      case "railDiff":
        if (isRemote) break; // no diff/review over SSH this step
        onReview();
        break;
      case "railOpenDir":
        if (isRemote) break; // the working dir is on the host, not this machine
        void openPath(instance.workingDir);
        break;
      case "railInterrupt":
        if (consoleStatus === "running") {
          void ptyWrite(instance.id, INTERRUPT_KEY);
          markInterrupted(instance.id); // interrupting fires no hook — update the dot ourselves
        }
        break;
      case "railQueue":
        // The prompt queue auto-sends on the Stop hook, which never fires for a
        // remote (hookless) session — so it's disabled for remote instances.
        if (!isRemote && consoleStatus === "running") openQueueDialog(instance.id);
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
            color: isRemote ? "var(--wb-accent)" : view.colorVar,
            fontSize: 12,
            width: 12,
            flex: "0 0 12px",
            textAlign: "center",
            lineHeight: 1,
          }}
          title={isRemote ? `remote — ${remoteDest ?? "ssh"}` : view.label}
        >
          {/* Remote sessions are hookless, so a live status dot would lie — show a
              static remote glyph in its place (step 3.12). */}
          {isRemote ? GLYPH.remote : view.spinning ? <Spinner size={12} color={view.colorVar} /> : view.glyph}
        </span>
        <span
          style={{
            color: "var(--wb-text)",
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "baseline",
            gap: 5,
          }}
        >
          {duckTask !== null && (
            <span
              title="Duck's worker: its news goes to Duck, not to you"
              style={{ font: "600 10px var(--wb-mono)", color: "var(--wb-accent)", flex: "0 0 auto" }}
            >
              duck ·
            </span>
          )}
          <InlineEdit
            value={instance.title}
            editing={editingTitle}
            onEditingChange={setEditingTitle}
            onCommit={(next) => void updateInstance(instance.id, { title: next })}
            required
            ariaLabel="rename instance"
            style={{ fontWeight: 600, fontSize: 13, color: "var(--wb-text)", flex: 1, minWidth: 0 }}
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
            {/* Worktree, queue, diff, and open-dir are local-only — hidden for a
                remote instance (step 3.12). */}
            {!isRemote && (
              <RowAction
                label={instance.worktreeOn ? "return to project root" : "isolate in a worktree"}
                onClick={onToggleWorktree}
                active={instance.worktreeOn}
                fontSize={16.5}
              >
                {GLYPH.worktree}
              </RowAction>
            )}
            {!isRemote && consoleStatus === "running" && (
              <RowAction label="queue a prompt (sends when the agent finishes)" onClick={() => openQueueDialog(instance.id)}>
                {GLYPH.queue}
              </RowAction>
            )}
            {/* Plan autopilot (P1): your own local sessions, while Claude Code runs. */}
            {!isRemote && duckTask === null && autopilot === null && consoleStatus === "running" && (
              <RowAction
                label="run its plan on autopilot (Duck reviews each step)"
                onClick={() => askForAutopilot(instance.id, instance.title)}
              >
                ⟳
              </RowAction>
            )}
            {!isRemote && (
              <RowAction label="review changes (diff)" onClick={onReview}>
                ±
              </RowAction>
            )}
            <RowAction
              label="model and permission mode"
              onClick={() => {
                setPickingAccent(false);
                setPickingModel((v) => !v);
              }}
              active={instance.model != null || instance.permissionMode != null}
            >
              ◇
            </RowAction>
            <RowAction
              label="accent color"
              onClick={() => {
                setPickingModel(false);
                setPickingAccent((v) => !v);
              }}
              active={instance.accent != null}
            >
              ◣
            </RowAction>
            <RowAction label="edit note" onClick={() => setEditingNote(true)}>
              ✎
            </RowAction>
            {!isRemote && (
              <RowAction label="open working dir" onClick={() => void openPath(instance.workingDir)}>
                🗀
              </RowAction>
            )}
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

      {pickingModel && (
        <LaunchPicker
          model={instance.model}
          projectModel={projectModel}
          permissionMode={instance.permissionMode}
          projectPermissionMode={projectPermissionMode}
          onPick={(patch) => void updateInstance(instance.id, patch)}
          onClose={() => setPickingModel(false)}
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

      {/* What Duck's trust watcher last did about a permission prompt here (T2). */}
      {trustLine && (
        <div
          title={trustLine.text}
          style={{
            margin: "2px 0 0 20px",
            font: "10.5px var(--wb-mono)",
            color: trustLine.acted ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          duck: {trustLine.text} · {relativeTime(Math.floor(trustLine.at / 1000))}
        </div>
      )}

      {/* Plan autopilot (P1): where it is, and its buttons. */}
      {autopilot && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 7,
            margin: "2px 0 0 20px",
            font: "10.5px var(--wb-mono)",
            color: autopilot.state === "paused" ? "var(--wb-needs)" : "var(--wb-textDim2)",
          }}
        >
          <span
            title={autopilot.why ?? autopilot.text}
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            ⟳ autopilot · {autopilot.text}
          </span>
          <RowAction
            label={autopilot.state === "paused" ? "resume the autopilot" : "pause the autopilot"}
            onClick={() => controlAutopilot(instance.id, autopilot.state === "paused" ? "resume" : "pause")}
          >
            {autopilot.state === "paused" ? "▶" : "❚❚"}
          </RowAction>
          <RowAction label="stop the autopilot" onClick={() => controlAutopilot(instance.id, "stop")}>
            ■
          </RowAction>
          <RowAction label="step log (Duck's thread)" onClick={() => showDuckThread(autopilot.threadId)}>
            ≡
          </RowAction>
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
          {isRemote ? (
            // No branch over SSH this step — show the remote destination instead.
            <span style={{ color: "var(--wb-accent)", display: "flex", alignItems: "center", gap: 4 }}>
              {GLYPH.remote} ssh:{remoteDest ?? "?"}
            </span>
          ) : (
            <>
              {instance.worktreeOn && (
                <span style={{ color: "var(--wb-accent)" }}>{GLYPH.worktree}</span>
              )}
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
            </>
          )}
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
        {model && (
          <span
            style={{
              flex: "0 0 auto",
              color: instance.model ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
            }}
            title={
              instance.model
                ? `runs on ${model}`
                : `runs on ${model} (the project's default)`
            }
          >
            {model}
          </span>
        )}
        {permissionMode && (
          <span
            style={{
              flex: "0 0 auto",
              color: instance.permissionMode ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
            }}
            title={
              instance.permissionMode
                ? `starts in ${permissionMode} mode`
                : `starts in ${permissionMode} mode (the project's default)`
            }
          >
            {permissionMode}
          </span>
        )}
        {/* Token readout comes from the transcript tailer, which doesn't reach a
            remote session (its transcript lives on the host) — hidden for remote. */}
        {!isRemote && (
          <span
            style={{ marginLeft: "auto", color: "var(--wb-textDim2)" }}
            title={tokenBreakdown(instance)}
          >
            {formatTokens(contextWindowTokens(instance))}
          </span>
        )}
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

/** The launch popover: a row for the model (step M1), the project's default or
 *  one of Claude Code's aliases, and a row for the permission mode (step M4), from
 *  the modes the installed Claude Code lists. A change applies at the session's
 *  next launch or resume; a running session keeps both until then (or switches
 *  with `/model` and Shift+Tab). */
function LaunchPicker({
  model,
  projectModel,
  permissionMode,
  projectPermissionMode,
  onPick,
  onClose,
}: {
  model: string | null;
  projectModel: string | null;
  permissionMode: string | null;
  projectPermissionMode: string | null;
  onPick: (patch: { model: string | null } | { permissionMode: string | null }) => void;
  onClose: () => void;
}) {
  const models: { value: string | null; label: string }[] = [
    { value: null, label: `default${projectModel ? ` (${projectModel})` : ""}` },
    ...SESSION_MODELS.map((m) => ({ value: m, label: m })),
  ];
  // A full model id set elsewhere (by Duck, say) stays visible as the current pick.
  if (model && !models.some((c) => c.value === model)) {
    models.push({ value: model, label: model });
  }
  const modes = [
    {
      value: null,
      label: `default${projectPermissionMode ? ` (${projectPermissionMode})` : ""}`,
    },
    ...usePermissionModes(permissionMode).map((m) => ({ value: m, label: m })),
  ];
  return (
    <>
      <div
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 50 }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        title="applies at the next launch or resume"
        style={{
          position: "absolute",
          top: 28,
          right: 11,
          zIndex: 51,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "5px 6px",
          background: "var(--wb-panel)",
          border: "1px solid var(--wb-border)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}
      >
        <PickerRow
          choices={models}
          current={model}
          onPick={(value) => onPick({ model: value })}
        />
        <PickerRow
          choices={modes}
          current={permissionMode}
          onPick={(value) => onPick({ permissionMode: value })}
        />
      </div>
    </>
  );
}

function PickerRow({
  choices,
  current,
  onPick,
}: {
  choices: { value: string | null; label: string }[];
  current: string | null;
  onPick: (value: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      {choices.map((c) => (
        <button
          key={c.value ?? ""}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPick(c.value);
          }}
          style={{
            padding: "2px 6px",
            cursor: "pointer",
            background: "transparent",
            font: "10.5px var(--wb-mono)",
            color: current === c.value ? "var(--wb-text)" : "var(--wb-textDim2)",
            border:
              current === c.value ? "1px solid var(--wb-accent)" : "1px solid transparent",
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export default InstanceCard;
