// Instance Manager rail (step 1.4 — the full Group → Project → Instance tree).
//
// Step 1.3 built the project registry; this step grows it into the left rail
// proper: each project is a collapsible subtree of instance cards with inline-
// editable task notes, a static status dot (the live hook-fed state machine is
// Phase 2), and row actions (new / rename / edit note / toggle worktree / open
// working dir / kill). A header summary counts agents that "need you".
//
// Step 1.5 wires the rail to consoles: clicking an instance launches (or focuses)
// its claude console, and each row shows a live marker while its console is open.
// Out of scope (later steps): live hook-fed status (2.2), real worktree
// provisioning (2.4), and the dockview arrangement of consoles (1.6).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Panel from "../../theme/Panel";
import { GLYPH } from "../../theme";
import type { Group, Instance, Project } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import { closeConsole, openConsole, useConsoles } from "../../state/consoles";
import { deleteInstance, deleteProject, loadRegistry, useRegistry } from "../../state/registry";
import ProjectDialog from "./ProjectDialog";
import InstanceDialog from "./InstanceDialog";
import InstanceCard from "./InstanceCard";
import Modal from "./Modal";

/** A group with its projects, plus a synthetic "ungrouped" bucket (id `null`). */
interface GroupSection {
  group: Group | null;
  projects: Project[];
}

function InstanceManager() {
  const { groups, projects, instances, loaded, error } = useRegistry();
  const { open: openConsoles } = useConsoles();
  const [addingProject, setAddingProject] = useState(false);
  const [editProjectTarget, setEditProjectTarget] = useState<Project | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<Project | null>(null);
  const [newInstanceProject, setNewInstanceProject] = useState<Project | null>(null);
  const [killTarget, setKillTarget] = useState<Instance | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void loadRegistry();
  }, []);

  // Live console state per instance, so each row can show a running/spawning
  // marker (null = no console open).
  const consoleStatusById = useMemo(() => {
    const m = new Map<string, ConsoleStatus>();
    for (const c of openConsoles) m.set(c.instanceId, c.status);
    return m;
  }, [openConsoles]);

  const activate = (instance: Instance) => {
    setSelectedId(instance.id);
    openConsole(instance);
  };

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

  // Instances keyed by project, preserving the backend ordering.
  const instancesByProject = useMemo<Map<string, Instance[]>>(() => {
    const map = new Map<string, Instance[]>();
    for (const i of instances) {
      const arr = map.get(i.projectId) ?? [];
      arr.push(i);
      map.set(i.projectId, arr);
    }
    return map;
  }, [instances]);

  const needsCount = useMemo(
    () => instances.filter((i) => i.status === "needs_you").length,
    [instances],
  );

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
        title="instances"
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

        {needsCount > 0 && (
          <div
            style={{
              margin: "0 12px 10px",
              padding: "7px 11px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--wb-accentSoft)",
              border: "1px solid var(--wb-needs)",
            }}
          >
            <span style={{ color: "var(--wb-needs)", fontSize: 12 }}>●</span>
            <span style={{ color: "var(--wb-text)", fontSize: 12, fontWeight: 600 }}>
              {needsCount} {needsCount === 1 ? "agent needs" : "agents need"} you
            </span>
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
            const key = `group:${sec.group?.id ?? "__ungrouped__"}`;
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
                    <ProjectNode
                      key={p.id}
                      project={p}
                      instances={instancesByProject.get(p.id) ?? []}
                      collapsed={collapsed.has(`proj:${p.id}`)}
                      onToggle={() => toggle(`proj:${p.id}`)}
                      selectedId={selectedId}
                      consoleStatusById={consoleStatusById}
                      onSelect={setSelectedId}
                      onActivate={activate}
                      onEdit={() => setEditProjectTarget(p)}
                      onRemove={() => setRemoveProjectTarget(p)}
                      onNewInstance={() => setNewInstanceProject(p)}
                      onKill={setKillTarget}
                    />
                  ))}
              </div>
            );
          })}
        </div>

        <button onClick={() => setAddingProject(true)} style={footerActionStyle}>
          <span style={{ color: "var(--wb-accent)" }}>+</span> add project
          <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>p</span>
        </button>
      </Panel>

      {addingProject && <ProjectDialog groups={groups} onClose={() => setAddingProject(false)} />}
      {editProjectTarget && (
        <ProjectDialog
          project={editProjectTarget}
          groups={groups}
          onClose={() => setEditProjectTarget(null)}
        />
      )}
      {removeProjectTarget && (
        <RemoveProjectConfirm
          project={removeProjectTarget}
          instanceCount={(instancesByProject.get(removeProjectTarget.id) ?? []).length}
          onClose={() => setRemoveProjectTarget(null)}
        />
      )}
      {newInstanceProject && (
        <InstanceDialog project={newInstanceProject} onClose={() => setNewInstanceProject(null)} />
      )}
      {killTarget && <KillConfirm instance={killTarget} onClose={() => setKillTarget(null)} />}
    </>
  );
}

// --- project subtree --------------------------------------------------------

interface ProjectNodeProps {
  project: Project;
  instances: Instance[];
  collapsed: boolean;
  onToggle: () => void;
  selectedId: string | null;
  consoleStatusById: Map<string, ConsoleStatus>;
  onSelect: (id: string) => void;
  onActivate: (instance: Instance) => void;
  onEdit: () => void;
  onRemove: () => void;
  onNewInstance: () => void;
  onKill: (instance: Instance) => void;
}

function ProjectNode({
  project,
  instances,
  collapsed,
  onToggle,
  selectedId,
  consoleStatusById,
  onSelect,
  onActivate,
  onEdit,
  onRemove,
  onNewInstance,
  onKill,
}: ProjectNodeProps) {
  const [hover, setHover] = useState(false);
  return (
    <div>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "4px 12px 4px 22px",
          font: "11.5px var(--wb-mono)",
          color: "var(--wb-textDim2)",
        }}
      >
        <button
          onClick={onToggle}
          aria-label={collapsed ? "expand project" : "collapse project"}
          style={caretButtonStyle}
        >
          <span style={{ color: "var(--wb-textFaint)" }}>{collapsed ? "▸" : "▾"}</span>
        </button>
        <span
          onClick={onToggle}
          style={{
            color: "var(--wb-text)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
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
        {instances.length > 0 && (
          <span style={{ color: "var(--wb-textFaint)", fontSize: 10, flex: "0 0 auto" }}>
            {instances.length}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            flex: "0 0 auto",
            visibility: hover ? "visible" : "hidden",
          }}
        >
          <ProjectAction label="new instance" onClick={onNewInstance}>
            +
          </ProjectAction>
          <ProjectAction label="edit project" onClick={onEdit}>
            edit
          </ProjectAction>
          <ProjectAction label="remove project" onClick={onRemove} danger>
            {GLYPH.fail}
          </ProjectAction>
        </span>
      </div>

      {!collapsed && (
        <div style={{ paddingLeft: 8 }}>
          {instances.map((i) => (
            <InstanceCard
              key={i.id}
              instance={i}
              selected={selectedId === i.id}
              consoleStatus={consoleStatusById.get(i.id) ?? null}
              onSelect={() => onSelect(i.id)}
              onActivate={() => onActivate(i)}
              onKill={() => onKill(i)}
            />
          ))}
          <button onClick={onNewInstance} style={newInstanceRowStyle}>
            <span style={{ color: "var(--wb-accent)" }}>+</span> new instance
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectAction({
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

// --- confirmations ----------------------------------------------------------

function RemoveProjectConfirm({
  project,
  instanceCount,
  onClose,
}: {
  project: Project;
  instanceCount: number;
  onClose: () => void;
}) {
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
        {instanceCount > 0 && (
          <div style={{ marginTop: 8, color: "var(--wb-working)" }}>
            {GLYPH.warn} {instanceCount} instance{instanceCount === 1 ? "" : "s"} will be removed
            with it.
          </div>
        )}
      </div>
      <ConfirmButtons busy={busy} onCancel={onClose} onConfirm={() => void confirm()} label="remove" />
    </Modal>
  );
}

function KillConfirm({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      // Stop the PTY (if a console is open) before deleting the row.
      closeConsole(instance.id);
      await deleteInstance(instance.id);
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal title="kill instance" onClose={onClose} width={400}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Kill <strong style={{ color: "var(--wb-accent)" }}>{instance.title}</strong>? This stops its
        console and removes the instance from the rail.
      </div>
      <ConfirmButtons busy={busy} onCancel={onClose} onConfirm={() => void confirm()} label="kill" />
    </Modal>
  );
}

function ConfirmButtons({
  busy,
  onCancel,
  onConfirm,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  label: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
      <button onClick={onCancel} style={confirmButtonStyle}>
        cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={busy}
        style={{ ...confirmButtonStyle, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
      >
        {GLYPH.fail} {label}
      </button>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "10px 16px", color: "var(--wb-textFaint)", fontSize: 12 }}>{children}</div>
  );
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

const caretButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
};

const newInstanceRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  padding: "4px 11px 8px 33px",
  font: "10.5px var(--wb-mono)",
  color: "var(--wb-textDim2)",
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
