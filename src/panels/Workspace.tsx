// Workspace (step 1.6) — the dockview panel surface that replaces the interim
// console grid. Consoles (and, from 1.7/1.8, shells and editors) live here as
// dockview panels you can split, tab, float in-window, and resize; the
// arrangement is serialized per workspace to SQLite and restored on launch
// (design §5, decision 13 — OS-window tear-off stays Phase 4).
//
// Membership authority is the `consoles` store: a reconciler keeps dockview's
// panel set in step with `open`, adding a panel when a console opens and removing
// it when one closes. dockview's `always` renderer keeps tabbed-away panels
// mounted so their PTYs survive split/tab/float. Restored panels come back as
// dormant placeholders (see `state/consoles`) rather than auto-launching `claude`.

import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewHeaderActionsProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import "../theme/dockview.css";

import ConsolePanel, { type ConsolePanelParams } from "./ConsolePanel";
import { ShellPanel, EditorPanel } from "./StubPanels";
import { GLYPH } from "../theme";
import { useRegistry } from "../state/registry";
import { closeConsole, focusConsole, hydrateDormant, useConsoles } from "../state/consoles";
import { loadLayout, saveLayoutDebounced } from "../state/layout";

const COMPONENTS = {
  console: ConsolePanel as React.FunctionComponent<IDockviewPanelProps>,
  shell: ShellPanel,
  editor: EditorPanel,
};

/** A console panel carries its instance id in params; stubs don't. */
function consoleInstanceId(panel: { params?: Record<string, unknown> }): string | null {
  const id = panel.params?.instanceId;
  return typeof id === "string" ? id : null;
}

function Workspace() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const { open, activeId } = useConsoles();
  const { instances } = useRegistry();

  const restoredRef = useRef(false);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Persist the current arrangement (debounced). Captured once we have an api.
  const persist = (a: DockviewApi) => {
    const ids = a.panels.map(consoleInstanceId).filter((id): id is string => id !== null);
    saveLayoutDebounced(a.toJSON(), ids);
  };

  const onReady = (event: DockviewReadyEvent) => {
    const a = event.api;
    setApi(a);

    // Save on any layout change — but not while we're restoring.
    disposablesRef.current.push(
      a.onDidLayoutChange(() => {
        if (restoredRef.current) persist(a);
      }),
      // Reflect dockview-driven focus (tab clicks) back into the store.
      a.onDidActivePanelChange((panel) => {
        const id = panel ? consoleInstanceId(panel) : null;
        if (id) focusConsole(id);
      }),
      // A panel closed via dockview's UI drops the live console (stops its PTY).
      a.onDidRemovePanel((panel) => {
        const id = consoleInstanceId(panel);
        if (id) closeConsole(id);
      }),
    );

    // Restore the saved arrangement, backing each console panel with a dormant
    // placeholder so it returns in place without relaunching `claude`.
    void loadLayout().then((saved) => {
      if (saved) {
        hydrateDormant(saved.consoleInstanceIds);
        try {
          a.fromJSON(saved.tree);
        } catch {
          a.clear(); // corrupt/incompatible tree — start empty
        }
      }
      restoredRef.current = true;
    });
  };

  useEffect(() => {
    return () => {
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
    };
  }, []);

  // While a tab/panel drag is in progress, flag the wrapper so the content
  // overlays go pointer-transparent (see dockview.css) and dockview's droptargets
  // underneath can receive the drag — otherwise the `always` renderer's overlay
  // swallows it and panels can't be dragged between groups.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const on = () => el.classList.add("wb-dragging");
    const off = () => el.classList.remove("wb-dragging");
    el.addEventListener("dragstart", on, true);
    el.addEventListener("dragend", off, true);
    el.addEventListener("drop", off, true);
    return () => {
      el.removeEventListener("dragstart", on, true);
      el.removeEventListener("dragend", off, true);
      el.removeEventListener("drop", off, true);
    };
  }, []);

  // Reconcile dockview panels with the open-console set.
  useEffect(() => {
    if (!api) return;
    const openIds = new Set(open.map((c) => c.instanceId));

    // Add a panel for every open console that doesn't have one yet. The first
    // console fills the area; each later one opens as its own column beside the
    // others (the §5 side-by-side default) rather than piling into one tab group.
    let consoleCount = api.panels.filter((p) => consoleInstanceId(p) !== null).length;
    for (const session of open) {
      if (api.getPanel(session.instanceId)) continue;
      const title = instances.find((i) => i.id === session.instanceId)?.title ?? "console";
      const params: ConsolePanelParams = { instanceId: session.instanceId };
      const position = consoleCount > 0 ? ({ direction: "right" } as const) : undefined;
      api.addPanel({
        id: session.instanceId,
        component: "console",
        title: `console · ${title}`,
        params,
        ...(position ? { position } : {}),
      });
      consoleCount += 1;
    }

    // Remove console panels whose console has closed (stub panels are left alone).
    for (const panel of [...api.panels]) {
      const id = consoleInstanceId(panel);
      if (id && !openIds.has(id)) api.removePanel(panel);
    }

    // Mirror the store's active console onto dockview.
    if (activeId && api.activePanel?.id !== activeId) {
      api.getPanel(activeId)?.api.setActive();
    }
  }, [api, open, activeId, instances]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <DockviewReact
        components={COMPONENTS}
        watermarkComponent={Watermark}
        rightHeaderActionsComponent={HeaderActions}
        theme={themeAbyss}
        className="wb-dock"
        defaultRenderer="always"
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
