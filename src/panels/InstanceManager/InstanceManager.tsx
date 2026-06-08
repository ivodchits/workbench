// Instance Manager rail (step 1.3 — project registry slice).
//
// The left rail from the design mockup. This step builds the Group → Project
// tree with full project CRUD (add via folder picker, edit, remove) and group
// assignment/creation. The instance rows, task notes, status dots, and row
// actions hang off each project in step 1.4 — the tree shape here is built to
// accept them.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Panel from "../../theme/Panel";
import { GLYPH } from "../../theme";
import type { Group, Project } from "../../ipc/registry";
import { deleteProject, loadRegistry, useRegistry } from "../../state/registry";
import ProjectDialog from "./ProjectDialog";
import Modal from "./Modal";

/** A group with its projects, plus a synthetic "ungrouped" bucket (id `null`). */
interface GroupSection {
  group: Group | null;
  projects: Project[];
}

function InstanceManager() {
  const { groups, projects, loaded, error } = useRegistry();
  const [adding, setAdding] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Project | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadRegistry();
  }, []);

  // Bucket projects under their group; ungrouped projects sort last.
  const sections = useMemo<GroupSection[]>(() => {
    const byGroup = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const p of projects) {
      if (p.groupId) {
        const arr = byGroup.get(p.groupId) ?? [];
        arr.push(p);
        byGroup.set(p.groupId, arr);
      } else {
        ungrouped.push(p);
      }
    }
    const out: GroupSection[] = groups.map((g) => ({
      group: g,
      projects: byGroup.get(g.id) ?? [],
    }));
    if (ungrouped.length > 0) out.push({ group: null, projects: ungrouped });
    return out;
  }, [groups, projects]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const isEmpty = loaded && projects.length === 0;

  return (
    <>
      <Panel
        title="projects"
        style={{ width: 322, flex: "0 0 322px" }}
        bodyStyle={{ padding: "14px 0 0" }}
      >
        {error && (
          <div
            style={{
              margin: "0 12px 8px",
              padding: "6px 10px",
              border: "1px solid var(--wb-needs)",
              color: "var(--wb-needs)",
              font: "11px var(--wb-mono)",
            }}
          >
            {GLYPH.warn} {error}
          </div>
        )}

        <div style={{ overflow: "auto", flex: 1 }}>
          {!loaded && <Hint>loading…</Hint>}
          {isEmpty && (
            <div style={{ padding: "10px 16px", color: "var(--wb-textDim2)", fontSize: 12 }}>
              No projects yet. Add a folder to get started.
            </div>
          )}

          {sections.map((sec) => {
            const key = sec.group?.id ?? "__ungrouped__";
            const label = sec.group?.name ?? "ungrouped";
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} style={{ marginBottom: 4 }}>
                <button onClick={() => toggle(key)} style={groupHeaderStyle}>
                  <span style={{ color: "var(--wb-textFaint)" }}>{isCollapsed ? "▸" : "▾"}</span>
                  <span style={{ color: sec.group ? "var(--wb-accent)" : "var(--wb-textDim2)" }}>
                    {label}
                  </span>
                  <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)", letterSpacing: 0 }}>
                    {sec.projects.length}
                  </span>
                </button>
                {!isCollapsed &&
                  sec.projects.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      onEdit={() => setEditTarget(p)}
                      onRemove={() => setRemoveTarget(p)}
                    />
                  ))}
              </div>
            );
          })}
        </div>

        <button onClick={() => setAdding(true)} style={footerActionStyle}>
          <span style={{ color: "var(--wb-accent)" }}>+</span> add project
          <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>p</span>
        </button>
      </Panel>

      {adding && <ProjectDialog groups={groups} onClose={() => setAdding(false)} />}
      {editTarget && (
        <ProjectDialog
          project={editTarget}
          groups={groups}
          onClose={() => setEditTarget(null)}
        />
      )}
      {removeTarget && (
        <RemoveConfirm project={removeTarget} onClose={() => setRemoveTarget(null)} />
      )}
    </>
  );
}

interface ProjectRowProps {
  project: Project;
  onEdit: () => void;
  onRemove: () => void;
}

function ProjectRow({ project, onEdit, onRemove }: ProjectRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 12px 5px 22px",
        font: "11.5px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        background: hover ? "var(--wb-sel)" : "transparent",
      }}
    >
      <span style={{ color: "var(--wb-textFaint)" }}>▾</span>
      <span
        style={{
          color: "var(--wb-text)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={project.rootPath}
      >
        {project.name}
      </span>
      {project.defaultBranch && (
        <span style={{ color: "var(--wb-textFaint)", fontSize: 10, flex: "0 0 auto" }}>
          ⌥ {project.defaultBranch}
        </span>
      )}
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, visibility: hover ? "visible" : "hidden" }}>
        <RowAction label="edit" onClick={onEdit}>
          edit
        </RowAction>
        <RowAction label="remove" onClick={onRemove} danger>
          {GLYPH.fail}
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({
  children,
  onClick,
  danger,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        font: "10.5px var(--wb-mono)",
        color: danger ? "var(--wb-needs)" : "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

function RemoveConfirm({ project, onClose }: { project: Project; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await deleteProject(project.id);
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal title="remove project" onClose={onClose} width={400}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Remove <strong style={{ color: "var(--wb-accent)" }}>{project.name}</strong> from
        Workbench? This unregisters it here — the folder on disk is untouched.
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
          {GLYPH.fail} remove
        </button>
      </div>
    </Modal>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "10px 16px", color: "var(--wb-textFaint)", fontSize: 12 }}>{children}</div>;
}

const groupHeaderStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 12px",
  font: "600 10.5px var(--wb-mono)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--wb-textDim2)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};

const footerActionStyle: CSSProperties = {
  borderTop: "1px solid var(--wb-border)",
  borderLeft: "none",
  borderRight: "none",
  borderBottom: "none",
  width: "100%",
  background: "transparent",
  padding: "8px 13px",
  display: "flex",
  alignItems: "center",
  gap: 6,
  font: "10.5px var(--wb-mono)",
  color: "var(--wb-textDim2)",
  cursor: "pointer",
  textAlign: "left",
};

const confirmButtonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default InstanceManager;
