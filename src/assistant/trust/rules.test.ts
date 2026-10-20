import { describe, expect, it } from "vitest";

import { evaluate, matches, parseRule, type Rule, type RuleTarget } from "./rules";

const on = (pattern: string, t: RuleTarget) => matches(parseRule(pattern), t);
const rule = (effect: Rule["effect"], pattern: string, projectId: string | null = null): Rule => ({
  id: `${effect}:${pattern}:${projectId}`,
  effect,
  pattern,
  projectId,
  created: 0,
});

describe("rule syntax", () => {
  it("parses Tool and Tool(specifier), and says what's wrong otherwise", () => {
    expect(parseRule("assistant:write_note")).toEqual({ tool: "assistant:write_note", specifier: null });
    expect(parseRule(" Bash(npm test:*) ")).toEqual({ tool: "Bash", specifier: "npm test:*" });
    expect(parseRule("assistant:answer_choice(question)").specifier).toBe("question");
    expect(() => parseRule("Bash()")).toThrow(/empty specifier/);
    expect(() => parseRule("rm -rf")).toThrow(/isn't a rule/);
  });
});

describe("matching", () => {
  it("Bash: a `:*` prefix stops at a word, `*` matches anywhere", () => {
    const bash = (command: string) => ({ tool: "Bash", projectId: null, command });
    expect(on("Bash(npm test:*)", bash("npm test"))).toBe(true);
    expect(on("Bash(npm test:*)", bash("npm  test -- auth"))).toBe(true);
    expect(on("Bash(npm test:*)", bash("npm testing"))).toBe(false);
    expect(on("Bash(git log *)", bash("git log --oneline -5"))).toBe(true);
    expect(on("Bash(git status)", bash("git status -s"))).toBe(false);
    expect(on("Bash", bash("anything at all"))).toBe(true);
  });

  it("file tools: globs relative to the root, `//` absolute, `~/` home", () => {
    const edit = (path: string) => ({ tool: "Edit", projectId: null, path, root: "C:\\repo", home: "C:/Users/me" });
    expect(on("Edit(src/**)", edit("C:\\repo\\src\\a\\b.ts"))).toBe(true);
    expect(on("Edit(src/**)", edit("src/x.ts"))).toBe(true);
    expect(on("Edit(src/*.ts)", edit("src/a/b.ts"))).toBe(false);
    expect(on("Edit(src/**/*.ts)", edit("src/b.ts"))).toBe(true);
    expect(on("Edit(src/**)", edit("C:/other/src/x.ts"))).toBe(false);
    expect(on("Read(//C:/Windows/**)", { ...edit("C:\\Windows\\win.ini"), tool: "Read" })).toBe(true);
    expect(on("Read(~/.claude/**)", { ...edit("C:/Users/me/.claude/settings.json"), tool: "Read" })).toBe(true);
  });

  it("WebFetch: a domain covers its subdomains, not look-alikes", () => {
    const fetch = (url: string) => ({ tool: "WebFetch", projectId: null, url });
    expect(on("WebFetch(domain:docs.rs)", fetch("https://docs.rs/serde"))).toBe(true);
    expect(on("WebFetch(domain:rs)", fetch("https://docs.rs/"))).toBe(true);
    expect(on("WebFetch(domain:docs.rs)", fetch("https://evildocs.rs/"))).toBe(false);
    expect(on("WebFetch(domain:docs.rs)", fetch("not a url"))).toBe(false);
  });

  it("Duck's tools: by name, a name glob, or what the tool says about the call", () => {
    const choice = (specifier?: string) => ({ tool: "assistant:answer_choice", projectId: null, specifier });
    expect(on("assistant:answer_choice", choice("permission"))).toBe(true);
    expect(on("assistant:*", choice())).toBe(true);
    expect(on("assistant:answer_choice(question)", choice("question"))).toBe(true);
    expect(on("assistant:answer_choice(question)", choice("permission"))).toBe(false);
    expect(on("assistant:answer_choice(question)", choice())).toBe(false);
    expect(on("assistant:write_note", choice("question"))).toBe(false);
  });
});

describe("evaluate", () => {
  const t: RuleTarget = { tool: "assistant:write_note", projectId: "p1" };

  it("deny beats ask beats allow, in any order", () => {
    expect(evaluate([rule("allow", "assistant:write_note"), rule("ask", "assistant:*")], t)?.effect).toBe("ask");
    expect(
      evaluate([rule("deny", "assistant:write_note"), rule("allow", "assistant:*"), rule("ask", "assistant:write_note")], t)
        ?.effect,
    ).toBe("deny");
    expect(evaluate([rule("allow", "assistant:write_note")], t)?.rule.pattern).toBe("assistant:write_note");
  });

  it("uses global rules and the call's own project's, never another project's", () => {
    expect(evaluate([rule("allow", "assistant:write_note", "p2")], t)).toBeNull();
    expect(evaluate([rule("allow", "assistant:write_note", "p1")], t)?.effect).toBe("allow");
    expect(evaluate([rule("allow", "assistant:write_note", "p1")], { ...t, projectId: null })).toBeNull();
  });

  it("skips a rule that doesn't parse", () => {
    expect(evaluate([rule("deny", "not a rule"), rule("allow", "assistant:write_note")], t)?.effect).toBe("allow");
  });
});
