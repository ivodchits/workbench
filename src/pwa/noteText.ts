// The phone's note rules that need no DOM (step R8): a quick-capture note's name
// (shared with the desktop), and the unsent edits kept on the device.

export { nameFromText } from "../state/noteName";

/** An edit typed on the phone and not yet saved, kept across reloads. */
export interface Draft {
  content: string;
  /** The revision the edit started from. */
  base: string;
}

const key = (projectId: string, noteId: string) => `wb-note-draft:${projectId}:${noteId}`;

export function loadDraft(projectId: string, noteId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(projectId, noteId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return typeof d.content === "string" && typeof d.base === "string" ? { content: d.content, base: d.base } : null;
  } catch {
    return null;
  }
}

export function saveDraft(projectId: string, noteId: string, draft: Draft): void {
  try {
    localStorage.setItem(key(projectId, noteId), JSON.stringify(draft));
  } catch {
    // no storage: the edit lives only while the page is open
  }
}

export function dropDraft(projectId: string, noteId: string): void {
  try {
    localStorage.removeItem(key(projectId, noteId));
  } catch {
    // nothing kept
  }
}
