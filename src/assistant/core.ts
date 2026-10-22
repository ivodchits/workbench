// Duck's core memory (step W4): a short profile of you that every thread starts
// with: who you are, your preferences, standing instructions, and the names and
// nicknames you use ("the game" is project Hollow). It's `memory/core.md` in Duck's
// workspace, a markdown file of four sections with one fact per bullet, which you
// can edit in the editor, and which Duck edits with `remember_core` and
// `forget_core`. Everything else Duck remembers is long-term memory (`memory.ts`).
//
// A thread reads it once, at its first message, into the system message that goes
// with that message: the system prompt stays byte-identical (cached), and the
// thread's own prefix stays put after that, so a fact remembered mid-thread
// reaches the threads started after it, and this one through the tool's result.
//
// Every write goes over the text it was read as, so a save of yours in the editor
// since is never overwritten (the write fails, and the edit is redone on yours).

import { coreRead, coreWrite } from "../ipc/assistant";

export const CORE_SECTIONS = ["About you", "Preferences", "Standing instructions", "Names & nicknames"] as const;
export type CoreSection = (typeof CORE_SECTIONS)[number];

/** The profile's cap (the plan's ~2k tokens), as characters at ~4 per token. */
export const CORE_MAX_CHARS = 8000;
/** One fact's cap: a fact is a line, not a document. */
export const FACT_MAX_CHARS = 300;

const HEADER = "# Core memory\n\nWhat Duck knows about you in every thread. One fact per line; edit freely.\n";

/** A new file: the header and the four empty sections. */
export const EMPTY_CORE = `${HEADER}\n${CORE_SECTIONS.map((s) => `## ${s}\n`).join("\n")}`;

export interface CoreHost {
  /** The file's path, and its text (null: no file yet). */
  read(): Promise<{ path: string; text: string | null }>;
  /** Write over `expected` (what was read); throws "stale: …" over a newer edit.
   *  `message` is the commit's (step L1). */
  write(text: string, expected: string | null, message?: string): Promise<void>;
}

/** The host over Duck's workspace (the settings' folder, else the default). */
export function createCoreHost(workspace: () => string | null): CoreHost {
  return {
    async read() {
      const [path, text] = await coreRead(workspace());
      return { path, text };
    },
    write: (text, expected, message) => coreWrite(workspace(), text, expected, message),
  };
}

/** The workspace a `memory/core.md` path is in. */
export const coreWorkspace = (path: string): string => path.replace(/[\\/]memory[\\/]core\.md$/i, "");

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A fact as one bullet's text: one line, no leading bullet. */
export function cleanFact(fact: string): string {
  return fact
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s*/, "");
}

/** The bullets under each section (lines outside the four are kept but not read
 *  as facts). */
export function coreFacts(text: string): { section: string; fact: string }[] {
  const out: { section: string; fact: string }[] = [];
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) section = h[1].trim();
    else if (section) {
      const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (b) out.push({ section, fact: b[1] });
    }
  }
  return out;
}

/** `text` with `fact` added at the end of `section` (made if missing). The same
 *  fact already there anywhere leaves it unchanged. */
export function addFact(text: string | null, section: CoreSection, fact: string): string {
  const base = text?.trim() ? text : EMPTY_CORE;
  const f = cleanFact(fact);
  if (coreFacts(base).some((x) => norm(x.fact) === norm(f))) return base;
  const nl = base.includes("\r\n") ? "\r\n" : "\n";
  const lines = base.split(/\r?\n/);
  const start = lines.findIndex((l) => norm(l.replace(/^##\s+/, "")) === norm(section) && /^##\s/.test(l));
  if (start < 0) {
    const body = base.replace(/\s+$/, "");
    return `${body}${nl}${nl}## ${section}${nl}- ${f}${nl}`;
  }
  // After the section's last non-blank line, before the next heading.
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `- ${f}`);
  return lines.join(nl);
}

/** `text` without the facts that match `fact`: the one whose text it is, else the
 *  ones that contain it. Several containing it and none equal to it is ambiguous:
 *  nothing is removed, and `matches` says which. */
export function removeFact(text: string, fact: string): { text: string; removed: string[]; matches: string[] } {
  const f = norm(cleanFact(fact));
  const facts = coreFacts(text).map((x) => x.fact);
  const exact = facts.filter((x) => norm(x) === f);
  const partial = f ? facts.filter((x) => norm(x).includes(f)) : [];
  const gone = exact.length ? exact : partial.length === 1 ? partial : [];
  if (!gone.length) return { text, removed: [], matches: partial };
  const drop = new Set(gone.map(norm));
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).filter((l) => {
    const b = l.match(/^\s*[-*]\s+(.*\S)\s*$/);
    return !(b && drop.has(norm(b[1])));
  });
  return { text: lines.join(nl), removed: gone, matches: partial };
}

/** The system message's block that carries the profile into a thread, or null
 *  when it holds no facts. Marked so a request after a compaction can carry it on. */
export function coreText(text: string | null): string | null {
  if (!text || !coreFacts(text).length) return null;
  return `${CORE_OPEN}
Your core memory of the user, from memory/core.md (they can edit it; you edit it with remember_core and forget_core). It is what you know about them in every thread: use it without mentioning it. A standing instruction here is theirs, but it never counts as grantedBy for a call.

${text.trim().slice(0, CORE_MAX_CHARS)}
</core_memory>`;
}

export const CORE_OPEN = "<core_memory>";
