// Skill Manager panel (step 3.7b — design §7 "Skill/plugin awareness"). Bound to a
// project via the skills store; the binding (repo root) is all the state, so the
// panel re-fetches the skill list from the backend on mount / refresh / after each
// edit rather than caching it.
//
// Layout: skills grouped by scope (project · user · plugin), each row showing its
// frontmatter validity (kebab `name` + non-empty `description`), description, and
// actions — "try it" (insert `/<name>` into the focused console so you can iterate
// on the description until it triggers), "edit" (open SKILL.md in the editor with
// markdown preview, steps 1.8/1.9), and "remove" (project/user only; behind a
// confirm). Plugin skills are read-only (awareness, not editing). Creating a skill
// scaffolds a valid SKILL.md and opens it for editing. Unlike the MCP manager
// (3.7), every write here is a plain filesystem op — no CLI, no shared-JSON risk.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import { skillList, skillRemove, type Skill, type SkillScope } from "../../ipc/skills";
import { useSkills, type SkillSession } from "../../state/skills";
import { openProjectFile } from "../../state/editors";
import { getActiveConsoleId, useConsoles } from "../../state/consoles";
import { pasteIntoTerminal } from "../terminalPool";
import Modal from "../InstanceManager/Modal";
import SkillDialog from "./SkillDialog";

export interface SkillPanelParams {
  skillId: string;
}

const SCOPE_ORDER: SkillScope[] = ["project", "user", "plugin"];

const SCOPE_BLURB: Record<SkillScope, string> = {
  project: "this repo · .claude/skills (shareable)",
  user: "global, every project · ~/.claude/skills",
  plugin: "bundled by an installed plugin · read-only",
};

export function SkillManagerPanel(props: IDockviewPanelProps<SkillPanelParams>) {
  const { skillId } = props.params;
  const { open } = useSkills();
  const session = open.find((s) => s.skillId === skillId) ?? null;

  const title = session ? `skills · ${session.title}` : "skills";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) return <Missing />;
  return <SkillBody session={session} />;
}

type Dialog = { kind: "new" } | { kind: "remove"; skill: Skill };

function SkillBody({ session }: { session: SkillSession }) {
  const { repoRoot, projectId, title } = session;
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // A running console can receive a "try it" insertion; track which is focused.
  const { open: consoles } = useConsoles();
  const runningIds = useMemo(
    () => new Set(consoles.filter((c) => c.status === "running").map((c) => c.instanceId)),
    [consoles],
  );
  const activeId = getActiveConsoleId();
  const tryTarget =
    (activeId && runningIds.has(activeId) && activeId) ||
    [...runningIds][0] ||
    null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await skillList(repoRoot));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
      setSkills(null);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const byScope = useMemo(() => {
    const map = new Map<SkillScope, Skill[]>();
    for (const s of skills ?? []) {
      const arr = map.get(s.scope) ?? [];
      arr.push(s);
      map.set(s.scope, arr);
    }
    return map;
  }, [skills]);

  // Open a skill's SKILL.md in the project editor (markdown preview on). The path
  // may sit outside the project root (user/plugin scope) — the editor opens any
  // absolute path as a tab, so this works regardless of the file-tree scope.
  const editSkill = useCallback(
    (skill: Skill) => {
      openProjectFile(
        { projectId, rootPath: repoRoot, label: title },
        { path: skill.skillPath, preview: true },
      );
    },
    [projectId, repoRoot, title],
  );

  // Insert `/<name>` into the focused running console so you can fire the skill and
  // tune its description until it triggers (design §7). Inserted, not sent — you
  // review then press Enter.
  const trySkill = useCallback(
    (skill: Skill) => {
      if (tryTarget) pasteIntoTerminal(tryTarget, `/${skill.name}`);
    },
    [tryTarget],
  );

  const total = skills?.length ?? 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}>
      <Header total={total} loading={loading} onNew={() => setDialog({ kind: "new" })} onRefresh={() => void load()} />

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {loadError ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
            {GLYPH.warn} {loadError}
          </div>
        ) : skills && total === 0 ? (
          <Empty />
        ) : (
          SCOPE_ORDER.map((scope) => {
            const list = byScope.get(scope);
            if (!list || list.length === 0) return null;
            return (
              <ScopeSection
                key={scope}
                scope={scope}
                skills={list}
                tryEnabled={tryTarget !== null}
                onTry={trySkill}
                onEdit={editSkill}
                onRemove={(skill) => setDialog({ kind: "remove", skill })}
              />
            );
          })
        )}

        {skills && total > 0 && <Footnote />}
      </div>

      {dialog?.kind === "new" && (
        <SkillDialog
          projectRoot={repoRoot}
          onClose={() => setDialog(null)}
          onCreated={(path) => {
            void load();
            // Open the fresh SKILL.md so you can flesh it out immediately.
            openProjectFile({ projectId, rootPath: repoRoot, label: title }, { path, preview: true });
          }}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemoveConfirm
          projectRoot={repoRoot}
          skill={dialog.skill}
          onClose={() => setDialog(null)}
          onRemoved={() => void load()}
        />
      )}
    </div>
  );
}

function Header({
  total,
  loading,
  onNew,
  onRefresh,
}: {
  total: number;
  loading: boolean;
  onNew: () => void;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-text)" }}>
        {loading && total === 0 ? "reading…" : `${total} skill${total === 1 ? "" : "s"}`}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <HeaderButton onClick={onNew} accent>
          + new skill
        </HeaderButton>
        <HeaderButton onClick={onRefresh} disabled={loading}>
          ↻ refresh
        </HeaderButton>
      </span>
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  accent,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--wb-textFaint)" : accent ? "var(--wb-accent)" : "var(--wb-textDim2)",
        font: "11px var(--wb-mono)",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function ScopeSection({
  scope,
  skills,
  tryEnabled,
  onTry,
  onEdit,
  onRemove,
}: {
  scope: SkillScope;
  skills: Skill[];
  tryEnabled: boolean;
  onTry: (skill: Skill) => void;
  onEdit: (skill: Skill) => void;
  onRemove: (skill: Skill) => void;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "8px 14px 4px" }}>
        <span
          style={{
            font: "600 10.5px var(--wb-mono)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--wb-accent)",
          }}
        >
          {scope}
        </span>
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
          {SCOPE_BLURB[scope]}
        </span>
      </div>
      {skills.map((s) => (
        <SkillRow
          key={`${s.scope}:${s.name}`}
          skill={s}
          tryEnabled={tryEnabled}
          onTry={() => onTry(s)}
          onEdit={() => onEdit(s)}
          onRemove={() => onRemove(s)}
        />
      ))}
    </div>
  );
}

function SkillRow({
  skill,
  tryEnabled,
  onTry,
  onEdit,
  onRemove,
}: {
  skill: Skill;
  tryEnabled: boolean;
  onTry: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  const readOnly = skill.scope === "plugin";
  const detail = skill.description?.trim() || (skill.plugin ? `from ${skill.plugin}` : "—");

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 14px" }}
    >
      <span
        title={skill.valid ? "frontmatter ok" : skill.problems.join("\n")}
        style={{
          flex: "0 0 auto",
          width: 14,
          textAlign: "center",
          font: "11px var(--wb-mono)",
          color: skill.valid ? "var(--wb-done)" : "var(--wb-working)",
        }}
      >
        {skill.valid ? GLYPH.ok : GLYPH.warn}
      </span>
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span
            style={{
              font: "12.5px var(--wb-mono)",
              color: "var(--wb-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            /{skill.name}
          </span>
          {readOnly && (
            <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)", flex: "0 0 auto" }}>
              read-only
            </span>
          )}
          {!skill.valid && (
            <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-working)", flex: "0 0 auto" }}>
              {skill.problems.length} issue{skill.problems.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span
          style={{
            font: "10.5px var(--wb-mono)",
            color: "var(--wb-textFaint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={skill.problems.length > 0 ? skill.problems.join("\n") : detail}
        >
          {detail}
        </span>
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 9, visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={onTry} label={tryEnabled ? "insert /name into the focused console" : "no running console"} disabled={!tryEnabled}>
          {GLYPH.run} try
        </RowAction>
        <RowAction onClick={onEdit} label={readOnly ? "view SKILL.md" : "edit SKILL.md"}>
          {readOnly ? "view" : "✎"}
        </RowAction>
        {!readOnly && (
          <RowAction onClick={onRemove} label="remove skill" danger>
            {GLYPH.fail}
          </RowAction>
        )}
      </span>
    </div>
  );
}

function RowAction({
  children,
  onClick,
  label,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        lineHeight: 1,
        font: "11px var(--wb-mono)",
        color: disabled
          ? "var(--wb-textFaint)"
          : danger
            ? "var(--wb-needs)"
            : "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

function RemoveConfirm({
  projectRoot,
  skill,
  onClose,
  onRemoved,
}: {
  projectRoot: string;
  skill: Skill;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await skillRemove(projectRoot, skill.scope, skill.name);
      onRemoved();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  return (
    <Modal title="remove skill" onClose={onClose} width={400}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Delete <strong style={{ color: "var(--wb-accent)" }}>/{skill.name}</strong> from the{" "}
        <strong style={{ color: "var(--wb-accent)" }}>{skill.scope}</strong> scope? This removes its
        folder and <code>SKILL.md</code> from disk.
        {error && (
          <div style={{ marginTop: 8, color: "var(--wb-needs)", font: "11.5px var(--wb-mono)", whiteSpace: "pre-wrap" }}>
            {GLYPH.fail} {error}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
        >
          {GLYPH.fail} delete
        </button>
      </div>
    </Modal>
  );
}

/** The skill-frontmatter footnote (design §7 / plan step 3.7b). */
function Footnote() {
  return (
    <div
      style={{
        margin: "10px 14px 16px",
        padding: "9px 11px",
        border: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        font: "10px/1.55 var(--wb-mono)",
        color: "var(--wb-textFaint)",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <span>
        {GLYPH.run} a skill triggers on its <strong style={{ color: "var(--wb-textDim2)" }}>description</strong> —
        use “try” to fire <code>/name</code> and tune it until Claude reaches for it.
      </span>
      <span>
        {GLYPH.warn} the <strong style={{ color: "var(--wb-textDim2)" }}>name</strong> must be kebab-case and
        match the folder; an empty description won’t match.
      </span>
    </div>
  );
}

function Empty() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "13px var(--wb-mono)" }}>no skills</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}>
        create one with “+ new skill” — a folder + <code>SKILL.md</code> under{" "}
        <code>.claude/skills</code>
      </div>
    </div>
  );
}

function Missing() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} this panel is gone</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close it</div>
    </div>
  );
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  background: "var(--wb-bg)",
};

const confirmButtonStyle: React.CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default SkillManagerPanel;
