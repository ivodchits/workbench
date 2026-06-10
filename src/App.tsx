import { useEffect, useState } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import InstanceManager from "./panels/InstanceManager";
import Workspace from "./panels/Workspace";
import { useConsoles } from "./state/consoles";
import { useRegistry } from "./state/registry";
import {
  getActiveProject,
  initActiveProject,
  setActiveProject,
  useActiveProject,
} from "./state/activeProject";
import { useGlobalKeys } from "./keyboard";
import { registerCommand } from "./keyboard/bus";
import { getHookServerStatus, onHookEvent } from "./ipc/hooks";
import { initStatusEngine } from "./state/status";

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

  // Start the status engine: consume the hook stream and drive live card status
  // (the sticky precedence machine, step 2.2). Idempotent + app-lifetime, so no
  // cleanup — see initStatusEngine.
  useEffect(() => {
    initStatusEngine();
  }, []);

  // The global keymap listener (Ctrl+Shift / Alt / Ctrl+Tab chords). Rail single
  // keys are handled inside the rail itself (see InstanceManager).
  useGlobalKeys();

  // App owns `focusRail` (Alt+0) because it owns the rail's collapsed state: expand
  // it if needed, then hand focus to the active project's tile (read live so we
  // don't capture a stale id), falling back to the first rail row.
  useEffect(
    () =>
      registerCommand("focusRail", () => {
        setRailCollapsed(false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const rail = document.querySelector("[data-wb-rail]");
            const activeId = getActiveProject();
            const target =
              (activeId &&
                rail?.querySelector<HTMLElement>(`[data-wb-project-id="${activeId}"]`)) ||
              rail?.querySelector<HTMLElement>("[data-wb-rail-row]");
            target?.focus();
          }),
        );
      }),
    [],
  );

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

/** Live hook-server readout for the status bar: the bound port and a running count
 *  of accepted events. Confirms at a glance that the Phase-2 bridge is up and that
 *  a focused agent's hooks are landing (the count ticks as it works). */
function HookIndicator() {
  const [status, setStatus] = useState<{ port: number; accepted: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    void getHookServerStatus()
      .then((s) => {
        if (mounted) setStatus({ port: s.port, accepted: s.accepted });
      })
      .catch(() => {
        /* server failed to start; leave the indicator dim */
      });

    // Bump the count reactively rather than polling.
    const unlisten = onHookEvent(() => {
      setStatus((prev) => (prev ? { ...prev, accepted: prev.accepted + 1 } : prev));
    });
    return () => {
      mounted = false;
      void unlisten.then((off) => off());
    };
  }, []);

  if (!status) {
    return <span style={{ color: "var(--wb-textFaint)" }}>hooks ○</span>;
  }
  return (
    <span title="local hook server (Phase 2 status bridge)">
      <span style={{ color: "var(--wb-done)" }}>●</span> hooks :{status.port} · {status.accepted}
    </span>
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
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ color: "var(--wb-textFaint)", fontSize: 11 }}>╶</span>
        <span style={{ color: "var(--wb-textDim2)", fontSize: 11.5 }}>{context}</span>
      </div>
      <span style={{ color: "var(--wb-textFaint)", fontSize: 11, padding: "0 14px" }}>
        phase 2 · hooks
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
      <HookIndicator />
      {sessionId && (
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
          session {sessionId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

export default App;
