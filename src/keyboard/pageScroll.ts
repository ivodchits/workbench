// PgUp / PgDn scroll the active session: whichever view the dock's active panel
// is showing — a transcript's scroller or a terminal's scrollback — glides a page
// up or down over a short animation rather than jumping.
//
// Plain PgUp/PgDn aren't in the keymap's global "command space" (`isSafeGlobalChord`):
// they are keys a TUI may want. So this stands aside when the terminal is on its
// alternate screen (a full-screen TUI has no scrollback; the key is its own), when
// the active panel shows neither view (an editor keeps its PgUp), and when focus is
// in a text field outside that panel (Duck's drawer, a dialog, the palette).

import type { Terminal } from "@xterm/xterm";
import { getActivePanelElement } from "../state/dock";
import { isKeymapCapturing } from "./keymap";

/** How long one page's glide takes. */
const GLIDE_MS = 260;
/** Held down, the key may run ahead of the glide by at most this many pages. */
const MAX_PAGES_AHEAD = 2;

/** Each xterm's element → its terminal, so a panel's DOM leads to the terminal it shows. */
const terminals = new WeakMap<Element, Terminal>();

/** Make a terminal reachable from its element. Call once it is `open`ed. */
export function registerScrollTerminal(term: Terminal): void {
  if (term.element) terminals.set(term.element, term);
}

const visible = (el: HTMLElement) => el.clientHeight > 0 && el.getClientRects().length > 0;

const ease = (t: number) => 1 - (1 - t) ** 3;

/** One glide in flight per target: a further press extends it from where it is. */
interface Glide {
  from: number;
  to: number;
  start: number;
  frame: number;
}
const glides = new WeakMap<object, Glide>();

/** Glide `target` by `delta` from `now` (its position), within `[0, max]`. */
function glide(
  target: object,
  now: number,
  delta: number,
  page: number,
  max: number,
  set: (v: number) => void,
): void {
  const prev = glides.get(target);
  if (prev) cancelAnimationFrame(prev.frame);
  // Extend from the running glide's goal, so repeated presses add up — capped, so a
  // held key doesn't queue a scroll that runs on long after it's let go.
  const base = prev ? prev.to : now;
  const ahead = Math.max(-page * MAX_PAGES_AHEAD, Math.min(page * MAX_PAGES_AHEAD, base - now + delta));
  const to = Math.max(0, Math.min(max, now + ahead));
  const g: Glide = { from: now, to, start: performance.now(), frame: 0 };
  const step = () => {
    const t = Math.min(1, (performance.now() - g.start) / GLIDE_MS);
    set(g.from + (g.to - g.from) * ease(t));
    if (t < 1) g.frame = requestAnimationFrame(step);
    else glides.delete(target);
  };
  glides.set(target, g);
  g.frame = requestAnimationFrame(step);
}

function scrollElement(el: HTMLElement, dir: 1 | -1): void {
  const page = Math.max(40, el.clientHeight * 0.9);
  glide(el, el.scrollTop, dir * page, page, el.scrollHeight - el.clientHeight, (v) => {
    el.scrollTop = v;
  });
}

/** Scroll a terminal's scrollback; false when it has none to move (a TUI's screen). */
function scrollTerminal(term: Terminal, dir: 1 | -1): boolean {
  const buf = term.buffer.active;
  if (buf.type === "alternate") return false;
  const page = Math.max(1, term.rows - 1);
  let at = buf.viewportY;
  glide(term, at, dir * page, page, buf.baseY, (v) => {
    const line = Math.round(v);
    if (line !== at) {
      term.scrollLines(line - at);
      at = term.buffer.active.viewportY;
    }
  });
  return true;
}

const isTextField = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable));

/** Handle a PgUp/PgDn keydown; true when it scrolled the active session. */
export function pageScrollKey(e: KeyboardEvent): boolean {
  if (e.key !== "PageUp" && e.key !== "PageDown") return false;
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || isKeymapCapturing()) return false;
  const panel = getActivePanelElement();
  if (!panel) return false;
  const focus = document.activeElement;
  if (focus && focus !== document.body && !panel.contains(focus) && isTextField(focus)) return false;
  if (focus?.closest(".cm-editor")) return false;
  const dir = e.key === "PageUp" ? -1 : 1;

  const transcript = Array.from(panel.querySelectorAll<HTMLElement>(".wb-txv-scroll")).find(visible);
  if (transcript) {
    scrollElement(transcript, dir);
    return true;
  }
  for (const el of Array.from(panel.querySelectorAll<HTMLElement>(".xterm"))) {
    const term = terminals.get(el);
    if (term && visible(el)) return scrollTerminal(term, dir);
  }
  return false;
}
