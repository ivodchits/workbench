import { useEffect, useState } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import InstanceManager from "./panels/InstanceManager";
import Workspace from "./panels/Workspace";
import { useConsoles } from "./state/consoles";
import { useRegistry } from "./state/registry";
import { initActiveProject, setActiveProject, useActiveProject } from "./state/activeProject";

// Step 1.5 turned the cockpit into its real shape: the Instance Manager rail on
// the left drives the panel surface, where clicking an instance launches (or
// focuses) its claude console. Step 1.6 replaces the interim console grid with a
// `dockview` Workspace — split / tab / float in-window, layout saved & restored —
// and makes the rail collapsible. Step 1.6b makes the workspace per-project: the
// rail's project selection drives which project's dock is on screen.

function App() {
  const { open, activeId } = useConsoles();
  const { projects, loaded } = useRegistry();
  const activeProjectId = useActiveProject();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);

  useEffect(() => {
    applyTheme(mutedDark);
  }, []);

  // Restore the last-selected project from prefs before we consider a default.
  useEffect(() => {
    let mounted = true;
    void initActiveProject().finally(() => {
      if (mounted) setPrefsReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Once projects load (and prefs have been read), make sure something is active:
  // keep the restored selection if it still exists, else fall back to the first
  // project (or null when there are none).
  useEffect(() => {
    if (!prefsReady || !loaded) return;
    const valid = activeProjectId !== null && projects.some((p) => p.id === activeProjectId);
    if (!valid) setActiveProject(projects[0]?.id ?? null);
  }, [prefsReady, loaded, projects, activeProjectId]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Suppress the webview's native context menu. Its "Reload" reloads the whole
  // page, which drops every live console (the frontend state resets and the
  // saved layout restores as dormant placeholders) — a surprising, destructive
  // action mid-session. Desktop apps don't expose a browser context menu anyway.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // Dormant placeholders (restored from a saved layout) aren't running, so the
  // chrome counts only live consoles.
  const liveCount = open.filter((c) => c.status !== "dormant").length;
  const active = open.find((c) => c.instanceId === activeId) ?? null;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        font: "12.5px var(--wb-mono)",
        overflow: "hidden",
      }}
    >
      <TitleBar context={activeProject ? activeProject.name : "no project"} />

      <div style={{ flex: 1, display: "flex", gap: 14, minHeight: 0, padding: "14px 14px 0" }}>
        {railCollapsed ? (
          <CollapsedRail onExpand={() => setRailCollapsed(false)} />
        ) : (
          <InstanceManager onCollapse={() => setRailCollapsed(true)} />
        )}
        <Workspace />
      </div>

      <StatusBar openCount={liveCount} sessionId={active?.sessionId ?? null} />
    </div>
  );
}

/** The rail's collapsed state: a slim strip with a vertical label + expand caret. */
function CollapsedRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      aria-label="expand instance rail"
      title="expand instance rail"
      style={{
        flex: "0 0 26px",
        width: 26,
        background: "var(--wb-panel)",
        border: "1px solid var(--wb-border)",
        color: "var(--wb-textDim2)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        font: "10.5px var(--wb-mono)",
      }}
    >
      <span style={{ color: "var(--wb-accent)" }}>▸</span>
      <span
        style={{
          writingMode: "vertical-rl",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
        }}
      >
        instances
      </span>
    </button>
  );
}

function TitleBar({ context }: { context: string }) {
  return (
    <div
      style={{
        height: 36,
        flex: "0 0 36px",
        background: "var(--wb-titlebar)",
        borderBottom: "1px solid var(--wb-border)",
        display: "flex",
        alignItems: "center",
        font: "12px var(--wb-mono)",
        color: "var(--wb-text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 14px" }}>
        <span
          style={{ color: "var(--wb-accent)", fontWeight: 700, fontSize: 14, letterSpacing: "-0.5px" }}
        >
          ▞▚
        </span>
        <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>Workbench</span>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ color: "var(--wb-textFaint)", fontSize: 11 }}>╶</span>
        <span style={{ color: "var(--wb-textDim2)", fontSize: 11.5 }}>{context}</span>
      </div>
      <span style={{ color: "var(--wb-textFaint)", fontSize: 11, padding: "0 14px" }}>
        phase 1 · console
      </span>
    </div>
  );
}

function StatusBar({ openCount, sessionId }: { openCount: number; sessionId: string | null }) {
  return (
    <div
      style={{
        height: 28,
        flex: "0 0 28px",
        background: "var(--wb-titlebar)",
        borderTop: "1px solid var(--wb-border)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 14px",
        font: "10.5px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-accent)" }}>muted dark</span>
      <span>
        {openCount} {openCount === 1 ? "console" : "consoles"}
      </span>
      {sessionId && (
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
          session {sessionId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

export default App;
