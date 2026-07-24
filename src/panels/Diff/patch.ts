// Unified-diff hunk parsing + patch reconstruction (G5) — the value half of the
// diff renderer next door, split out for the same fast-refresh reason as the Git
// panel's `format.ts`/`rows.tsx` pair.
//
// What this exists for: staging *part* of a file. The panel reads one side's diff
// (`gitFileDiff`), the user picks hunks in `UnifiedDiff`, and this rebuilds a
// patch holding only those hunks for `gitApplyPatch` to feed back to git.
//
// The hunks are copied **verbatim**, headers and all. That's deliberate, not a
// shortcut: each `@@ -a,b +c,d @@` already carries the line numbers of the side
// the patch will be applied to, so a subset of hunks from a one-sided diff still
// describes exactly where each change goes. Renumbering them — which a diff *of
// the whole file* would need — is where partial-staging implementations usually
// go wrong.

/** One `@@ … @@` block: its header line and body, as they appeared. */
export interface Hunk {
  /** Position in the file's hunk list, 0-based — the id the UI selects by. */
  index: number;
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** Body lines (`+`, `-`, ` `, `\ No newline…`), without the header. */
  lines: string[];
  /** Index of the header within the source text's line array — how the renderer
   *  maps a rendered line back to the hunk it belongs to. */
  at: number;
}

/** A file diff split into its preamble (`diff --git`, `index`, `---`, `+++`) and
 *  its hunks. `preamble` is empty for text that isn't a diff at all. */
export interface ParsedDiff {
  preamble: string[];
  hunks: Hunk[];
}

/**
 * Split one file's unified diff into preamble + hunks. Written for the panel's
 * single-file diffs; a multi-file patch would parse without error but its later
 * files' preambles would land in the first file's hunk bodies, so don't feed it
 * one.
 */
export function parseDiff(text: string): ParsedDiff {
  const lines = text.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first === -1) return { preamble: [], hunks: [] };
  const preamble = lines.slice(0, first);
  const hunks: Hunk[] = [];
  for (let i = first; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) {
      hunks.push({ index: hunks.length, header: lines[i], lines: [], at: i });
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1].lines.push(lines[i]);
    }
  }
  return { preamble, hunks };
}

/**
 * Rebuild a patch holding only `picked` (hunk indexes), ready for `git apply`.
 * Returns null when nothing is selected or the text carried no hunks — an
 * untracked file's synthesized diff has no preamble git could match to a blob,
 * which is why those rows have no hunk actions.
 */
export function buildPatch(text: string, picked: ReadonlySet<number>): string | null {
  const { preamble, hunks } = parseDiff(text);
  if (preamble.length === 0 || hunks.length === 0) return null;
  const chosen = hunks.filter((h) => picked.has(h.index));
  if (chosen.length === 0) return null;
  const out = [...preamble];
  for (const h of chosen) out.push(h.header, ...h.lines);
  // A trailing newline is not optional: git rejects a patch without one.
  return `${out.join("\n")}\n`;
}

/** A hunk's `+`/`−` counts, for the label on its action row. */
export function hunkStat(h: Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of h.lines) {
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}
