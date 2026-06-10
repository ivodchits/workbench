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

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Panel from "../../theme/Panel";
import { GLYPH } from "../../theme";
import type { Group, Instance, Project } from "../../ipc/registry";
import type { ConsoleStatus } from "../../state/consoles";
import {
  closeConsole,
  getActiveConsoleId,
  getOpenConsoles,
  openConsole,
  useConsoles,
} from "../../state/consoles";
import { closeShell, getOpenShells, newShell, openShell } from "../../state/shells";
import { closeEditor, getOpenEditors, openEditor } from "../../state/editors";
import {
  getLiveStatuses,
  onStatusTransition,
  useLiveStatuses,
  type LiveStatus,
} from "../../state/status";
import { mergeStatus } from "./status";
import { getActiveProject, setActiveProject, useActiveProject } from "../../state/activeProject";
import { focusActivePanel, routePanelFocus } from "../../state/dock";
import { release } from "../terminalPool";
import {
  addInstance,
  deleteInstance,
  deleteProject,
  getRegistry,
  loadRegistry,
  updateInstance,
  useRegistry,
} from "../../state/registry";
import {
  provisionWorktree,
  revertToRoot,
  sharedWorkingDirInstances,
  slugify,
  teardownWorktree,
} from "../../state/worktree";
import { worktreeTeardownInfo, type SetupResult, type TeardownInfo } from "../../ipc/git";
import { isTextInput, matchCommand } from "../../keyboard";
import { registerCommand } from "../../keyboard/bus";
import { notifyNeedsYou, updateTrayBadge } from "../../ipc/attention";
import ProjectDialog from "./ProjectDialog";
import InstanceCard from "./InstanceCard";
import Modal from "./Modal";

// Create a new instance with no dialog: the title is the next free integer for the
// project (1, 2, 3, …), the task note is empty, and the worktree toggle is off —
// every field stays editable on the card afterward. Opens its console straight
// away so the fresh instance is immediately usable.
async function spawnInstance(project: Project): Promise<void> {
  let max = 0;
  for (const i of getRegistry().instances) {
    if (i.projectId === project.id && /^\d+$/.test(i.title.trim())) {
      max = Math.max(max, Number(i.title.trim()));
    }
  }
  const instance = await addInstance({ projectId: project.id, title: String(max + 1) });
  setActiveProject(instance.projectId);
  openConsole(instance);
  routePanelFocus(instance.id);
}

// After an auto-numbered instance is removed, close the gap so the numeric titles
// stay contiguous (remove 2 from 1·2·3·4·5 → 1·2·3·4). Only purely-numeric titles
// reflow — instances you've renamed keep their names and are skipped over. The plan
// is built from one snapshot up front, then applied in ascending order so a rename
// never lands on a number that's still in use.
async function renumberInstances(projectId: string): Promise<void> {
  const renames = getRegistry()
    .instances.filter((i) => i.projectId === projectId && /^\d+$/.test(i.title.trim()))
    .map((inst, idx) => ({ id: inst.id, want: String(idx + 1), have: inst.title.trim() }))
    .filter((r) => r.want !== r.have);
  for (const r of renames) await updateInstance(r.id, { title: r.want });
}

/** A group with its projects, plus a synthetic "ungrouped" bucket (id `null`). */
interface GroupSection {
  group: Group | null;
  projects: Project[];
}

interface InstanceManagerProps {
  /** Collapse the rail to a slim strip (rendered as a title-bar action). */
  onCollapse?: () => void;
}

function InstanceManager({ onCollapse }: InstanceManagerProps) {
  const { groups, projects, instances, loaded, error } = useRegistry();
  const { open: openConsoles } = useConsoles();
  const liveStatuses = useLiveStatuses();
  const activeProjectId = useActiveProject();
  const [addingProject, setAddingProject] = useState(false);
  const [editProjectTarget, setEditProjectTarget] = useState<Project | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<Project | null>(null);
  const [killTarget, setKillTarget] = useState<Instance | null>(null);
  const [worktreeTarget, setWorktreeTarget] = useState<Instance | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadRegistry();
  }, []);

  // Global chords the rail owns (the keyboard layer dispatches these via the bus).
  // Handlers read fresh state through module getters, so registering once is safe.
  useEffect(() => {
    // Jump to the next/previous agent that needs you. All data is read through
    // module-level getters so the registered-once closure is never stale.
    const doJump = (dir: 1 | -1) => {
      const { instances } = getRegistry();
      const live = getLiveStatuses();
      const consoleMap = new Map<string, ConsoleStatus>();
      for (const c of getOpenConsoles()) {
        if (c.status !== "dormant") consoleMap.set(c.instanceId, c.status);
      }
      const needsIds = instances
        .filter(
          (i) =>
            mergeStatus(consoleMap.get(i.id) ?? null, live.get(i.id) ?? null, i.status).needsYou,
        )
        .map((i) => i.id);
      if (needsIds.length === 0) return;

      const currentId = getActiveConsoleId();
      const currentIdx = needsIds.indexOf(currentId ?? "");
      const nextIdx =
        currentIdx < 0
          ? dir > 0
            ? 0
            : needsIds.length - 1
          : (currentIdx + dir + needsIds.length) % needsIds.length;

      const targetId = needsIds[nextIdx];
      const target = instances.find((i) => i.id === targetId);
      if (!target) return;

      setActiveProject(target.projectId);
      openConsole(target);
      routePanelFocus(target.id);
      // Scroll the rail card into view after the next paint
      requestAnimationFrame(() => {
        railRef.current
          ?.querySelector<HTMLElement>(`[data-wb-instance-id="${targetId}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    };

    const disposers = [
      registerCommand("newInstance", () => {
        const proj = getRegistry().projects.find((p) => p.id === getActiveProject());
        if (proj) void spawnInstance(proj);
      }),
      registerCommand("newEditor", () => {
        const proj = getRegistry().projects.find((p) => p.id === getActiveProject());
        if (proj) openEditorForProject(proj);
      }),
      registerCommand("newShell", () => {
        const proj = getRegistry().projects.find((p) => p.id === getActiveProject());
        if (proj) newShellForProject(proj);
      }),
      registerCommand("killInstance", () => {
        const inst = getRegistry().instances.find((i) => i.id === getActiveConsoleId());
        if (inst) setKillTarget(inst);
      }),
      registerCommand("jumpNeedsYou", () => doJump(1)),
      registerCommand("jumpPrevNeedsYou", () => doJump(-1)),
    ];
    return () => {
      for (const d of disposers) d();
    };
  }, []);

  // Fire an OS notification when an instance transitions into "needs you".
  // Reads the registry inside the callback so we always get the current title
  // even if the component re-rendered since subscription was set up.
  useEffect(
    () =>
      onStatusTransition((instanceId, phase) => {
        if (phase !== "needs_you") return;
        const inst = getRegistry().instances.find((i) => i.id === instanceId);
        if (!inst) return;
        void notifyNeedsYou(inst.title, inst.taskNote ?? undefined).catch(() => {});
      }),
    [],
  );

  // Move roving focus between rail rows (project tiles + instance cards). `delta`
  // is +1 (down) / -1 (up); wraps from an unfocused state to the first/last row.
  const moveRailFocus = (delta: 1 | -1) => {
    const rows = Array.from(
      railRef.current?.querySelectorAll<HTMLElement>("[data-wb-rail-row]") ?? [],
    );
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      idx < 0 ? (delta > 0 ? rows[0] : rows[rows.length - 1]) : rows[idx + delta];
    if (next) {
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
  };

  // Rail-scope single keys, handled on the bubble from the focused row. Per-row
  // actions (open / edit note / kill / …) are handled on the row itself and stop
  // propagation; only navigation + project-level actions reach here.
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTextInput(e.target)) return; // typing in an inline editor
    const m = matchCommand(e.nativeEvent, "rail");
    if (!m) return;
    switch (m.command) {
      case "railNext":
        moveRailFocus(1);
        break;
      case "railPrev":
        moveRailFocus(-1);
        break;
      case "railAddProject":
        setAddingProject(true);
        break;
      case "railReturn":
        focusActivePanel();
        break;
      case "railNew": {
        const el = document.activeElement as HTMLElement | null;
        const projectId =
          el?.dataset.wbProjectId ??
          instances.find((i) => i.id === el?.dataset.wbInstanceId)?.projectId;
        const proj = projects.find((p) => p.id === projectId);
        if (proj) void spawnInstance(proj);
        break;
      }
      case "railCollapse": {
        // Bubbled from an instance card (a project tile collapses itself): move
        // focus up to the card's parent project tile.
        const el = document.activeElement as HTMLElement | null;
        const parentId = instances.find((i) => i.id === el?.dataset.wbInstanceId)?.projectId;
        if (parentId) {
          railRef.current
            ?.querySelector<HTMLElement>(`[data-wb-project-id="${parentId}"]`)
            ?.focus();
        }
        break;
      }
      default:
        return; // handled on the row, or not a container concern
    }
    e.preventDefault();
  };

  // Live console state per instance, so each row can show a running/spawning
  // marker (null = no console open).
  // Dormant entries (placeholders restored from a saved layout, including other
  // projects' workspaces) hold no live PTY, so they don't override the row's
  // persisted status glyph — only an actually-live console shows a marker.
  const consoleStatusById = useMemo(() => {
    const m = new Map<string, ConsoleStatus>();
    for (const c of openConsoles) if (c.status !== "dormant") m.set(c.instanceId, c.status);
    return m;
  }, [openConsoles]);

  // Opening an instance's console makes its project the active workspace (so the
  // dock shows that project's panels), then launches/focuses the console. Route the
  // keyboard into that console too: when it's a *new* active panel the Workspace's
  // onDidActivePanelChange handles focus, but when you re-select the already-active
  // console (e.g. to get back from the editor) no activation fires, so focus it
  // here as well. routePanelFocus is deferred + a no-op until the panel/terminal
  // exists, so a fresh open or a project swap settles via the activation path.
  const activate = (instance: Instance) => {
    setActiveProject(instance.projectId);
    openConsole(instance);
    routePanelFocus(instance.id);
  };

  // Open (or focus) the Project Shell in the project's root dir, labelled with
  // the project name; switches the active workspace to that project.
  const openShellForProject = (project: Project) => {
    setActiveProject(project.id);
    openShell({ projectId: project.id, cwd: project.rootPath, label: project.name });
  };

  // Spawn an *additional* shell for the project (Ctrl+Shift+T), even if one is
  // already open — handy when a long-running command ties one up. Later shells get
  // a numbered label so their tabs stay distinguishable from the first.
  const newShellForProject = (project: Project) => {
    setActiveProject(project.id);
    const n = getOpenShells().filter((s) => s.projectId === project.id).length;
    const label = n === 0 ? project.name : `${project.name} ${n + 1}`;
    newShell({ projectId: project.id, cwd: project.rootPath, label });
  };

  // Open (or focus) the Editor for the project, its file tree scoped to the
  // project root; switches the active workspace to that project.
  const openEditorForProject = (project: Project) => {
    setActiveProject(project.id);
    openEditor({ projectId: project.id, rootPath: project.rootPath, label: project.name });
  };

  // Accordion: when the active project changes, expand it and collapse the rest,
  // so the rail focuses on the workspace you're in. Manual caret toggles still
  // work afterward (this only fires on an active-project *change*, not on every
  // registry reload — note edits etc. mustn't re-collapse what you opened).
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProjectId || activeProjectId === prevActiveRef.current) return;
    prevActiveRef.current = activeProjectId;
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of projects) {
        const key = `proj:${p.id}`;
        if (p.id === activeProjectId) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, [activeProjectId, projects]);

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

  // Instances whose (toggle-off) working dir is shared with another — they get a
  // non-blocking "shared working dir" warning + one-click isolate (step 2.6).
  const sharedInstanceIds = useMemo(() => sharedWorkingDirInstances(instances), [instances]);

  // When the filter is active, only show instances that currently need you.
  // Projects with no matching instances are hidden from the section list.
  const filteredInstancesByProject = useMemo(() => {
    if (!needsYouOnly) return instancesByProject;
    const result = new Map<string, Instance[]>();
    for (const [projId, insts] of instancesByProject) {
      const filtered = insts.filter(
        (i) =>
          mergeStatus(consoleStatusById.get(i.id) ?? null, liveStatuses.get(i.id) ?? null, i.status)
            .needsYou,
      );
      if (filtered.length > 0) result.set(projId, filtered);
    }
    return result;
  }, [needsYouOnly, instancesByProject, consoleStatusById, liveStatuses]);

  // "Needs you" now comes from the merged live status (hook-driven), not the
  // persisted placeholder — so the header count and badges track real sessions.
  const needsCount = useMemo(
    () =>
      instances.filter(
        (i) =>
          mergeStatus(consoleStatusById.get(i.id) ?? null, liveStatuses.get(i.id) ?? null, i.status)
            .needsYou,
      ).length,
    [instances, consoleStatusById, liveStatuses],
  );

  // Keep the tray badge tooltip in sync with the needs-you count.
  useEffect(() => {
    void updateTrayBadge(needsCount).catch(() => {});
  }, [needsCount]);

  // Auto-clear the filter when no agents need you anymore.
  useEffect(() => {
    if (needsCount === 0) setNeedsYouOnly(false);
  }, [needsCount]);

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
        right={
          onCollapse && (
            <button
              onClick={onCollapse}
              aria-label="collapse instance rail"
              title="collapse instance rail"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                lineHeight: 1,
                font: "11px var(--wb-mono)",
                color: "var(--wb-textDim2)",
              }}
            >
              ◂
            </button>
          )
        }
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
            <button
              onClick={() => setNeedsYouOnly((v) => !v)}
              title={needsYouOnly ? "show all instances" : "show only agents that need you"}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                font: "10.5px var(--wb-mono)",
                color: needsYouOnly ? "var(--wb-needs)" : "var(--wb-textDim2)",
                padding: 0,
              }}
            >
              {needsYouOnly ? "all ◂" : "filter ▸"}
            </button>
          </div>
        )}

        <div
          ref={railRef}
          data-wb-rail
          onKeyDown={onRailKeyDown}
          style={{ overflow: "auto", flex: 1 }}
        >
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
                  sec.projects
                    .filter((p) => !needsYouOnly || filteredInstancesByProject.has(p.id))
                    .map((p) => (
                    <ProjectNode
                      key={p.id}
                      project={p}
                      instances={filteredInstancesByProject.get(p.id) ?? []}
                      collapsed={collapsed.has(`proj:${p.id}`)}
                      onToggle={() => toggle(`proj:${p.id}`)}
                      active={activeProjectId === p.id}
                      onSelectProject={() => setActiveProject(p.id)}
                      consoleStatusById={consoleStatusById}
                      liveStatuses={liveStatuses}
                      sharedInstanceIds={sharedInstanceIds}
                      onActivate={activate}
                      onOpenShell={() => openShellForProject(p)}
                      onOpenEditor={() => openEditorForProject(p)}
                      onEdit={() => setEditProjectTarget(p)}
                      onRemove={() => setRemoveProjectTarget(p)}
                      onNewInstance={() => void spawnInstance(p)}
                      onToggleWorktree={setWorktreeTarget}
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
          instanceIds={(instancesByProject.get(removeProjectTarget.id) ?? []).map((i) => i.id)}
          onClose={() => setRemoveProjectTarget(null)}
        />
      )}
      {killTarget && <KillConfirm instance={killTarget} onClose={() => setKillTarget(null)} />}
      {worktreeTarget &&
        (worktreeTarget.worktreeOn ? (
          <WorktreeTeardown
            instance={worktreeTarget}
            project={projects.find((p) => p.id === worktreeTarget.projectId) ?? null}
            onClose={() => setWorktreeTarget(null)}
          />
        ) : (
          <WorktreeProvision
            instance={worktreeTarget}
            project={projects.find((p) => p.id === worktreeTarget.projectId) ?? null}
            onClose={() => setWorktreeTarget(null)}
          />
        ))}
    </>
  );
}

// --- project subtree --------------------------------------------------------

interface ProjectNodeProps {
  project: Project;
  instances: Instance[];
  collapsed: boolean;
  onToggle: () => void;
  /** True when this is the active project (its workspace is on screen). */
  active: boolean;
  /** Make this the active project (swaps the dock to its workspace). */
  onSelectProject: () => void;
  consoleStatusById: Map<string, ConsoleStatus>;
  liveStatuses: ReadonlyMap<string, LiveStatus>;
  /** Instances flagged as sharing a working dir (step 2.6). */
  sharedInstanceIds: ReadonlySet<string>;
  onActivate: (instance: Instance) => void;
  /** Open (or focus) this project's shell. */
  onOpenShell: () => void;
  /** Open (or focus) this project's editor. */
  onOpenEditor: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onNewInstance: () => void;
  onToggleWorktree: (instance: Instance) => void;
  onKill: (instance: Instance) => void;
}

function ProjectNode({
  project,
  instances,
  collapsed,
  onToggle,
  active,
  onSelectProject,
  consoleStatusById,
  liveStatuses,
  sharedInstanceIds,
  onActivate,
  onOpenShell,
  onOpenEditor,
  onEdit,
  onRemove,
  onNewInstance,
  onToggleWorktree,
  onKill,
}: ProjectNodeProps) {
  const [hover, setHover] = useState(false);

  // Live tile summary: how many instances, how many have a running console, and
  // how many need you (the latter from the merged hook-fed status, step 2.2).
  const running = instances.filter((i) => {
    const s = consoleStatusById.get(i.id);
    return s === "running" || s === "spawning";
  }).length;
  const needsYou = instances.filter(
    (i) =>
      mergeStatus(consoleStatusById.get(i.id) ?? null, liveStatuses.get(i.id) ?? null, i.status)
        .needsYou,
  ).length;
  const done = instances.filter(
    (i) =>
      mergeStatus(consoleStatusById.get(i.id) ?? null, liveStatuses.get(i.id) ?? null, i.status)
        .done,
  ).length;

  // Rail single-keys for a focused project tile: Enter opens (selects + expands),
  // Left/Right collapse/expand. Everything else (j/k nav, n, p, Esc) bubbles to
  // the rail container.
  const onTileKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const m = matchCommand(e.nativeEvent, "rail");
    if (!m) return;
    switch (m.command) {
      case "railOpen":
        onSelectProject();
        if (collapsed) onToggle();
        break;
      case "railCollapse":
        if (collapsed) return; // nothing to collapse — let it bubble (no-op)
        onToggle();
        break;
      case "railExpand":
        if (!collapsed) return;
        onToggle();
        break;
      default:
        return; // not a tile concern
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div>
      {/* The project tile — clicking it makes this the active workspace. */}
      <div
        tabIndex={0}
        data-wb-rail-row
        data-wb-project-id={project.id}
        onKeyDown={onTileKeyDown}
        onClick={onSelectProject}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          padding: "8px 12px 9px 18px",
          borderLeft: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
          background: active ? "var(--wb-sel)" : hover ? "var(--wb-sel)" : "transparent",
          cursor: "pointer",
        }}
        title={`${project.rootPath}\n(click to open this project's workspace)`}
      >
        {/* Row 1 — caret · name · branch · actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, font: "13px var(--wb-mono)" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={collapsed ? "expand project" : "collapse project"}
            style={caretButtonStyle}
          >
            <span style={{ color: "var(--wb-textFaint)" }}>{collapsed ? "▸" : "▾"}</span>
          </button>
          <span
            style={{
              color: active ? "var(--wb-accent)" : "var(--wb-text)",
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {project.name}
          </span>
          {project.defaultBranch && (
            <span style={{ color: "var(--wb-textFaint)", fontSize: 10, flex: "0 0 auto" }}>
              ⌥ {project.defaultBranch}
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
            <ProjectAction label="open project shell" onClick={onOpenShell}>
              {GLYPH.prompt}
            </ProjectAction>
            <ProjectAction label="open editor" onClick={onOpenEditor}>
              ✎
            </ProjectAction>
            <ProjectAction label="edit project" onClick={onEdit}>
              edit
            </ProjectAction>
            <ProjectAction label="remove project" onClick={onRemove} danger>
              {GLYPH.fail}
            </ProjectAction>
          </span>
        </div>

        {/* Row 2 — instance summary */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginLeft: 21,
            marginTop: 3,
            font: "10.5px var(--wb-mono)",
            color: "var(--wb-textFaint)",
          }}
        >
          {instances.length === 0 ? (
            <span>no instances</span>
          ) : (
            <>
              <span>
                {instances.length} instance{instances.length === 1 ? "" : "s"}
              </span>
              {running > 0 && <span style={{ color: "var(--wb-accent)" }}>{running} running</span>}
              {done > 0 && (
                <span style={{ color: "var(--wb-done)" }}>● {done} done</span>
              )}
              {needsYou > 0 && (
                <span style={{ color: "var(--wb-needs)" }}>● {needsYou} need you</span>
              )}
            </>
          )}
        </div>
      </div>

      {!collapsed && (
        <div style={{ paddingLeft: 8 }}>
          {instances.map((i) => (
            <InstanceCard
              key={i.id}
              instance={i}
              consoleStatus={consoleStatusById.get(i.id) ?? null}
              live={liveStatuses.get(i.id) ?? null}
              shared={sharedInstanceIds.has(i.id)}
              onActivate={() => onActivate(i)}
              onToggleWorktree={() => onToggleWorktree(i)}
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
  instanceIds,
  onClose,
}: {
  project: Project;
  instanceIds: string[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const instanceCount = instanceIds.length;
  const confirm = async () => {
    setBusy(true);
    try {
      // Tear down this project's live consoles + shell (kill their PTYs) before
      // deleting, so removing a project never leaves orphaned background agents —
      // their panels may not even be on screen (another project's workspace is).
      for (const id of instanceIds) {
        closeConsole(id);
        release(id);
      }
      for (const s of getOpenShells().filter((s) => s.projectId === project.id)) {
        closeShell(s.shellId);
        release(s.shellId);
      }
      // Editors hold no PTY — just drop them (unsaved buffers go with the project).
      for (const e of getOpenEditors().filter((e) => e.projectId === project.id)) {
        closeEditor(e.editorId);
      }
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
      // Stop the PTY (if a console is open) before deleting the row. `release`
      // kills it directly in case the console's panel isn't currently docked
      // (another project's workspace is on screen), where panel-removal teardown
      // wouldn't fire.
      closeConsole(instance.id);
      release(instance.id);
      await deleteInstance(instance.id);
      await renumberInstances(instance.projectId);
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

/** Confirm provisioning a worktree (toggle ON). Provisioning restarts the claude
 *  session in the new dir, so this is a deliberate confirm rather than an instant
 *  flag-flip (step 2.4). After provisioning, any post-create setup (step 2.5 — copy
 *  `.env*`, run the project's setup command) reports its result here before closing. */
function WorktreeProvision({
  instance,
  project,
  onClose,
}: {
  instance: Instance;
  project: Project | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupResult | null>(null);
  // Whether a live console would be restarted by this change (we relaunch claude
  // in the new working dir).
  const consoleLive = getOpenConsoles().some(
    (c) => c.instanceId === instance.id && c.status !== "dormant",
  );
  const willRunSetup =
    !!project && (project.worktreeCopyEnv || (project.worktreeSetupCommand ?? "").trim().length > 0);

  const confirm = async () => {
    if (!project) {
      setError("project not found");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await provisionWorktree(instance, project);
      // If there was meaningful setup to show (a command ran), keep the dialog open
      // on its result screen; otherwise we're done.
      if (result.skipped || (!result.command && result.copiedEnv.length === 0)) {
        onClose();
      } else {
        setSetup(result);
        setBusy(false);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  // Result screen: the worktree exists; show what the setup step did.
  if (setup) {
    return (
      <Modal title="worktree setup" onClose={onClose} width={520}>
        <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
          Worktree provisioned on{" "}
          <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
            {instance.branch}
          </span>
          .
          {setup.copiedEnv.length > 0 && (
            <div style={{ marginTop: 6, color: "var(--wb-done)" }}>
              {GLYPH.ok} copied {setup.copiedEnv.join(", ")}
            </div>
          )}
          {setup.command && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  color: setup.failed ? "var(--wb-needs)" : "var(--wb-done)",
                  fontFamily: "var(--wb-mono)",
                  fontSize: 11.5,
                }}
              >
                {setup.failed ? GLYPH.fail : GLYPH.ok} {setup.command}
                {setup.exitCode !== null && ` (exit ${setup.exitCode})`}
              </div>
              {setup.output.trim() && (
                <pre
                  style={{
                    marginTop: 6,
                    maxHeight: 220,
                    overflow: "auto",
                    padding: "8px 10px",
                    background: "var(--wb-bg)",
                    border: "1px solid var(--wb-border)",
                    font: "10.5px/1.45 var(--wb-mono)",
                    color: "var(--wb-textDim2)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {setup.output}
                </pre>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
          >
            {GLYPH.ok} done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="isolate in a worktree" onClose={onClose} width={420}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Provision an isolated worktree for{" "}
        <strong style={{ color: "var(--wb-accent)" }}>{instance.title}</strong> on a new branch{" "}
        <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
          agent/{slugify(instance.title)}
        </span>
        ?
        {willRunSetup && (
          <div style={{ marginTop: 8, color: "var(--wb-textDim2)" }}>
            {project?.worktreeCopyEnv && <>Copies <code>.env*</code>. </>}
            {(project?.worktreeSetupCommand ?? "").trim() && (
              <>
                Runs{" "}
                <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
                  {project?.worktreeSetupCommand}
                </span>
                .
              </>
            )}
          </div>
        )}
        {consoleLive && (
          <div style={{ marginTop: 8, color: "var(--wb-working)" }}>
            {GLYPH.warn} Its console is running — this restarts the claude session in the new
            directory.
          </div>
        )}
        {error && (
          <div style={{ marginTop: 8, color: "var(--wb-needs)", fontFamily: "var(--wb-mono)", fontSize: 11.5 }}>
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
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-borderActive)" }}
        >
          {busy ? "working…" : `${GLYPH.worktree} isolate`}
        </button>
      </div>
    </Modal>
  );
}

type TeardownAction = "merge" | "rebase" | "discard" | "detach";

/** The worktree "done" flow (step 2.5, design §6/§7): show what the agent changed,
 *  then integrate (merge/rebase) the branch + remove the worktree, discard it, or
 *  just detach (leave it on disk). Integration conflicts surface git's message for
 *  the user to resolve in the Project Shell. */
function WorktreeTeardown({
  instance,
  project,
  onClose,
}: {
  instance: Instance;
  project: Project | null;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<TeardownInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<TeardownAction>("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = info?.targetBranch ?? null;
  const canIntegrate = !!target;

  // Load the diff summary + integration target on open.
  useEffect(() => {
    if (!project) {
      setLoadError("project not found");
      return;
    }
    let alive = true;
    void worktreeTeardownInfo(project.rootPath, instance.workingDir)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        // Fall back to a non-integrating default if HEAD is detached.
        if (!i.targetBranch) setAction("detach");
      })
      .catch((e) => alive && setLoadError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [project, instance.workingDir]);

  const confirm = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "detach") {
        await revertToRoot(instance, project);
      } else if (action === "discard") {
        await teardownWorktree(instance, project, { integrate: null, force: true });
      } else {
        await teardownWorktree(instance, project, {
          integrate: action, // "merge" | "rebase"
          targetBranch: target,
          force: false,
        });
      }
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const diff = info?.diff;
  return (
    <Modal title="worktree — done" onClose={onClose} width={480}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        <div>
          <strong style={{ color: "var(--wb-accent)" }}>{instance.title}</strong> on{" "}
          <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
            {instance.branch}
          </span>
        </div>

        {/* Diff summary — stands in for the Diff/Review panel (step 2.7). */}
        {loadError ? (
          <div style={{ marginTop: 8, color: "var(--wb-needs)", fontSize: 11.5 }}>
            {GLYPH.warn} {loadError}
          </div>
        ) : !info ? (
          <div style={{ marginTop: 8, color: "var(--wb-textDim2)", fontSize: 11.5 }}>
            reading changes…
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <div style={{ font: "11px var(--wb-mono)", color: "var(--wb-textDim2)" }}>
              {diff && (diff.filesChanged > 0 || diff.stat) ? (
                <>
                  {diff.filesChanged} file{diff.filesChanged === 1 ? "" : "s"} changed
                  {diff.insertions > 0 && (
                    <span style={{ color: "var(--wb-done)" }}> +{diff.insertions}</span>
                  )}
                  {diff.deletions > 0 && (
                    <span style={{ color: "var(--wb-needs)" }}> −{diff.deletions}</span>
                  )}
                  <span style={{ color: "var(--wb-textFaint)" }}> vs {diff.base}</span>
                </>
              ) : (
                <span>no changes vs {diff?.base ?? "base"}</span>
              )}
            </div>
            {diff?.stat.trim() && (
              <pre
                style={{
                  marginTop: 6,
                  maxHeight: 160,
                  overflow: "auto",
                  padding: "8px 10px",
                  background: "var(--wb-bg)",
                  border: "1px solid var(--wb-border)",
                  font: "10.5px/1.45 var(--wb-mono)",
                  color: "var(--wb-textDim2)",
                  whiteSpace: "pre",
                }}
              >
                {diff.stat}
              </pre>
            )}
          </div>
        )}

        {/* Action picker. */}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <TeardownChoice
            checked={action === "merge"}
            onSelect={() => setAction("merge")}
            disabled={!canIntegrate}
            label={
              <>
                Merge into{" "}
                <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
                  {target ?? "…"}
                </span>{" "}
                &amp; remove
              </>
            }
            hint="merge commit on the target, then delete the worktree + branch"
          />
          <TeardownChoice
            checked={action === "rebase"}
            onSelect={() => setAction("rebase")}
            disabled={!canIntegrate}
            label={
              <>
                Rebase onto{" "}
                <span style={{ color: "var(--wb-accent)", fontFamily: "var(--wb-mono)" }}>
                  {target ?? "…"}
                </span>{" "}
                &amp; remove
              </>
            }
            hint="replay commits for a linear history (fast-forward), then remove"
          />
          <TeardownChoice
            checked={action === "discard"}
            onSelect={() => setAction("discard")}
            label="Discard"
            hint="remove the worktree + branch without integrating — throws the work away"
            danger
          />
          <TeardownChoice
            checked={action === "detach"}
            onSelect={() => setAction("detach")}
            label="Detach, keep on disk"
            hint="point the instance back at the project root; leave the worktree untouched"
          />
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              color: "var(--wb-needs)",
              fontFamily: "var(--wb-mono)",
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}
          >
            {GLYPH.fail} {error}
            {(action === "merge" || action === "rebase") && (
              <div style={{ marginTop: 4, color: "var(--wb-textDim2)" }}>
                Resolve in the Project Shell, or choose another action.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy || (!info && !loadError)}
          style={{
            ...confirmButtonStyle,
            borderColor: action === "discard" ? "var(--wb-needs)" : "var(--wb-borderActive)",
            color: action === "discard" ? "var(--wb-needs)" : "var(--wb-text)",
          }}
        >
          {busy ? "working…" : "confirm"}
        </button>
      </div>
    </Modal>
  );
}

function TeardownChoice({
  checked,
  onSelect,
  label,
  hint,
  disabled,
  danger,
}: {
  checked: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  hint: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "6px 8px",
        border: `1px solid ${checked ? "var(--wb-borderActive)" : "var(--wb-border)"}`,
        background: checked ? "var(--wb-sel)" : "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        style={{ marginTop: 2 }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: danger ? "var(--wb-needs)" : "var(--wb-text)",
          }}
        >
          {label}
        </span>
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>{hint}</span>
      </span>
    </label>
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
