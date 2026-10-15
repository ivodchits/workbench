// Dock control (step 1.10) — a module-level handle on the app's single dockview
// `DockviewApi`, so the keyboard layer can drive panel navigation/layout without
// prop-drilling the api out of `Workspace`. There is exactly one `DockviewReact`
// for the whole app (the per-project tree is *swapped* into it, decision 13 / §5),
// so one ref suffices. `Workspace` sets it on ready and clears it on unmount.
//
// "Focusing a panel" means more than activating its dockview group: for a console
// we also hand DOM focus to its pooled xterm terminal, so the keyboard lands in
// the live `claude` TUI rather than nowhere.

import type { DockviewApi, IDockviewPanel } from "dockview";
import { focusTerminal } from "../panels/terminalPool";
import { focusComposer } from "./composer";

let api: DockviewApi | null = null;

/** Register (or clear) the app's dockview api. Called by `Workspace.onReady`. */
export function setDockApi(a: DockviewApi | null): void {
  api = a;
}

/** The id of the dock's active panel (a console's is its instance id), or null. */
export function getActivePanelId(): string | null {
  return api?.activePanel?.id ?? null;
}

/** Open a panel to the right of `besideId` (or wherever dockview puts it when that
 *  isn't docked), or bring it forward when one with its id is already open. */
export function openPanelBeside(
  besideId: string | null,
  panel: { id: string; component: string; title: string; params: Record<string, unknown> },
): void {
  if (!api) return;
  const existing = api.getPanel(panel.id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const beside = besideId ? api.getPanel(besideId) : undefined;
  api.addPanel({
    ...panel,
    ...(beside ? { position: { referencePanel: beside.id, direction: "right" as const } } : {}),
  });
}

/**
 * Bring `panelId` to the foreground and hand it the keyboard — the *final* word,
 * even when opening it triggers an async project swap.
 *
 * Opening a console in *another* project switches the active project, which kicks
 * off the Workspace's async dock swap (it awaits the target project's saved
 * layout). That swap's reconcile pass re-asserts the target project's last-active
 * shell/editor/diff — their `activeId` is global and now points at a freshly
 * restored panel — and would otherwise steal the active panel + DOM focus from the
 * console you actually jumped to (the reconcilers run consoles first, so a later
 * editor/diff pass wins). A plain `routePanelFocus` from the caller also fires too
 * early: the target panel doesn't exist until the swap's reconcile adds it.
 *
 * So we poll across frames until the panel appears. The swap's reconcilers run in
 * one *synchronous* block once the layout load resolves, so the first frame that
 * observes the panel is guaranteed to be after every reconciler — our `setActive`
 * lands last and wins. Bounded so a panel that never arrives can't spin forever.
 * Same-project / already-open consoles satisfy the check on the first tick.
 */
export function activatePanel(panelId: string): void {
  let tries = 0;
  const tick = () => {
    if (!api) return;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.api.setActive();
      routePanelFocus(panelId);
      return;
    }
    if (++tries < 40) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Route DOM focus into a panel's content, by panel type:
 *
 *   • console / shell — the panel id is the terminal-pool key (Workspace adds them
 *     as `id: instanceId` / `id: shellId`, and both host via `Console`), so
 *     `focusTerminal(panel.id)` focuses the live xterm. (A `params.instanceId`
 *     lookup misses shells, whose param is `shellId` — that was the original focus bug.)
 *   • editor — owns no pooled terminal; we focus its CodeMirror content directly
 *     (tagged with `data-wb-panel={editorId}` in the Editor panel).
 *
 * Each step is a no-op for the other panel types, so the right one wins.
 *
 * **Deferred a frame on purpose.** dockview's *programmatic* activation
 * (`api.setActive()`) intentionally does **not** move DOM focus — it only refreshes
 * its internal focus state — so without this the keyboard stays wherever it was
 * (the rail row, the previous console) or lands on nothing, and typing vanishes.
 * And activation also triggers a React re-render (`focusConsole` → reconcile);
 * focusing synchronously would be stomped by that commit. Running on the next frame
 * makes our focus the final word. Exported so the one activation chokepoint
 * (`Workspace.onDidActivePanelChange`) can route focus for *every* path — rail
 * selection, tab click, Ctrl+Tab — through the same place.
 */
export function routePanelFocus(panelId: string): void {
  requestAnimationFrame(() => {
    focusTerminal(panelId); // console + shell (pool keyed by panel id)
    focusComposer(panelId); // a console showing its transcript (no-op otherwise)
    document
      .querySelector<HTMLElement>(`[data-wb-panel="${panelId}"] .cm-content`)
      ?.focus(); // editor (no-op when the panel isn't an editor)
  });
}

/** Activate a panel's group/tab and hand the keyboard to its content. */
function focusContent(panel: IDockviewPanel): void {
  panel.api.setActive();
  routePanelFocus(panel.id);
}

/** Move focus to the next (`+1`) or previous (`-1`) panel, wrapping around. */
export function cyclePanel(delta: 1 | -1): void {
  if (!api) return;
  const panels = api.panels;
  if (panels.length === 0) return;
  const active = api.activePanel;
  const idx = active ? panels.findIndex((p) => p.id === active.id) : -1;
  const next = panels[(idx + delta + panels.length) % panels.length] ?? panels[0];
  if (next) focusContent(next);
}

/** Focus the panel at 1-based position `n` (no-op if there are fewer panels). */
export function focusPanelIndex(n: number): void {
  if (!api) return;
  const panel = api.panels[n - 1];
  if (panel) focusContent(panel);
}

/**
 * Split the focused panel out into its own column to the right — the same
 * primitive the group header's "◨" button uses (Workspace `HeaderActions`). A
 * console can't be split into two live views before the PTY multiplexer (Phase 4),
 * so "split" here means "arrange this panel side-by-side", which is the useful,
 * non-destructive gesture available now.
 */
export function splitActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (!panel) return;
  const group = api.addGroup({ direction: "right" });
  panel.api.moveTo({ group, position: "center" });
  focusContent(panel);
}

/** Close the focused panel (its console/shell/editor teardown runs via Workspace). */
export function closeActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (panel) api.removePanel(panel);
}

/** Return DOM focus to the active panel's content (e.g. leaving the rail). */
export function focusActivePanel(): void {
  if (!api) return;
  const panel = api.activePanel;
  if (panel) focusContent(panel);
}
