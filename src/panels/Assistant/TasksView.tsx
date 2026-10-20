// The drawer's Tasks view (step D2): Duck's worker tasks, newest first, as an
// archive of results. Each row: the title, state, worker and time (and an API
// worker's cost), the headline, and ways on: open `result.md` in the editor, save
// it to the notes of the project you're in, open the worker's console, or go to
// the thread that asked for it. Takes the place of the thread while open.

import { useState } from "react";

import type { TaskView } from "../../assistant/protocol";
import { taskResult } from "../../ipc/assistant";
import { notesCreateWith } from "../../ipc/notes";
import { getActiveProject, setActiveProject, useActiveProject } from "../../state/activeProject";
import { openConsole } from "../../state/consoles";
import { activatePanel } from "../../state/dock";
import { openProjectFile } from "../../state/editors";
import { getRegistry } from "../../state/registry";
import { formatAgo } from "../../util/format";
import { closeTask, openThread, rerunTask, type DuckState } from "./duckState";
import { Shell } from "./TrustViews";

const STATE_COLOR: Record<string, string> = {
  queued: "var(--wb-working)",
  running: "var(--wb-working)",
  done: "var(--wb-accent)",
  closed: "var(--wb-textFaint)",
};

const same = (a: string, b: string) =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const resultPath = (t: TaskView) => `${t.folder}${t.folder.includes("\\") ? "\\" : "/"}result.md`;

/** The project whose editor shows a task's files: its own, the workspace's
 *  ("Duck"), else the one you're in. */
function editorProject(t: TaskView, workspace: string | null) {
  const { projects, instances } = getRegistry();
  const own = instances.find((i) => i.id === t.instanceId)?.projectId;
  return (
    projects.find((p) => p.id === own) ??
    (workspace ? projects.find((p) => same(p.rootPath, workspace)) : undefined) ??
    projects.find((p) => p.id === getActiveProject())
  );
}

function duration(t: TaskView): string {
  if (t.started === null) return "";
  const s = Math.max(0, Math.round(((t.finished ?? Date.now()) - t.started) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function Row({ t, onThread }: { t: TaskView; onThread: () => void }) {
  const active = useActiveProject();
  const [note, setNote] = useState<string | null>(null);
  const finished = !["queued", "running"].includes(t.state);
  const here = getRegistry().projects.find((p) => p.id === active);
  const inst = getRegistry().instances.find((i) => i.id === t.instanceId);
  const workspace = t.folder.replace(/[\\/]tasks[\\/][^\\/]+$/, "");

  const openResult = () => {
    const p = editorProject(t, workspace);
    if (!p) return setNote("no project to open it in");
    setActiveProject(p.id);
    openProjectFile({ projectId: p.id, rootPath: p.rootPath, label: p.name }, { path: resultPath(t), preview: true });
  };
  const save = async () => {
    if (!here) return;
    try {
      const r = await taskResult(workspace, t.folder);
      if (!r.md?.trim()) return setNote("it has no result.md");
      const n = await notesCreateWith(here.id, t.title, r.md);
      setNote(`saved as "${n.id}" in ${here.name}`);
    } catch (e) {
      setNote(`not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid var(--wb-border)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: "var(--wb-text)", fontWeight: 600 }}>{t.title}</span>
        <span style={{ color: STATE_COLOR[t.state] ?? "var(--wb-needs)" }}>{t.state.replace("_", " ")}</span>
        <span style={{ color: "var(--wb-textFaint)" }}>
          {t.runner === "api" ? "API · " : ""}
          {t.model} · {t.effort} · {t.kind}
          {duration(t) && ` · ${duration(t)}`}
          {t.runner === "api" && t.costUsd !== null && ` · $${t.costUsd.toFixed(2)}`}
          {t.started !== null && ` · ${formatAgo(Math.floor(t.started / 1000))}`}
        </span>
      </div>
      {t.headline && <div style={{ marginTop: 3, color: "var(--wb-textDim2)", whiteSpace: "pre-wrap" }}>{t.headline}</div>}
      <div style={{ marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
        {finished && (
          <button type="button" style={link} onClick={openResult}>
            open result
          </button>
        )}
        {finished && here && (
          <button type="button" style={link} onClick={() => void save()}>
            save to {here.name} notes
          </button>
        )}
        {inst && t.state !== "closed" && (
          <button
            type="button"
            style={link}
            onClick={() => {
              setActiveProject(inst.projectId);
              openConsole(inst);
              activatePanel(inst.id);
            }}
          >
            console
          </button>
        )}
        <button type="button" style={link} onClick={onThread}>
          thread
        </button>
        {t.tier !== "serious" && t.state !== "queued" && (
          <button type="button" style={link} onClick={() => rerunTask(t.id)}>
            re-run {t.tier === "standard" ? "involved" : "serious"}
          </button>
        )}
        {t.state !== "closed" && (
          <button type="button" style={link} onClick={() => closeTask(t.id)}>
            close
          </button>
        )}
      </div>
      {note && <div style={{ marginTop: 2, color: "var(--wb-textFaint)" }}>{note}</div>}
    </div>
  );
}

export function TasksPanel({ duck, onBack }: { duck: DuckState; onBack: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? duck.tasks : duck.tasks.filter((t) => t.state !== "closed");
  return (
    <Shell title="tasks" onBack={onBack}>
      <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--wb-textFaint)", marginBottom: 6 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        show closed
      </label>
      {shown.length === 0 && <div style={{ color: "var(--wb-textFaint)" }}>No tasks yet.</div>}
      {shown.map((t) => (
        <Row
          key={t.id}
          t={t}
          onThread={() => {
            openThread(t.threadId);
            onBack();
          }}
        />
      ))}
    </Shell>
  );
}

const link: React.CSSProperties = {
  padding: 0,
  font: "inherit",
  color: "var(--wb-accent)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};
