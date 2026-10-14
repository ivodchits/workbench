// The phone's note rules that need no DOM (step R8): a quick-capture note's name,
// and the unsent edits kept on the device.

/** Longest name taken from a first line. */
const NAME_MAX = 60;

/**
 * A name for a note from its text: the first non-empty line, without markdown's
 * heading or list marks, with the characters a note name can't hold replaced, and
 * cut short. Falls back to "note" — the desktop adds " 2", " 3", … when taken.
 */
export function nameFromText(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  let name = first
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\p{Cc}/gu, " ") // control characters
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).trimEnd();
  name = name.replace(/^[. ]+|[. ]+$/g, "");
  return name || "note";
}

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
