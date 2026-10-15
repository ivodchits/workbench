// A fresh agent's review (step A1): the prompt it is given, and the findings read
// back out of its reply.
//
// The reviewer is asked to end with a fenced block in a fixed form, one finding
// per line — `path:line | severity | note` — so the findings can be listed and
// ticked without anyone copying text around. Framework-free, and tested.

export type Severity = "high" | "medium" | "low";

export interface Finding {
  path: string;
  fromLine: number;
  toLine: number;
  severity: Severity;
  note: string;
}

/** The prompt a project starts with; `{base}` becomes the diff's base. */
export const DEFAULT_REVIEW_PROMPT = `Review the changes in this working tree against {base}. Another agent made them; you did not.

Run \`git diff {base}\` (and \`git status\` for new files), and read the changed files as much as you need. Do not edit any file — this is a review only.

Look for bugs, unhandled cases, changes that contradict the code around them, and anything that would surprise a careful reviewer. Skip style nits.

End your reply with the findings in exactly this form, one per line, inside a fenced block marked findings:

\`\`\`findings
path/to/file.ts:42 | high | what is wrong, and what to do about it
path/to/other.rs:10-14 | low | …
\`\`\`

Paths relative to this directory, line numbers as the files are now, severity high, medium or low. If you find nothing, leave the block empty.`;

/** The prompt with its placeholders filled. */
export function fillReviewPrompt(template: string, base: string): string {
  return template.replace(/\{base\}/g, base);
}

const LINE = /^\s*(?:[-*]\s+)?`?([^\s|`]+?):(\d+)(?:\s*-\s*(\d+))?`?\s*\|\s*(high|medium|low)\s*\|\s*(.+?)\s*$/i;

/**
 * The findings in a reviewer's reply: the lines of its last ```findings block
 * that have the agreed form (others are skipped). Null when the reply has no such
 * block at all — the reviewer didn't follow the format.
 */
export function parseFindings(reply: string): Finding[] | null {
  const blocks = [...reply.matchAll(/```findings[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const out: Finding[] = [];
  for (const line of last[1].split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const from = Number(m[2]);
    const to = m[3] ? Math.max(Number(m[3]), from) : from;
    out.push({
      path: m[1].replace(/\\/g, "/").replace(/^\.\//, ""),
      fromLine: from,
      toLine: to,
      severity: m[4].toLowerCase() as Severity,
      note: m[5],
    });
  }
  return out;
}
