// Open a session in a worktree the project already has, instead of a new one: a
// new session there (the project's "new instance in a worktree…"), or an instance
// already on the rail moved there (from the "isolate in a worktree" dialog). Lists
// `git worktree list` with each one's branch, last commit and the sessions in it,
// and asks before a second running session goes into the same folder.
//
// Claude Code keeps conversations per folder, so this is also how a session that
// lost its worktree (killed, or brought back in the project root) gets back to its
// conversations: "continue its last conversation" resumes the newest one there.

import { useEffect, useState, type CSSProperties } from "react";

import Modal from "./Modal";
import { GLYPH } from "../../theme";
import type { Instance, Project } from "../../ipc/registry";
import { activatePanel } from "../../state/dock";
import { sessionYouStarted } from "../../state/registry";
import { startNewSession } from "../../state/remoteActions";
import { attachWorktree, projectWorktrees, sameDir, type WorktreeUse } from "../../state/worktree";

function ago(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function WorktreePicker({
  project,
  instance,
  onClose,
}: {
  project: Project;
  /** Move this instance there; null opens a new session. */
  instance: Instance | null;
  onClose: () => void;
}) {
  const [list, setList] = useState<WorktreeUse[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [resume, setResume] = useState(true);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void projectWorktrees(project)
      .then((l) => {
        if (!alive) return;
        setList(l);
        // Preselect the first one nobody is running in.
        const free = l.find((w) => !w.missing && !others(w, instance).live.length);
        setPicked(free?.path ?? null);
      })
      .catch((e) => alive && setLoadError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [project, instance]);

  const chosen = list?.find((w) => w.path === picked) ?? null;
  const running = chosen ? others(chosen, instance).live : [];
  const needsShare = running.length > 0;

  const confirm = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      if (instance) {
        await attachWorktree(instance, project, chosen.path, { share: needsShare, resume });
        activatePanel(instance.id);
      } else {
        const { instance: made } = await startNewSession(project, {
          existingWorktree: chosen.path,
          shareWorktree: needsShare,
          resume,
        });
        sessionYouStarted(made);
      }
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title={instance ? "move to an existing worktree" : "new instance in a worktree"} onClose={onClose} width={560}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        {instance ? (
          <>
            Point <strong style={{ color: "var(--wb-accent)" }}>{instance.title}</strong> at one of{" "}
            {project.name}'s worktrees. It works there and finds the conversations it had there; the
            worktree stays when the instance goes.
          </>
        ) : (
          <>
            Open a new instance of <strong style={{ color: "var(--wb-accent)" }}>{project.name}</strong> in
            a worktree it already has, on that worktree's branch. The worktree stays when the instance goes.
          </>
        )}

        <div style={{ marginTop: 10, maxHeight: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {loadError ? (
            <div style={{ color: "var(--wb-needs)", fontSize: 11.5 }}>
              {GLYPH.warn} {loadError}
            </div>
          ) : !list ? (
            <div style={{ color: "var(--wb-textDim2)", fontSize: 11.5 }}>reading worktrees…</div>
          ) : list.length === 0 ? (
            <div style={{ color: "var(--wb-textDim2)", fontSize: 11.5 }}>
              {project.name} has no worktrees besides its own folder.
            </div>
          ) : (
            list.map((w) => <Row key={w.path} w={w} instance={instance} checked={w.path === picked} onPick={() => {
              setPicked(w.path);
              setShare(false);
            }} />)
          )}
        </div>

        {chosen && (
          <label style={{ ...checkStyle, marginTop: 10 }}>
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            continue its last conversation there (else start a fresh one)
          </label>
        )}
        {needsShare && (
          <label style={{ ...checkStyle, color: "var(--wb-working)" }}>
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            {GLYPH.warn} {running.map((i) => `"${i.title}"`).join(", ")} {running.length === 1 ? "is" : "are"} running
            in this worktree: two sessions in one folder can overwrite each other's edits. Share it anyway.
          </label>
        )}
        {instance && chosen && !sameDir(instance.workingDir, chosen.path) && (
          <div style={{ marginTop: 6, color: "var(--wb-textDim2)", fontSize: 11.5 }}>
            If its console is running, it restarts in the worktree.
          </div>
        )}
        {error && (
          <div style={{ marginTop: 8, color: "var(--wb-needs)", fontFamily: "var(--wb-mono)", fontSize: 11.5 }}>
            {GLYPH.fail} {error}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={buttonStyle}>
          cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy || !chosen || (needsShare && !share)}
          style={{ ...buttonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : `${GLYPH.worktree} ${instance ? "move" : "open"}`}
        </button>
      </div>
    </Modal>
  );
}

/** The worktree's sessions besides `instance` itself. */
function others(w: WorktreeUse, instance: Instance | null) {
  const not = (i: Instance) => i.id !== instance?.id;
  return { sessions: w.sessions.filter(not), live: w.live.filter(not) };
}

function Row({
  w,
  instance,
  checked,
  onPick,
}: {
  w: WorktreeUse;
  instance: Instance | null;
  checked: boolean;
  onPick: () => void;
}) {
  const { sessions, live } = others(w, instance);
  const here = !!instance && sameDir(instance.workingDir, w.path);
  return (
    <label
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "6px 8px",
        border: `1px solid ${checked ? "var(--wb-borderActive)" : "var(--wb-border)"}`,
        background: checked ? "var(--wb-sel)" : "transparent",
        cursor: w.missing ? "not-allowed" : "pointer",
        opacity: w.missing ? 0.45 : 1,
      }}
    >
      <input type="radio" checked={checked} disabled={w.missing} onChange={onPick} style={{ marginTop: 2 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--wb-mono)", color: "var(--wb-accent)" }}>
          {w.branch ?? `(detached at ${w.head})`}
          {w.locked && <span style={{ color: "var(--wb-textFaint)", fontWeight: 400 }}> · locked</span>}
          {w.missing && <span style={{ color: "var(--wb-needs)", fontWeight: 400 }}> · gone from disk</span>}
        </span>
        <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textDim2)", overflowWrap: "anywhere" }}>
          {w.head} {w.subject}
          {w.committedAt !== null && <span style={{ color: "var(--wb-textFaint)" }}> · {ago(w.committedAt)}</span>}
        </span>
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", overflowWrap: "anywhere" }}>{w.path}</span>
        {(here || sessions.length > 0) && (
          <span style={{ font: "10.5px var(--wb-mono)", color: live.length ? "var(--wb-working)" : "var(--wb-textDim2)" }}>
            {here && "this instance is here"}
            {here && sessions.length > 0 && " · "}
            {sessions.length > 0 &&
              `used by ${sessions
                .map((i) => `"${i.title}"${live.some((l) => l.id === i.id) ? " (running)" : ""}`)
                .join(", ")}`}
          </span>
        )}
      </span>
    </label>
  );
}

const checkStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "flex-start",
  marginTop: 6,
  fontSize: 11.5,
  color: "var(--wb-textDim2)",
  cursor: "pointer",
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
