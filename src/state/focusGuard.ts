// The keyboard moves on its own only when you asked for it. Workbench hands the
// keyboard to a panel's content whenever one is activated or mounts (a console
// attaching its terminal, an editor opening), which is right when you picked it, and
// wrong when Duck did it from a tool call while you're in Duck's drawer: the focus
// left the drawer, the selection you were making went with it, and what you typed
// next landed in a terminal. So those focus moves stand down while the open drawer
// has you (the keyboard is in it, or text is selected in it), unless you just
// clicked or pressed a chord yourself.

/** How long a click or a chord counts as asking for the focus to move. */
const INTENT_MS = 1500;
/** In the drawer, a press here is a reach for a control (one that may open a
 *  console, a diff, a session), not reading or writing to Duck. */
const CONTROL = "button, a, summary, select, label, [role='button'], [role='tab'], [role='menuitem']";

let intentAt = -Infinity;

/** You just asked for something (a chord, a click): its focus move goes ahead. */
export function markFocusIntent(): void {
  intentAt = performance.now();
}

/** Duck's drawer, while it's open. */
function openDrawer(): HTMLElement | null {
  const root = document.querySelector<HTMLElement>("[data-wb-duck]");
  return root && root.getAttribute("aria-hidden") !== "true" ? root : null;
}

/** Whether the open drawer has you: a focus move the app makes on its own waits. */
export function duckHoldsFocus(): boolean {
  if (performance.now() - intentAt < INTENT_MS) return false;
  const root = openDrawer();
  if (!root) return false;
  if (root.contains(document.activeElement)) return true;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && (root.contains(sel.anchorNode) || root.contains(sel.focusNode));
}

/** Count a press as intent, except one on the drawer's text or its fields
 *  (reading, selecting, writing to Duck). */
export function watchFocusIntent(): () => void {
  const down = (e: PointerEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-wb-duck]") && !t.closest(CONTROL)) return;
    markFocusIntent();
  };
  const key = (e: KeyboardEvent) => {
    // Enter or Space on a control of the drawer presses it.
    const t = e.target instanceof Element ? e.target : null;
    if ((e.key === "Enter" || e.key === " ") && t?.closest(CONTROL)) markFocusIntent();
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("keydown", key, true);
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("keydown", key, true);
  };
}
