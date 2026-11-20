// Add / edit a project (step 1.3). Pick a folder, detect whether it's a git repo
// and its default branch, name it, and assign it to a group (existing or newly
// created). Persists through the registry store (which writes to SQLite).
//
// `project === undefined` ⇒ add mode; otherwise the form is prefilled for edit.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { GLYPH } from "../../theme";
import { detectRepo } from "../../ipc/git";
import {
  addProfile,
  listProfiles,
  personalProfile,
  removeProfile,
  type ClaudeProfile,
  type PersonalProfile,
} from "../../ipc/profiles";
import type { Group, Project } from "../../ipc/registry";
import { addGroup, addProject, updateProject } from "../../state/registry";
import { SESSION_MODELS } from "../../util/models";
import { usePermissionModes } from "../../util/permissionModes";
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
/** Profile select values: Personal (no profile) and "add one". */
const PERSONAL = "";
const NEW_PROFILE = "__new__";

function ProjectDialog({ project, groups, onClose }: ProjectDialogProps) {
  const editing = project !== undefined;

  // A remote project points at a host over SSH instead of a local folder (step
  // 3.12): the folder picker + git inspection are replaced by an SSH destination +
  // remote dir, and the worktree section (local-only) is hidden.
  const [remote, setRemote] = useState(project?.remoteSshDest != null);
  const [sshDest, setSshDest] = useState(project?.remoteSshDest ?? "");
  const [remoteDir, setRemoteDir] = useState(project?.remoteDir ?? "");

  const [path, setPath] = useState(project?.rootPath ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [branch, setBranch] = useState(project?.defaultBranch ?? "");
  const [groupChoice, setGroupChoice] = useState<string>(project?.groupId ?? NO_GROUP);
  const [newGroupName, setNewGroupName] = useState("");
  const [setupCommand, setSetupCommand] = useState(project?.worktreeSetupCommand ?? "");
  const [copyEnv, setCopyEnv] = useState(project?.worktreeCopyEnv ?? false);
  const [model, setModel] = useState(project?.defaultModel ?? "");
  const [permissionMode, setPermissionMode] = useState(project?.defaultPermissionMode ?? "");
  const permissionModes = usePermissionModes(permissionMode || null);
  const [profileChoice, setProfileChoice] = useState<string>(project?.profileId ?? PERSONAL);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [personal, setPersonal] = useState<PersonalProfile | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDir, setNewProfileDir] = useState("");
  const [seedProfile, setSeedProfile] = useState(true);
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

  const loadProfiles = useCallback(async () => {
    try {
      const [list, own] = await Promise.all([listProfiles(), personalProfile()]);
      setProfiles(list);
      setPersonal(own);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const browseProfileDir = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the profile's Claude config folder",
      defaultPath: newProfileDir || undefined,
    });
    if (typeof picked === "string") setNewProfileDir(picked);
  }, [newProfileDir]);

  const forgetProfile = useCallback(async () => {
    const p = profiles.find((x) => x.id === profileChoice);
    if (!p) return;
    const others = p.projectCount - (project?.profileId === p.id ? 1 : 0);
    const note = others > 0 ? ` ${others} other project(s) using it go back to Personal.` : "";
    if (!window.confirm(`Forget the profile "${p.name}"? Its folder stays on disk.${note}`)) return;
    try {
      await removeProfile(p.id);
      setProfileChoice(PERSONAL);
      await loadProfiles();
    } catch (e) {
      setError(String(e));
    }
  }, [profiles, profileChoice, project, loadProfiles]);

  // In edit mode, surface the git state of the existing path on open — local
  // projects only (a remote project's path lives on the host, not this disk).
  useEffect(() => {
    if (editing && project && !remote) void inspect(project.rootPath, false);
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

  const canSave = remote
    ? name.trim().length > 0 && sshDest.trim().length > 0 && remoteDir.trim().length > 0 && !busy
    : name.trim().length > 0 && path.trim().length > 0 && !busy;

  const save = useCallback(async () => {
    if (!canSave) {
      setError(
        remote
          ? "An SSH destination, a remote directory, and a name are required."
          : "A folder and a name are required.",
      );
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

      // Resolve the Claude profile the same way: add the new one first if asked.
      let profileId: string | null = profileChoice || null;
      if (profileChoice === NEW_PROFILE) {
        if (!newProfileName.trim()) throw new Error("Enter a name for the new profile.");
        if (!newProfileDir.trim()) throw new Error("Choose a config folder for the new profile.");
        profileId = (await addProfile(newProfileName, newProfileDir, seedProfile)).id;
      }

      // A remote project mirrors its remote dir into `rootPath` (so display code
      // that reads the root keeps working) and carries no local worktree config; a
      // local project clears the remote fields. Sending the remote fields explicitly
      // (string or null) keeps an edit that flips remote-ness consistent.
      const fields = remote
        ? {
            name: name.trim(),
            rootPath: remoteDir.trim(),
            defaultBranch: null,
            groupId,
            worktreeSetupCommand: null,
            worktreeCopyEnv: false,
            remoteSshDest: sshDest.trim(),
            remoteDir: remoteDir.trim(),
            defaultModel: model || null,
            defaultPermissionMode: permissionMode || null,
            profileId,
          }
        : {
            name: name.trim(),
            rootPath: path.trim(),
            defaultBranch: branch.trim() || null,
            groupId,
            worktreeSetupCommand: setupCommand.trim() || null,
            worktreeCopyEnv: copyEnv,
            remoteSshDest: null,
            remoteDir: null,
            defaultModel: model || null,
            defaultPermissionMode: permissionMode || null,
            profileId,
          };
      if (editing && project) {
        await updateProject(project.id, fields);
      } else {
        await addProject(fields);
      }
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }, [
    canSave,
    remote,
    sshDest,
    remoteDir,
    groupChoice,
    newGroupName,
    branch,
    editing,
    project,
    name,
    path,
    setupCommand,
    copyEnv,
    model,
    permissionMode,
    profileChoice,
    newProfileName,
    newProfileDir,
    seedProfile,
    onClose,
  ]);

  return (
    <Modal title={editing ? "edit project" : "add project"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {/* Remote (SSH) toggle (step 3.12). When on, the project lives on a host:
            agents run as tmux sessions there and only the console crosses SSH. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            font: "11.5px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            cursor: "pointer",
          }}
        >
          <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
          <span style={{ color: "var(--wb-accent)" }}>{GLYPH.remote}</span> remote (SSH) — run agents
          on a host over SSH + tmux
        </label>

        {remote ? (
          <>
            <Field label="ssh destination">
              <input
                value={sshDest}
                onChange={(e) => setSshDest(e.target.value)}
                placeholder="myserver  (or user@host — resolved via ~/.ssh/config)"
                spellCheck={false}
                style={inputStyle}
              />
              <span
                style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", marginTop: 4 }}
              >
                Auth, host, port, and keys come from your SSH config — Workbench manages no
                credentials.
              </span>
            </Field>
            <Field label="remote directory">
              <input
                value={remoteDir}
                onChange={(e) => setRemoteDir(e.target.value)}
                placeholder="/home/you/project"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
          </>
        ) : (
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
        )}

        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="project name"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        {!remote && (
          <Field label="default branch">
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="(none detected)"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>
        )}

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

        {/* The Claude profile (account) its consoles run under (profiles plan P1.1).
            Local only: a remote project's host has its own config. */}
        {!remote && (
          <Field label="claude profile">
            <div style={{ display: "flex", gap: 7 }}>
              <select
                value={profileChoice}
                onChange={(e) => setProfileChoice(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              >
                <option value={PERSONAL}>Personal{personal?.loggedIn === false ? " (not logged in)" : ""}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.loggedIn ? "" : " (not logged in)"}
                  </option>
                ))}
                <option value={NEW_PROFILE}>+ new profile…</option>
              </select>
              {profiles.some((p) => p.id === profileChoice) && (
                <button onClick={() => void forgetProfile()} style={buttonStyle} title="Forget this profile">
                  forget
                </button>
              )}
            </div>
            {profileChoice === NEW_PROFILE && (
              <>
                <input
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="profile name, e.g. Team"
                  spellCheck={false}
                  autoFocus
                  style={{ ...inputStyle, marginTop: 7 }}
                />
                <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
                  <input
                    value={newProfileDir}
                    onChange={(e) => setNewProfileDir(e.target.value)}
                    placeholder="config folder, e.g. ~/.claude-team"
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button onClick={() => void browseProfileDir()} style={buttonStyle}>
                    browse…
                  </button>
                </div>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    marginTop: 7,
                    font: "11.5px var(--wb-mono)",
                    color: "var(--wb-textDim2)",
                    cursor: "pointer",
                  }}
                  title="settings.json, CLAUDE.md, skills, agents, commands, rules, output styles, keybindings and your user MCP servers. Not your login, history or plugins."
                >
                  <input
                    type="checkbox"
                    checked={seedProfile}
                    onChange={(e) => setSeedProfile(e.target.checked)}
                  />
                  start a new folder as a copy of Personal's setup
                </label>
              </>
            )}
            <ProfileHint
              choice={profileChoice}
              profiles={profiles}
              personal={personal}
            />
          </Field>
        )}

        {/* The model new sessions start on (step M1); each session can pick its own
            on its card. */}
        <Field label="default model">
          <select value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle}>
            <option value="">(Claude Code's default)</option>
            {SESSION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {model && !(SESSION_MODELS as readonly string[]).includes(model) && (
              <option value={model}>{model}</option>
            )}
          </select>
        </Field>

        {/* The permission mode new sessions start in (step M4), from the modes the
            installed Claude Code lists; each session can pick its own on its card. */}
        <Field label="default permission mode">
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value)}
            style={inputStyle}
          >
            <option value="">(Claude Code's default)</option>
            {permissionModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>

        {/* Worktree post-create setup (step 2.5). Local-only — hidden for remote
            projects (no worktrees over SSH this step). Runs only when an instance
            flips its worktree toggle on — worktrees don't share .env / node_modules. */}
        {!remote && (
        <Field label="worktree setup">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              font: "11.5px var(--wb-mono)",
              color: "var(--wb-textDim2)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={copyEnv}
              onChange={(e) => setCopyEnv(e.target.checked)}
            />
            copy <code style={{ color: "var(--wb-accent)" }}>.env*</code> from the repo root
          </label>
          <input
            value={setupCommand}
            onChange={(e) => setSetupCommand(e.target.value)}
            placeholder="setup command, e.g. npm install (optional)"
            spellCheck={false}
            style={{ ...inputStyle, marginTop: 7 }}
          />
          <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", marginTop: 4 }}>
            Run in each new worktree before its console starts.
          </span>
        </Field>
        )}

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

function ProfileHint({
  choice,
  profiles,
  personal,
}: {
  choice: string;
  profiles: ClaudeProfile[];
  personal: PersonalProfile | null;
}) {
  const hint: CSSProperties = { font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", marginTop: 4 };
  if (choice === NEW_PROFILE) {
    return (
      <span style={hint}>
        A folder you already set up is used as it is; a new or empty one can start as a copy of
        Personal (plugins are installed again there). Consoles get it as CLAUDE_CONFIG_DIR, and the
        first one asks you to log in.
      </span>
    );
  }
  const p = profiles.find((x) => x.id === choice);
  const dir = p ? p.configDir : personal?.configDir;
  const loggedIn = p ? p.loggedIn : personal?.loggedIn;
  if (!dir) return null;
  return (
    <span style={hint}>
      {dir}
      {loggedIn === false && (
        <span style={{ color: "var(--wb-working)" }}>
          {" "}
          {GLYPH.warn} not logged in: the first console here will ask
        </span>
      )}
    </span>
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
