// Dragging files onto a console to reference them (step D1).
//
// Rows that stand for a file (the editor's tree and tabs, the Diff file list, the
// Git status list) put their absolute paths on the drag under a type of our own.
// Nothing else reads that type: dockview's dock overlays answer only to its own
// panel drags, and a text field takes no text from it. A console that sees the
// type accepts the drop and writes an `@path` reference for each file.
//
// Framework-free, so the path rules are testable on their own.

/** The drag type carrying a JSON array of absolute paths. */
export const FILE_DRAG_TYPE = "application/x-workbench-path";

/** Start a drag of `paths` (absolute). */
export function setDragPaths(transfer: DataTransfer, paths: string[]): void {
  transfer.setData(FILE_DRAG_TYPE, JSON.stringify(paths));
  transfer.effectAllowed = "copy";
}

/** Whether a drag carries file paths. The only question that can be asked while
 *  it is still over a target: the data itself is readable on drop alone. */
export function isFileDrag(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes(FILE_DRAG_TYPE));
}

/** The paths a dropped drag carries; empty when it carries none we can read. */
export function readDragPaths(transfer: DataTransfer | null): string[] {
  const raw = transfer?.getData(FILE_DRAG_TYPE);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** A Windows path (drive letter or UNC): compared without regard to case. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function slashed(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `path` as Claude should be given it from a session running in `cwd`: relative
 *  (with forward slashes) when it is inside that directory, as it stands when it
 *  is not, or when `cwd` is unknown. */
export function pathFor(path: string, cwd: string): string {
  const root = slashed(cwd).replace(/\/+$/, "");
  if (!root) return path;
  const full = slashed(path);
  const fold = (s: string) => (isWindowsPath(path) ? s.toLowerCase() : s);
  if (!fold(full).startsWith(fold(root) + "/")) return path;
  return full.slice(root.length + 1) || path;
}

/** One `@` reference. A path with white space in it is quoted — unquoted, the
 *  reference would end at the first space. */
export function reference(path: string, cwd: string): string {
  const shown = pathFor(path, cwd);
  return /\s/.test(shown) ? `@"${shown}"` : `@${shown}`;
}

/** The text a drop of `paths` inserts: a reference per file, each followed by a
 *  space so typing can carry straight on. */
export function referenceText(paths: string[], cwd: string): string {
  return [...new Set(paths)].map((p) => `${reference(p, cwd)} `).join("");
}

/** `draft` with `text` put in place of the range `[start, end)`, kept apart from
 *  a word it would otherwise run into, and where the caret goes afterwards. */
export function spliceReference(
  draft: string,
  start: number,
  end: number,
  text: string,
): { text: string; caret: number } {
  const lead = start > 0 && !/\s/.test(draft[start - 1]) ? " " : "";
  // The text after the caret may already start with the space a reference ends in.
  const body = end < draft.length && /\s/.test(draft[end]) ? text.trimEnd() : text;
  return {
    text: draft.slice(0, start) + lead + body + draft.slice(end),
    caret: start + lead.length + body.length,
  };
}
