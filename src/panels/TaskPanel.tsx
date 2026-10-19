// Task panel (step K1) — a project toolbar action running in a terminal of its own:
// the argv from the project's plugin file, spawned directly in a PTY (no shell in
// between). Built like the Shell panel: a header (what ran, where), the pooled
// terminal while there is a run, and a footer with the run's state and the
// stop / run again buttons. The terminal is keyed on the run number, so running
// again starts on a clean screen in the same panel.

import { useCallback, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH, Spinner } from "../theme";
import Console from "./Console";
import type { SpawnResult, TaskSpawn } from "../ipc/pty";
import { markTaskError, markTaskSpawned, useTasks, type TaskSession } from "../state/tasks";
import { runPluginAction, stopTask } from "./pluginRun";

export interface TaskPanelParams {
  taskId: string;
}

function TaskPanel(props: IDockviewPanelProps<TaskPanelParams>) {
  const { taskId } = props.params;
  const { open } = useTasks();
  const task = open.find((t) => t.taskId === taskId) ?? null;

  const title = task ? `task · ${task.label}` : "task";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!task) {
    return (
      <div style={centeredBody}>
        <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} this task is gone</div>
        <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close this panel</div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Header task={task} />
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {task.status === "error" ? (
          // A failed spawn has no terminal; mounting one again would retry it.
          <div style={centeredBody}>
            <div style={{ color: "var(--wb-needs)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} could not start {task.label}</div>
            <div style={{ color: "var(--wb-textDim2)", font: "11px var(--wb-mono)", maxWidth: 520, textAlign: "center", whiteSpace: "pre-wrap" }}>
              {task.error ?? "unknown error"}
            </div>
          </div>
        ) : task.spawn ? (
          <LiveTask key={task.run} taskId={taskId} run={task.run} spawn={task.spawn} />
        ) : (
          <div style={centeredBody}>
            <div style={{ color: "var(--wb-textDim2)", font: "12.5px var(--wb-mono)" }}>
              <span style={{ color: "var(--wb-closed)" }}>○</span> {task.label} — not running
            </div>
            <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>restored from your saved layout</div>
          </div>
        )}
      </div>
      <Footer task={task} />
    </div>
  );
}

/** The run's terminal. Mounted per run (keyed by the caller), so its spawn request
 *  and callbacks stay fixed for the run's life. */
function LiveTask({ taskId, run, spawn }: { taskId: string; run: number; spawn: TaskSpawn }) {
  const onSpawned = useCallback((r: SpawnResult) => markTaskSpawned(taskId, run, r), [taskId, run]);
  const onError = useCallback((m: string) => markTaskError(taskId, run, m), [taskId, run]);
  return (
    <Console
      instanceId={taskId}
      kind="task"
      cwd=""
      webgl={false}
      resumeSessionId={null}
      remote={null}
      task={spawn}
      onSpawned={onSpawned}
      onError={onError}
    />
  );
}

/** label · the argv that ran · its working dir. */
function Header({ task }: { task: TaskSession }) {
  const argv = task.argv ? task.argv.map(quoteForDisplay).join(" ") : null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 13px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--wb-text)", fontWeight: 600, flex: "0 0 auto" }}>{task.label}</span>
      {argv && (
        <span title={argv} style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
          <span style={{ color: "var(--wb-accent)" }}>{GLYPH.prompt}</span> {argv}
        </span>
      )}
      {task.cwd && (
        <span
          title={task.cwd}
          style={{ color: "var(--wb-textFaint)", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, marginLeft: "auto" }}
        >
          {task.cwd}
        </span>
      )}
    </div>
  );
}

function Footer({ task }: { task: TaskSession }) {
  const live = task.status === "spawning" || task.status === "running";
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10.5px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        minWidth: 0,
      }}
    >
      <RunState task={task} />
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, flex: "0 0 auto" }}>
        {live && (
          <FooterButton onClick={() => stopTask(task.taskId)}>
            <span style={{ color: "var(--wb-needs)" }}>■</span> stop
          </FooterButton>
        )}
        <FooterButton onClick={() => void runPluginAction(task.projectId, task.pluginId, task.actionId)}>
          <span style={{ color: "var(--wb-accent)" }}>{GLYPH.run}</span> {task.status === "dormant" ? "run" : "run again"}
        </FooterButton>
      </span>
    </div>
  );
}

/** The run's state in words: what the toolbar button shows as a glyph. */
export function RunState({ task }: { task: TaskSession }) {
  switch (task.status) {
    case "dormant":
      return <span style={{ color: "var(--wb-textFaint)" }}>not running</span>;
    case "spawning":
      return (
        <span style={{ color: "var(--wb-working)" }}>
          <Spinner size={10} /> starting
        </span>
      );
    case "running":
      return (
        <span style={{ color: "var(--wb-working)" }}>
          <Spinner size={10} /> running
        </span>
      );
    case "exited":
      return task.code === 0 ? (
        <span style={{ color: "var(--wb-done)" }}>{GLYPH.ok} exited 0</span>
      ) : (
        <span style={{ color: "var(--wb-needs)" }}>
          {GLYPH.fail} exited {task.code}
        </span>
      );
    case "stopped":
      return <span style={{ color: "var(--wb-textDim2)" }}>■ stopped</span>;
    case "error":
      return (
        <span title={task.error ?? ""} style={{ color: "var(--wb-needs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {GLYPH.warn} {task.error ?? "could not start"}
        </span>
      );
  }
}

function FooterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "1px solid var(--wb-border)",
        color: "var(--wb-textDim2)",
        font: "10px var(--wb-mono)",
        padding: "2px 9px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** An argument as you'd type it: quoted when it holds a space or is empty. */
function quoteForDisplay(arg: string): string {
  return arg === "" || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

const centeredBody: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: 24,
  background: "var(--wb-bg)",
};

export default TaskPanel;
