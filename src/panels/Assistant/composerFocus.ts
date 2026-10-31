// Where the drawer's keyboard goes: to the composer, but never at the cost of text
// you're selecting. A click on the thread leaves the keyboard where it is (the
// drawer), so a selection survives and Ctrl/Cmd+C copies it; a typed character or a
// paste from anywhere in the drawer goes to the composer; copy, select-all, the
// arrows and the other chords stay where they are. Refocusing on its own (a thread
// opened, a dictation landing) waits while you're mid-drag or have text selected.

/** Where typing goes on its own: these keep their keys. */
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Space presses these. */
const PRESSABLE = "button, a, summary, [role='button'], [role='checkbox'], [role='tab']";

/** The bits of a key event the decision reads (a KeyboardEvent has them all). */
export type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">;

/** A key that types a character: one character, no Ctrl/Cmd/Alt chord. AltGr is
 *  Ctrl+Alt on Windows, and types (`@` on a German layout). */
export function isTypingKey(e: KeyLike): boolean {
  if (e.isComposing || e.metaKey) return false;
  if (e.ctrlKey !== e.altKey) return false;
  return [...e.key].length === 1;
}

/** Ctrl/Cmd+V (and +Shift): a paste. */
function isPasteKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v";
}

/** Whether a keydown in the drawer, on `target`, should be sent to the composer:
 *  focusing it during keydown makes the character (or the paste) land there. */
export function sendsToComposer(e: KeyLike, target: Element | null): boolean {
  if (e.defaultPrevented) return false;
  if (!isTypingKey(e) && !isPasteKey(e)) return false;
  if (target?.closest(EDITABLE)) return false;
  if (e.key === " " && target?.closest(PRESSABLE)) return false;
  return true;
}

/** Text is selected inside `root` (a non-collapsed selection there). */
export function selectionWithin(root: Node, sel: Selection | null = window.getSelection()): boolean {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return root.contains(sel.anchorNode) || root.contains(sel.focusNode);
}

/** The primary button went down in the drawer and isn't up yet: maybe a drag. */
let selecting = false;

/** Track the primary button from `root` down to wherever it comes up. */
export function watchSelecting(root: HTMLElement): () => void {
  const down = (e: MouseEvent) => {
    if (e.button === 0) selecting = true;
  };
  const up = () => {
    selecting = false;
  };
  root.addEventListener("mousedown", down);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("blur", up);
  return () => {
    root.removeEventListener("mousedown", down);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("blur", up);
    selecting = false;
  };
}

/** The primary button is down in the drawer: maybe a drag selecting text. */
export function isSelecting(): boolean {
  return selecting;
}

/** You're reading the drawer around `el`: mid-drag, or with text selected in it. */
export function isReading(el: Element): boolean {
  const root = el.closest("[data-wb-duck]") ?? el;
  return selecting || selectionWithin(root);
}

/** Focus `el` (the composer) unless that would take a selection away. */
export function focusUnlessReading(el: HTMLElement | null): void {
  if (el && !isReading(el)) el.focus();
}
