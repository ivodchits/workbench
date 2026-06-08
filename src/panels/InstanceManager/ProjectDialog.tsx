// Add / edit a project (step 1.3). Pick a folder, detect whether it's a git repo
// and its default branch, name it, and assign it to a group (existing or newly
// created). Persists through the registry store (which writes to SQLite).
//
// `project === undefined` ⇒ add mode; otherwise the form is prefilled for edit.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { GLYPH } from "../../theme";
import { detectRepo } from "../../ipc/git";
import type { Group, Project } from "../../ipc/registry";
import { addGroup, addProject, updateProject } from "../../state/registry";
import Modal from "./Modal";

interface ProjectDialogProps {
  /** Existing project to edit; omit for the add flow. */
  project?: Project;
  groups: Group[];
  onClose: () => void;
}

/** Sentinel select values that aren't real group ids. */
const NO_GROUP = "__none__";
const NEW_GROUP = "__new__";

function ProjectDialog({ project, groups, onClose }: ProjectDialogProps) {
  const editing = project !== undefined;

  const [path, setPath] = useState(project?.rootPath ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [branch, setBranch] = useState(project?.defaultBranch ?? "");
  const [groupChoice, setGroupChoice] = useState<string>(project?.groupId ?? NO_GROUP);
  const [newGroupName, setNewGroupName] = useState("");
  const [gitRepo, setGitRepo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inspect a folder and prefill name/branch from it. Only overwrite the name
  // when the user hasn't typed one, so re-detecting on edit doesn't clobber it.
  const inspect = useCallback(
    async (dir: string, force: boolean) => {
      try {
        const info = await detectRepo(dir);
        setGitRepo(info.isGitRepo);
        if (info.defaultBranch && (force || !branch)) setBranch(info.defaultBranch);
        if (info.suggestedName && (force || !name)) setName(info.suggestedName);
      } catch (e) {
        setGitRepo(null);
        setError(String(e));
      }
    },
    [branch, name],
  );

  // In edit mode, surface the git state of the existing path on open.
  useEffect(() => {
    if (editing && project) void inspect(project.rootPath, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const browse = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a project folder",
      defaultPath: path || undefined,
    });
    if (typeof picked === "string") {
      setPath(picked);
      setError(null);
      // A fresh pick should drive name + branch even over prior values.
      await inspect(picked, true);
    }
  }, [path, inspect]);

  const canSave = name.trim().length > 0 && path.trim().length > 0 && !busy;

  const save = useCallback(async () => {
    if (!canSave) {
      setError("A folder and a name are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Resolve the group: create a new one first if requested.
      let groupId: string | null = null;
      if (groupChoice === NEW_GROUP) {
        const trimmed = newGroupName.trim();
        if (!trimmed) throw new Error("Enter a name for the new group.");
        groupId = (await addGroup(trimmed)).id;
      } else if (groupChoice !== NO_GROUP) {
        groupId = groupChoice;
      }

      const branchValue = branch.trim() || null;
      if (editing && project) {
        await updateProject(project.id, {
          name: name.trim(),
          rootPath: path.trim(),
          defaultBranch: branchValue,
          groupId,
        });
      } else {
        await addProject({
          name: name.trim(),
          rootPath: path.trim(),
          defaultBranch: branchValue,
          groupId,
        });
      }
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }, [canSave, groupChoice, newGroupName, branch, editing, project, name, path, onClose]);

  return (
    <Modal title={editing ? "edit project" : "add project"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <Field label="folder">
          <div style={{ display: "flex", gap: 7 }}>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onBlur={() => path.trim() && void inspect(path.trim(), false)}
              placeholder="C:\path\to\repo"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={browse} style={buttonStyle}>
              browse…
            </button>
          </div>
          <GitHint gitRepo={gitRepo} />
        </Field>

        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="project name"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        <Field label="default branch">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="(none detected)"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        <Field label="group">
          <select
            value={groupChoice}
            onChange={(e) => setGroupChoice(e.target.value)}
            style={inputStyle}
          >
            <option value={NO_GROUP}>(no group)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value={NEW_GROUP}>+ new group…</option>
          </select>
          {groupChoice === NEW_GROUP && (
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="new group name"
              spellCheck={false}
              autoFocus
              style={{ ...inputStyle, marginTop: 7 }}
            />
          )}
        </Field>

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
            {GLYPH.ok} {editing ? "save" : "add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GitHint({ gitRepo }: { gitRepo: boolean | null }) {
  if (gitRepo === null) return null;
  return gitRepo ? (
    <div style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-done)", marginTop: 5 }}>
      {GLYPH.ok} git repository detected
    </div>
  ) : (
    <div style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-working)", marginTop: 5 }}>
      {GLYPH.warn} not a git repository — worktrees will be unavailable
    </div>
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

export default ProjectDialog;
