import { afterEach, describe, expect, it } from "vitest";

import type { SkillFileRow } from "../ipc/duckSkills";
import { SAFETY_RULES } from "./config";
import { findMode, setUserModes } from "./modes";
import { createSkills, listField, parseSkill, skillsBlock, type SkillStore } from "./skills";
import { splitDraft } from "./tools/skills";

const KNOWN = new Set(["get_time", "list_sessions", "switch_mode", "load_skill", "remember"]);

function row(name: string, text: string, problems: string[] = []): SkillFileRow {
  const { frontmatter, body } = splitDraft(text);
  return { name, path: `/ws/skills/${name}/SKILL.md`, rel: `skills/${name}/SKILL.md`, fields: frontmatter, body, text, problems };
}

const skill = (name: string, more: string, body = "Do it.") => `---\nname: ${name}\ndescription: ${name} things\n${more}---\n${body}`;

describe("skills (S2)", () => {
  afterEach(() => setUserModes([]));

  it("reads a list field in each spelling", () => {
    expect(listField("[get_time, list_sessions]")).toEqual(["get_time", "list_sessions"]);
    expect(listField("get_time list_sessions")).toEqual(["get_time", "list_sessions"]);
    expect(listField('["get_time"]')).toEqual(["get_time"]);
  });

  it("reads the frontmatter as the backend does", () => {
    const d = splitDraft('﻿---\r\nname: x\r\ndescription: "a: b"\r\n# a comment\r\n- item\r\n---\r\n\r\nBody\r\n');
    expect(d).toEqual({ frontmatter: [["name", "x"], ["description", "a: b"]], body: "Body" });
    expect(splitDraft("no fence")).toEqual({ frontmatter: [], body: "" });
  });

  it("narrows with known tools only, and a skill with a problem isn't used", () => {
    const ok = parseSkill(row("brief", skill("brief", "tools: [get_time]\n")), KNOWN);
    expect(ok.tools).toEqual(["get_time"]);
    expect(ok.problems).toEqual([]);
    const typo = parseSkill(row("brief", skill("brief", "tools: [get_tme]\n")), KNOWN);
    expect(typo.problems).toEqual(["tools that Duck doesn't have: get_tme"]);
    const empty = parseSkill(row("brief", skill("brief", "", "")), KNOWN);
    expect(empty.problems).toEqual(["it has no instructions after the frontmatter"]);
    const off = parseSkill(row("brief", skill("brief", "")), KNOWN, ["brief"]);
    expect(off.enabled).toBe(false);
    const block = skillsBlock([
      parseSkill(row("zeta", skill("zeta", "")), KNOWN),
      typo,
      off,
      parseSkill(row("alpha", skill("alpha", "")), KNOWN),
    ]);
    expect(block?.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- alpha: alpha things", "- zeta: zeta things"]);
    expect(skillsBlock([typo, off])).toBeNull();
  });

  it("makes a mode from mode: with its prompt, tools, effort and pauses", () => {
    const s = parseSkill(
      row("interviewer", skill("interviewer", "mode: interviewer\ntitle: Interviewer\neffort: high\npauses: thinking\ntools: get_time\n", "Ask.")),
      KNOWN,
    );
    expect(s.problems).toEqual([]);
    expect(s.tools).toBeNull();
    expect(s.mode).toMatchObject({ id: "interviewer", title: "Interviewer", effort: "high", voicePatience: "thinking", tools: ["get_time", "switch_mode"] });
    expect(s.mode?.systemPrompt).toContain("Ask.");
    expect(s.mode?.systemPrompt).toContain(SAFETY_RULES);
    // Without tools: the common ones.
    const plain = parseSkill(row("coach", skill("coach", "mode: coach\n")), KNOWN);
    expect(plain.mode?.tools).toContain("remember");
    expect(plain.mode?.effort).toBe("medium");
    // Not one of Duck's own, and only the values the settings know.
    const dup = parseSkill(row("duck2", skill("duck2", "mode: duck\neffort: huge\npauses: slow\nbackend: cloud\n")), KNOWN);
    expect(dup.problems).toEqual([
      '"duck" is one of Duck\'s own modes',
      "effort is one of low, medium, high, xhigh, max",
      "pauses is one of quick, patient, thinking",
      "backend is api or session",
    ]);
    // Thinking on the subscription (D3).
    expect(parseSkill(row("coach", skill("coach", "mode: coach\nbackend: session\n")), KNOWN).mode?.backend).toBe("session");
    expect(plain.mode).not.toHaveProperty("backend");
    expect(skillsBlock([s])).toContain("- interviewer: interviewer things");
  });

  it("registers the usable modes as it reads, and tells of a change once", async () => {
    const files: Record<string, string> = { interviewer: skill("interviewer", "mode: interviewer\n") };
    let disabled: string[] = [];
    const store: SkillStore = {
      list: async () => Object.keys(files).map((n) => row(n, files[n])),
      write: async (name, text) => {
        files[name] = text;
      },
    };
    const host = createSkills({ store, tools: () => KNOWN, disabled: () => disabled });
    const seen: number[] = [];
    host.onChange((l) => seen.push(l.length));
    await host.list();
    await host.list();
    expect(seen).toEqual([1]);
    expect(findMode("interviewer")?.id).toBe("interviewer");
    disabled = ["interviewer"];
    await host.list();
    expect(findMode("interviewer")).toBeNull();
    await host.write("brief", skill("brief", ""), null, "skills: brief");
    expect(seen).toEqual([1, 1, 2]);
  });
});
