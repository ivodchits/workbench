// New-instance dialog (step 1.4; worktree provisioning wired in 2.4). Creates an
// instance under a project: a title, an optional task note, and the per-session
// worktree toggle (off by default, design §6 / decision 5). When the toggle is on,
// the instance is created at the project root first, then a worktree is provisioned
// (`git worktree add -b agent/<slug>`) and the instance repointed there — so a git
// failure leaves a usable root instance plus a clear error rather than a half-state.

import { useCallback, useState } from "react";
import { GLYPH } from "../../theme";
import type { Project } from "../../ipc/registry";
import { addInstance } from "../../state/registry";
import { provisionWorktree, slugify } from "../../state/worktree";
import Modal from "./Modal";

interface InstanceDialogProps {
  project: Project;
  onClose: () => void;
}

function InstanceDialog({ project, onClose }: InstanceDialogProps) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = title.trim().length > 0 && !busy;

  const save = useCallback(async () => {
    if (!canSave) {
      setError("A title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Always create at the project root; provisioning flips the flag on success,
      // so a failed `git worktree add` leaves a normal root instance, not a half-
      // configured one.
      const instance = await addInstance({
        projectId: project.id,
        title: title.trim(),
        taskNote: note.trim() || undefined,
        worktreeOn: false,
      });
      if (worktree) await provisionWorktree(instance, project);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }, [canSave, project, title, note, worktree, onClose]);

  return (
    <Modal title={`new instance · ${project.name}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <Field label="title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="e.g. fix-auth-redirect"
            spellCheck={false}
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label="task note">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            placeholder="what is it working on? (optional)"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
          />
          <span style={{ fontSize: 12.5, color: "var(--wb-text)" }}>
            <span style={{ color: "var(--wb-accent)" }}>{GLYPH.worktree}</span> isolate in a worktree
          </span>
        </label>
        <div style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)", marginTop: -6 }}>
          {worktree ? (
            <>
              creates branch{" "}
              <span style={{ color: "var(--wb-accent)" }}>
                agent/{slugify(title.trim() || "agent")}
              </span>{" "}
              in its own worktree
            </>
          ) : (
            "off by default — runs in the project root"
          )}
        </div>

        {error && <div style={{ color: "var(--wb-needs)", fontSize: 11.5 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={buttonStyle}>
            cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave}
            style={{
              ...buttonStyle,
              borderColor: "var(--wb-borderActive)",
              color: canSave ? "var(--wb-text)" : "var(--wb-textFaint)",
              opacity: canSave ? 1 : 0.6,
            }}
          >
            {GLYPH.ok} create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          font: "600 10px var(--wb-mono)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--wb-textDim2)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 8px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
};

const buttonStyle: React.CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default InstanceDialog;
