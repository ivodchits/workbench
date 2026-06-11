import { useEffect, useState } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import InstanceManager from "./panels/InstanceManager";
import Workspace from "./panels/Workspace";
import PresetsBar from "./panels/PresetsBar";
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
import { initUsageEngine } from "./state/usage";
import { initUsageLimits, useUsageLimits } from "./state/usageLimits";
import type { RateWindow } from "./ipc/usageLimits";
import { formatCountdown, formatAgo } from "./util/format";

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

  // Start the status engine (hook stream → live card status, step 2.2) and the
  // usage engine (transcript stream → live token figures, step 3.1). Both are
  // idempotent + app-lifetime, so no cleanup — see their init functions.
  useEffect(() => {
    initStatusEngine();
    initUsageEngine();
    initUsageLimits();
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
      <PresetsBar />
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
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
        <UsageMeters />
        {sessionId && (
          <span style={{ color: "var(--wb-textFaint)" }}>session {sessionId.slice(0, 8)}</span>
        )}
      </div>
    </div>
  );
}

/** Account-wide usage meter (step 3.2): the rolling 5-hour and weekly windows, each a
 *  6-cell bar + percent + reset countdown (design §4.5; the §5.x status-bar Meter).
 *  Account-global, so this is one readout for the whole app — fed by whichever
 *  session's statusline POSTed most recently. Shows a dim placeholder until the first
 *  snapshot arrives (it appears only after a session's first API response, Pro/Max
 *  only). Ticks every 30s so the countdowns stay fresh without per-second churn. */
function UsageMeters() {
  const limits = useUsageLimits();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!limits || (!limits.fiveHour && !limits.sevenDay)) {
    return (
      <span
        style={{ color: "var(--wb-textFaint)" }}
        title={
          "account usage limits — appear after the first API response in a Claude " +
          "session (Pro/Max only). Figures are machine-local and approximate."
        }
      >
        ⏱ limits ○
      </span>
    );
  }
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 16 }}
      title={
        "account-wide usage — machine-local and approximate; resets count down live. " +
        `Last reading ${formatAgo(limits.receivedAt)} (refreshes when a session's ` +
        "statusline renders)."
      }
    >
      {limits.fiveHour && <Meter label="5h" window={limits.fiveHour} color="working" />}
      {limits.sevenDay && <Meter label="wk" window={limits.sevenDay} color="done" />}
    </span>
  );
}

/** One usage window as a 6-cell box-drawing bar, matching the design mockup's Meter:
 *  filled cells in the window's accent, the rest faint, then `NN%` and the countdown.
 *  A window whose reset has already passed is **stale** — its old percentage no longer
 *  describes the now-rolled-over window, so we dim it and drop the number rather than
 *  show a figure that's silently wrong (until the next statusline POST refreshes it). */
function Meter({ label, window, color }: { label: string; window: RateWindow; color: string }) {
  const cells = 6;
  const stale = window.resetsAt <= Math.floor(Date.now() / 1000);
  const pct = Math.max(0, Math.min(100, window.usedPercentage));
  const filled = stale ? 0 : Math.round((pct / 100) * cells);
  const reset = formatCountdown(window.resetsAt);
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 5, opacity: stale ? 0.55 : 1 }}
      title={
        stale
          ? `${label} window has reset since the last reading — awaiting the next session for a fresh figure`
          : `${label} window · ${pct.toFixed(0)}% used · resets in ${reset}`
      }
    >
      <span style={{ color: "var(--wb-textDim2)" }}>{label}</span>
      <span style={{ letterSpacing: "-1px" }}>
        {Array.from({ length: cells }).map((_, i) => (
          <span
            key={i}
            style={{ color: i < filled ? `var(--wb-${color})` : "var(--wb-textFaint)" }}
          >
            ▮
          </span>
        ))}
      </span>
      <span style={{ color: "var(--wb-textDim2)" }}>{stale ? "—" : `${pct.toFixed(0)}%`}</span>
      {!stale && <span style={{ color: "var(--wb-textFaint)" }}>{reset}</span>}
    </span>
  );
}

export default App;
