// A note's name from its text (steps R8, P1): the phone's quick capture and the
// desktop's "save plan as note" name a note after its first line. Framework-free,
// for both bundles.

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
