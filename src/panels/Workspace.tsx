// Workspace (step 1.6, project-scoped in 1.6b) — the dockview panel surface where
// consoles / shells / editors live as panels you can split, tab, float in-window,
// and resize (design §5, decision 13 — OS-window tear-off stays Phase 4).
//
// The dock is **per project** (design §3): one serialized tree per project id,
// saved to SQLite and restored on launch. Selecting a project (the `activeProject`
// store) swaps the dock to that project's saved arrangement — the previous tree is
// flushed first, the dock is cleared, and the target tree is loaded. Crucially the
// swap is *view-only*: the other projects' consoles/shells keep running, because
// their PTYs + terminals live in a detached pool (see `terminalPool`) and clearing
// their panels merely detaches them. They re-attach when you switch back.
//
// Membership for the *active* project is reconciled from the `consoles`/`shells`
// stores (which are global, tagged by project): a reconciler adds a panel when a
// console/shell opens in the active project and removes it when one closes.
// Restored panels come back as dormant placeholders rather than auto-launching.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewHeaderActionsProps,
  type SerializedDockview,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "../theme/dockview.css";

import ConsolePanel, { type ConsolePanelParams } from "./ConsolePanel";
import ShellPanel, { type ShellPanelParams } from "./Shell";
import { EditorPanel } from "./StubPanels";
import { GLYPH } from "../theme";
import { useRegistry } from "../state/registry";
import {
  closeConsole,
  focusConsole,
  getActiveConsoleId,
  getOpenConsoles,
  hydrateDormant,
  useConsoles,
  type ConsoleSession,
} from "../state/consoles";
import {
  closeShell,
  getActiveShellId,
  getOpenShells,
  hydrateShells,
  useShells,
  type ShellSession,
} from "../state/shells";
import { useActiveProject } from "../state/activeProject";
import { loadLayout, saveLayoutDebounced, saveLayoutNow } from "../state/layout";
import { release } from "./terminalPool";

interface LayoutSnapshot {
  tree: SerializedDockview;
  consoleIds: string[];
  shells: { shellId: string; projectId: string; cwd: string; label: string }[];
}

const COMPONENTS = {
  console: ConsolePanel as React.FunctionComponent<IDockviewPanelProps>,
  shell: ShellPanel as React.FunctionComponent<IDockviewPanelProps>,
  editor: EditorPanel,
};

/** A console panel carries its instance id in params; other panels don't. */
function consoleInstanceId(panel: { params?: Record<string, unknown> }): string | null {
  const id = panel.params?.instanceId;
  return typeof id === "string" ? id : null;
}

/** A shell panel carries its minted shell id in params; other panels don't. */
function shellPanelId(panel: { params?: Record<string, unknown> }): string | null {
  const id = panel.params?.shellId;
  return typeof id === "string" ? id : null;
}

/**
 * Restore a saved dock tree, resiliently. `dockview.fromJSON` restores the docked
 * grid *and* floating groups in one transaction and reverts the whole layout if
 * any part throws — and floating-group restore is the fragile bit. So if the full
 * restore fails, retry with floating/popout groups dropped: that keeps the docked
 * grid intact (e.g. tabbed consoles), and the dropped panels get re-added as
 * columns by the reconcile pass. Only a total failure falls back to an empty dock.
 */
function restoreTree(a: DockviewApi, tree: SerializedDockview): void {
  try {
    a.fromJSON(tree);
    return;
  } catch (err) {
    console.warn("workbench: layout restore failed; retrying without floating panels", err);
  }
  try {
    const gridOnly: SerializedDockview = { ...tree, floatingGroups: [], popoutGroups: [] };
    a.fromJSON(gridOnly);
  } catch (err) {
    console.warn("workbench: layout restore failed entirely; starting from empty", err);
    a.clear();
  }
}

function Workspace() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const { open, activeId } = useConsoles();
  const { open: shellsOpen, activeId: activeShellId } = useShells();
  const { instances } = useRegistry();
  const activeProjectId = useActiveProject();

  const restoredRef = useRef(false);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  // The last shell id we brought to front. Asserting focus only on a *new* value
  // (not on every shell-store repaint) keeps a shell's spawn→running transition
  // from yanking focus back off a console you clicked while it was starting.
  const shellFocusRef = useRef<string | null>(null);
  // The project whose tree is currently in the dock (`undefined` = none loaded
  // yet). When this diverges from `activeProjectId`, the effect swaps the dock.
  const displayedProjectRef = useRef<string | null | undefined>(undefined);
  // Monotonic token so a fast double-switch lets the latest swap win.
  const swapTokenRef = useRef(0);
  // True only while we're programmatically clearing the dock for a swap, so the
  // panel-removed handler keeps those PTYs alive instead of tearing them down.
  const switchingRef = useRef(false);

  // The reconcile helpers read store state through the module getters (which
  // `hydrate*` updates synchronously) rather than the hook values — the swap
  // calls them right after `hydrateDormant`, before React commits a render, so
  // the hook values would still be stale (and the remove loop would wipe the
  // freshly-restored panels). `instances` is the exception: it only gates which
  // consoles to *add*, never removal, so a stale-empty value is harmless (the
  // next render's reconcile settles it).
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  // Snapshot the dock for persistence. Shell cwd/label live in the store (not in
  // panel params), so they're read from there, scoped to shells still docked.
  const collect = useCallback((a: DockviewApi): LayoutSnapshot => {
    const consoleIds = a.panels.map(consoleInstanceId).filter((id): id is string => id !== null);
    const present = new Set(a.panels.map((p) => p.id));
    const shells = getOpenShells()
      .filter((s) => present.has(s.shellId))
      .map((s) => ({ shellId: s.shellId, projectId: s.projectId, cwd: s.cwd, label: s.label }));
    return { tree: a.toJSON(), consoleIds, shells };
  }, []);

  // Persist the active project's arrangement (debounced).
  const persist = useCallback(
    (a: DockviewApi) => {
      const key = displayedProjectRef.current;
      if (!key) return; // no project on screen → nothing to persist
      const { tree, consoleIds, shells } = collect(a);
      saveLayoutDebounced(tree, consoleIds, shells, key);
    },
    [collect],
  );

  // Add a panel for every active-project console without one (first fills the
  // area, the rest open as columns — the §5 side-by-side default), drop panels
  // whose console was closed, and mirror the active tab.
  const reconcileConsoles = useCallback((a: DockviewApi) => {
    const projId = displayedProjectRef.current;
    const inst = instancesRef.current;
    const openConsoles = getOpenConsoles();
    const projectOf = (instanceId: string) =>
      inst.find((i) => i.id === instanceId)?.projectId ?? null;
    const projConsoles: ConsoleSession[] = openConsoles.filter(
      (c) => projectOf(c.instanceId) === projId,
    );
    for (const session of projConsoles) {
      if (a.getPanel(session.instanceId)) continue;
      const title = inst.find((i) => i.id === session.instanceId)?.title ?? "console";
      const params: ConsolePanelParams = { instanceId: session.instanceId };
      const position = a.panels.length > 0 ? ({ direction: "right" } as const) : undefined;
      a.addPanel({
        id: session.instanceId,
        component: "console",
        title: `console · ${title}`,
        params,
        ...(position ? { position } : {}),
      });
    }
    // Remove a console panel only when its console is genuinely gone from the
    // store (closed / killed). We deliberately do NOT remove on "belongs to
    // another project" or "instance not loaded yet": a correct swap never leaves
    // a foreign panel docked, and removing one here would tear down a background
    // agent's PTY or wipe a restored panel before the registry finishes loading.
    const openIds = new Set(openConsoles.map((c) => c.instanceId));
    for (const panel of [...a.panels]) {
      const id = consoleInstanceId(panel);
      if (id && !openIds.has(id)) a.removePanel(panel);
    }
    const aId = getActiveConsoleId();
    if (aId && a.getPanel(aId) && a.activePanel?.id !== aId) {
      a.getPanel(aId)?.api.setActive();
    }
  }, []);

  // Same reconcile for shells (keyed by their project id directly — no registry
  // lookup needed, so no instance-load race).
  const reconcileShells = useCallback((a: DockviewApi) => {
    const projId = displayedProjectRef.current;
    const openShells = getOpenShells();
    const projShells: ShellSession[] = openShells.filter((s) => s.projectId === projId);

    for (const shell of projShells) {
      if (a.getPanel(shell.shellId)) continue;
      const params: ShellPanelParams = { shellId: shell.shellId };
      const position = a.panels.length > 0 ? ({ direction: "right" } as const) : undefined;
      a.addPanel({
        id: shell.shellId,
        component: "shell",
        title: `shell · ${shell.label}`,
        params,
        ...(position ? { position } : {}),
      });
    }
    // Remove only shells gone from the store entirely (closed) — never another
    // project's shell, which would kill its PTY (same rule as consoles above).
    const allShellIds = new Set(openShells.map((s) => s.shellId));
    for (const panel of [...a.panels]) {
      const id = shellPanelId(panel);
      if (id && !allShellIds.has(id)) a.removePanel(panel);
    }
    const aShell = getActiveShellId();
    if (aShell && a.getPanel(aShell) && aShell !== shellFocusRef.current) {
      a.getPanel(aShell)?.api.setActive();
      shellFocusRef.current = aShell;
    }
  }, []);

  const onReady = (event: DockviewReadyEvent) => {
    const a = event.api;
    setApi(a);

    disposablesRef.current.push(
      // Save on any layout change — but not while restoring or mid-swap.
      a.onDidLayoutChange(() => {
        if (restoredRef.current) persist(a);
      }),
      // Reflect dockview-driven focus (tab clicks) back into the consoles store.
      a.onDidActivePanelChange((panel) => {
        const id = panel ? consoleInstanceId(panel) : null;
        if (id) focusConsole(id);
      }),
      // A panel removed from the dock closes its console/shell and stops its PTY
      // — but dockview also fires this (then re-adds) when a panel is *moved*
      // between groups, and we fire it en masse when clearing the dock for a
      // project swap. Skip teardown while switching (keep PTYs alive), and for a
      // normal removal defer a microtask to confirm it isn't a move.
      a.onDidRemovePanel((panel) => {
        if (switchingRef.current) return; // programmatic project swap — keep alive
        const consoleId = consoleInstanceId(panel);
        const shellId = shellPanelId(panel);
        const id = consoleId ?? shellId;
        if (!id) return;
        queueMicrotask(() => {
          if (switchingRef.current) return;
          if (a.getPanel(id)) return; // it was a move, not a close
          if (consoleId) closeConsole(consoleId);
          else if (shellId) closeShell(shellId);
          release(id);
        });
      }),
    );
  };

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
    };
  }, []);

  // Swap the dock to the active project, then reconcile. When the project hasn't
  // changed (an open/close/focus within it) this is just the reconcile pass.
  useEffect(() => {
    if (!api) return;
    if (displayedProjectRef.current === activeProjectId) {
      reconcileConsoles(api);
      reconcileShells(api);
      return;
    }

    // Project changed → load the target tree first (async, dock untouched), then
    // commit the swap synchronously so persist/reconcile never see a half-built
    // dock. A newer switch (token) supersedes a slower in-flight load.
    const token = ++swapTokenRef.current;
    const prev = displayedProjectRef.current;
    void (async () => {
      const saved = activeProjectId ? await loadLayout(activeProjectId) : null;
      if (token !== swapTokenRef.current) return; // superseded by a later switch

      restoredRef.current = false; // suspend persist during the swap
      if (prev != null) {
        const { tree, consoleIds, shells } = collect(api);
        saveLayoutNow(tree, consoleIds, shells, prev);
      }
      switchingRef.current = true; // keep the outgoing project's PTYs alive
      if (saved) {
        hydrateDormant(saved.consoleInstanceIds);
        hydrateShells(saved.shells);
        // `fromJSON` replaces the whole layout (removing the outgoing project's
        // panels itself) — don't `clear()` first, or it can fail and lose the
        // saved grouping (tabbed consoles would rebuild as separate columns).
        restoreTree(api, saved.tree);
      } else {
        api.clear(); // no saved layout for this project — empty dock
      }
      switchingRef.current = false;
      displayedProjectRef.current = activeProjectId;
      restoredRef.current = true;

      // Settle: add any live console/shell for this project the saved tree didn't
      // include (e.g. one you opened while switching) and drop stragglers.
      reconcileConsoles(api);
      reconcileShells(api);
    })();
  }, [
    api,
    activeProjectId,
    open,
    shellsOpen,
    activeId,
    activeShellId,
    instances,
    collect,
    reconcileConsoles,
    reconcileShells,
  ]);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <DockviewReact
        components={COMPONENTS}
        watermarkComponent={Watermark}
        rightHeaderActionsComponent={HeaderActions}
        theme={themeAbyss}
        className="wb-dock"
        onReady={onReady}
      />
    </div>
  );
}

/**
 * Per-group header buttons. A docked group can float (undock), split a tabbed
 * panel out into its own column, or maximize; a floating group can dock back
 * into the grid. Float/dock-back and split-out all resolve to one primitive —
 * move the active panel into a fresh grid column on the right — which avoids the
 * "docks as a hidden/empty panel" and "docks as a buried tab" failure modes.
 */
function HeaderActions({ containerApi, activePanel, panels }: IDockviewHeaderActionsProps) {
  if (!activePanel) return null;
  const floating = activePanel.api.location.type !== "grid";

  const moveToOwnColumn = () => {
    const group = containerApi.addGroup({ direction: "right" });
    activePanel.api.moveTo({ group, position: "center" });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 6px" }}>
      {floating ? (
        <HeaderButton label="dock panel back" onClick={moveToOwnColumn}>
          ⤓
        </HeaderButton>
      ) : (
        <>
          {panels.length > 1 && (
            <HeaderButton label="move panel to its own column" onClick={moveToOwnColumn}>
              ◨
            </HeaderButton>
          )}
          <HeaderButton
            label="float panel in-window"
            onClick={() => containerApi.addFloatingGroup(activePanel)}
          >
            ⧉
          </HeaderButton>
          <HeaderButton
            label="maximize panel"
            onClick={() =>
              containerApi.hasMaximizedGroup()
                ? containerApi.exitMaximizedGroup()
                : containerApi.maximizeGroup(activePanel)
            }
          >
            ⤢
          </HeaderButton>
        </>
      )}
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
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
        color: "var(--wb-textDim2)",
        font: "12px var(--wb-mono)",
        padding: "2px 5px",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

function Watermark() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        background: "var(--wb-bg)",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ color: "var(--wb-textDim2)", font: "13px var(--wb-mono)" }}>
        {GLYPH.run} no console open
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11.5px var(--wb-mono)", maxWidth: 420 }}>
        click an instance in the rail to launch its claude console — split, tab, or
        float panels to arrange your workspace; the layout is saved
      </div>
    </div>
  );
}

export default Workspace;
