// Duck's skills (step S2): new behaviors are a file, `skills/<name>/SKILL.md` in
// Duck's workspace, written by hand or by Duck (`draft_skill`, once you allow it).
// The files are read by `src-tauri/src/assistant/skills.rs`, which watches them;
// this is what they mean.
//
// - A skill is a description (what a request it fits looks like) and a body (the
//   instructions). Every request lists the usable skills' names and descriptions in
//   a block after the system prompt (`skillsBlock`), sorted, so the cached prefix
//   holds until a skill changes; `load_skill` returns a body when a request fits.
// - `tools:` in the frontmatter can only narrow: once a skill with it is loaded,
//   the rest of that turn may call only those tools (and load_skill). A name that
//   isn't one of Duck's tools is a problem.
// - `mode:` makes the skill a mode instead (S1's registry, `setUserModes`): a
//   thread started in it runs with the body as its prompt (with the basics every
//   mode has and the safety rules), the frontmatter's `tools:` (the common ones
//   when there are none), `effort:` and `pauses:`, and `title:` for the picker.
// - A skill with a problem, or turned off in the settings, isn't used.

import { SAFETY_RULES } from "./config";
import { BASICS, COMMON_TOOLS, isModeId, setUserModes, type Mode, type Patience } from "./modes";
import type { Effort } from "./protocol";
import type { SkillFileRow } from "../ipc/duckSkills";

export interface Skill {
  name: string;
  description: string;
  /** The `SKILL.md`'s absolute path, for the editor. */
  path: string;
  /** `skills/<name>/SKILL.md`. */
  rel: string;
  body: string;
  /** The whole file as read. */
  text: string;
  /** The tools it narrows a turn to; null: no narrowing. */
  tools: string[] | null;
  /** The mode it declares, if it's a mode. */
  mode: Mode | null;
  /** Why it isn't used; empty when it can be. */
  problems: string[];
  /** Not turned off in the settings. */
  enabled: boolean;
}

const EFFORT_VALUES: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const PATIENCE_VALUES: readonly Patience[] = ["quick", "patient", "thinking"];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `[a, b]`, `a, b` or `a b` as names. */
export function listField(v: string): string[] {
  return v
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** The mode's system prompt: the skill's body, inside what every mode has. */
function modePrompt(title: string, rel: string, body: string): string {
  return `You are Duck, the assistant built into Workbench, a desktop app where one person runs several Claude Code coding sessions side by side. This thread is in "${title}", a mode the user defined in ${rel}. Its instructions:

${body}

How you work in every mode:
${BASICS}

${SAFETY_RULES}`;
}

/** One file as Duck uses it. `known`: Duck's tool names. */
export function parseSkill(row: SkillFileRow, known: ReadonlySet<string>, disabled: readonly string[] = []): Skill {
  const field = (k: string) => row.fields.find(([f]) => f === k)?.[1]?.trim() || null;
  const problems = [...row.problems];
  const toolsField = field("tools");
  const tools = toolsField === null ? null : listField(toolsField);
  const unknown = (tools ?? []).filter((t) => !known.has(t));
  if (unknown.length) problems.push(`tools that Duck doesn't have: ${unknown.join(", ")}`);
  if (!row.body.trim() && !row.problems.length) problems.push("it has no instructions after the frontmatter");

  let mode: Mode | null = null;
  const modeId = field("mode");
  if (modeId !== null) {
    const effort = field("effort") ?? "medium";
    const pauses = field("pauses");
    const title = field("title") ?? modeId;
    if (!KEBAB.test(modeId) || modeId.length > 40) problems.push("its mode isn't lowercase words joined by hyphens");
    else if (isModeId(modeId)) problems.push(`"${modeId}" is one of Duck's own modes`);
    if (!EFFORT_VALUES.includes(effort as Effort)) problems.push(`effort is one of ${EFFORT_VALUES.join(", ")}`);
    if (pauses !== null && !PATIENCE_VALUES.includes(pauses as Patience)) problems.push(`pauses is one of ${PATIENCE_VALUES.join(", ")}`);
    if (title.length > 40) problems.push("its title is longer than 40 characters");
    const own = tools ?? [...COMMON_TOOLS];
    mode = {
      id: modeId,
      title,
      about: field("description") ?? "",
      effort: effort as Effort,
      systemPrompt: modePrompt(title, row.rel, row.body.trim()),
      // A mode can always be left.
      tools: own.includes("switch_mode") ? own : [...own, "switch_mode"],
      voicePatience: (pauses as Patience | null) ?? null,
    };
  }
  return {
    name: row.name,
    description: field("description") ?? "",
    path: row.path,
    rel: row.rel,
    body: row.body,
    text: row.text,
    tools: mode ? null : tools,
    mode,
    problems,
    enabled: !disabled.includes(row.name),
  };
}

export const usable = (s: Skill) => s.enabled && s.problems.length === 0;

/** The block every request carries after the system prompt: the usable skills,
 *  and the modes they add, by name. Null when there are none. */
export function skillsBlock(skills: readonly Skill[]): string | null {
  const ok = skills.filter(usable).sort((a, b) => a.name.localeCompare(b.name));
  const plain = ok.filter((s) => !s.mode);
  const modes = ok.flatMap((s) => (s.mode ? [s.mode] : []));
  if (!plain.length && !modes.length) return null;
  const lines = ["<skills>"];
  if (plain.length) {
    lines.push(
      "Skills: instructions for kinds of request, written by the user or by you. When a request fits one's description, call load_skill with its name before anything else and follow what it returns.",
      ...plain.map((s) => `- ${s.name}: ${s.description}`),
    );
  }
  if (modes.length) {
    lines.push(
      "The user's own modes, from their skills (switch_mode takes these too):",
      ...modes.map((m) => `- ${m.id}: ${m.about}`),
    );
  }
  lines.push("</skills>");
  return lines.join("\n");
}

/** Where the files are: the IPC commands, or fakes in tests. */
export interface SkillStore {
  list(): Promise<SkillFileRow[]>;
  write(name: string, text: string, expected: string | null, message: string): Promise<void>;
}

export interface SkillsHost {
  /** Every skill, read now (the backend reads the files again only after a
   *  change). The modes they declare are registered as it reads. */
  list(): Promise<Skill[]>;
  /** Write `name`'s file over `expected` (what was read) and commit it. */
  write(name: string, text: string, expected: string | null, message: string): Promise<void>;
  /** Duck's tool names, which a skill's `tools:` may name. */
  known(): ReadonlySet<string>;
  /** Called when the list differs from the one read before. */
  onChange(cb: (skills: Skill[]) => void): () => void;
}

export function createSkills(deps: { store: SkillStore; tools: () => ReadonlySet<string>; disabled: () => readonly string[] }): SkillsHost {
  const listeners = new Set<(s: Skill[]) => void>();
  let last = "";
  let reading: Promise<Skill[]> | null = null;

  async function read(): Promise<Skill[]> {
    const rows = await deps.store.list();
    const known = deps.tools();
    const skills = rows.map((r) => parseSkill(r, known, deps.disabled()));
    const sig = JSON.stringify(skills.map((s) => [s.text, s.problems, s.enabled]));
    if (sig !== last) {
      last = sig;
      setUserModes(skills.filter(usable).flatMap((s) => (s.mode ? [s.mode] : [])));
      for (const l of listeners) l(skills);
    }
    return skills;
  }

  return {
    // One read at a time: a turn's requests and the settings page share it.
    list() {
      reading ??= read().finally(() => (reading = null));
      return reading;
    },
    async write(name, text, expected, message) {
      await deps.store.write(name, text, expected, message);
      // Not a read already under way: it may have started before the write.
      await read();
    },
    known: deps.tools,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
