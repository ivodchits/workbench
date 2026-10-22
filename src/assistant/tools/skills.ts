// Duck's skills (step S2): `load_skill` returns a skill's instructions when a
// request fits its description (every request lists them, `skillsBlock`), and
// `draft_skill` writes a new or changed `SKILL.md`, shown on a card first.
//
// - A skill's `tools:` narrows the rest of the turn it's loaded in to those tools.
// - A draft is the whole file, frontmatter and all, checked as the engine will
//   read it before the card; once allowed, it's listed from the next request on.

import { z } from "zod";

import { parseSkill, usable, type Skill, type SkillsHost } from "../skills";
import { defineTool, type PrepareEnv } from "./registry";

function host(env: Pick<PrepareEnv, "skills">): SkillsHost {
  if (!env.skills) throw new Error("Duck's skills aren't available here.");
  return env.skills;
}

async function find(h: SkillsHost, name: string): Promise<Skill> {
  const all = await h.list();
  const s = all.find((x) => x.name === name.trim());
  if (!s) throw new Error(`No skill "${name}". The skills are: ${all.filter(usable).map((x) => x.name).join(", ") || "none yet"}.`);
  return s;
}

export const loadSkill = defineTool({
  name: "load_skill",
  description:
    "Load one of the skills listed in the <skills> block: its instructions for this kind of request. Call it before anything else when a request fits a skill's description, then follow what it returns.",
  schema: z.object({ name: z.string().trim().min(1).max(64) }),
  tier: "read",
  async run({ name }, ctx) {
    const s = await find(host(ctx), name);
    if (!s.enabled) throw new Error(`The skill "${s.name}" is turned off in Duck's settings.`);
    if (s.problems.length) throw new Error(`The skill "${s.name}" can't be used: ${s.problems.join("; ")}.`);
    if (s.mode) throw new Error(`"${s.name}" is a mode, not a skill: use switch_mode with mode "${s.mode.id}".`);
    if (s.tools) ctx.narrow?.(s.name, s.tools);
    return {
      skill: s.name,
      instructions: s.body,
      ...(s.tools && { tools: `for the rest of this turn you can call only: ${s.tools.join(", ")}` }),
    };
  },
});

const draftSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens")
    .max(64)
    .describe("The skill's folder name, e.g. morning-briefing."),
  text: z
    .string()
    .min(20)
    .max(60_000)
    .describe(
      "The whole SKILL.md: frontmatter between --- lines (name: the same name; description: when to use it, with the words the user says for it, in each language they use), then the instructions in markdown.",
    ),
  why: z.string().trim().min(1).max(200).describe("What it's for, in a sentence: the card's line and the commit message."),
});

interface DraftPlan {
  before: string | null;
  skill: Skill;
}

export const draftSkill = defineTool<typeof draftSchema, DraftPlan>({
  name: "draft_skill",
  description: [
    "Write one of Duck's skills: skills/<name>/SKILL.md in Duck's workspace, a new one or a change to one (read it first with load_skill).",
    'Use it when the user asks for one ("make that a skill"), or offer it when the same multi-step request has come up about three times. The user sees the draft on a card and allows it; it works from the next request on.',
    "Frontmatter: name; description (what requests it fits, with the user's own words for them, e.g. \"доброе утро\"); optionally tools: [a, b] to limit a turn that loads it to those tools.",
    "A mode instead of a skill (a kind of thread, like an interviewer): add mode: <id>, and optionally title, effort (low, medium, high) and pauses (quick, patient, thinking); the body is that thread's prompt, and its tools are the ones in tools: (or the common ones).",
    "Instructions only: no code to run.",
  ].join(" "),
  schema: draftSchema,
  tier: "consequential",
  async prepare({ name, text }, _port, env) {
    const h = host(env ?? {});
    const before = (await h.list()).find((s) => s.name === name)?.text ?? null;
    if (before === text) throw new Error("the draft is the same as the file");
    const { frontmatter, body } = splitDraft(text);
    const skill = parseSkill(
      { name, path: "", rel: `skills/${name}/SKILL.md`, fields: frontmatter, body, text, problems: draftProblems(name, frontmatter) },
      h.known(),
    );
    if (skill.problems.length) throw new Error(`the draft can't be used: ${skill.problems.join("; ")}`);
    return { before, skill };
  },
  describe: ({ name, why }, _port, p) =>
    `${p.before === null ? "Add" : "Change"} Duck's ${p.skill.mode ? "mode" : "skill"} "${name}": ${why}.`,
  review: ({ name }, p) => [{ label: `skills/${name}/SKILL.md`, before: p.before, after: p.skill.text }],
  trust: () => ({ projectId: null, asks: "a new or changed skill is yours to approve" }),
  async run({ name, why }, ctx) {
    await host(ctx).write(name, ctx.prepared.skill.text, ctx.prepared.before, `skills: ${why.slice(0, 72)}`);
    const m = ctx.prepared.skill.mode;
    return {
      written: `skills/${name}/SKILL.md`,
      takesEffect: m
        ? `the mode "${m.id}" is in the drawer's picker now, and switch_mode takes it`
        : "it's listed from the next request on; load it with load_skill",
    };
  },
});

/** The draft's frontmatter lines and body, read as the backend reads a file. */
export function splitDraft(text: string): { frontmatter: [string, string][]; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: [], body: "" };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const fields: [string, string][] = [];
  for (const l of lines.slice(1, end < 0 ? undefined : end)) {
    const m = /^\s*([^\s:#-][^\s:]*)\s*:(.*)$/.exec(l);
    if (m) fields.push([m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2")]);
  }
  return { frontmatter: fields, body: end < 0 ? "" : lines.slice(end + 1).join("\n").trim() };
}

/** What the backend would say about these frontmatter lines in `name`'s folder. */
function draftProblems(name: string, fields: [string, string][]): string[] {
  if (!fields.length) return ["it doesn't open with a --- frontmatter block"];
  const get = (k: string) => fields.find(([f]) => f === k)?.[1];
  const out: string[] = [];
  const n = get("name");
  if (n !== undefined && n !== name) out.push(`its name (${n}) isn't its folder's (${name})`);
  if (!get("description")?.trim()) out.push("it has no description (what Duck matches a request against)");
  return out;
}

export const SKILL_TOOLS = [loadSkill, draftSkill];
