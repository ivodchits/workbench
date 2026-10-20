import { describe, expect, it } from "vitest";

import { fixtures, sessionLines, sessionNames } from "./fixtures.test-util";
import { createTranscript, type Item, type ToolItem } from "./model";

function fold(lines: string[], sidechain = false): Item[] {
  const t = createTranscript({ sidechain });
  t.append(lines);
  return [...t.items];
}
const foldFixture = (name: string) => fold(fixtures[name]);
const tools = (items: Item[]) => items.filter((i): i is ToolItem => i.kind === "tool");
const kinds = (items: Item[]) => items.map((i) => i.kind);

describe("T0 fixtures", () => {
  it("has all of them", () => {
    expect(sessionNames).toHaveLength(15);
    expect(Object.keys(fixtures)).toHaveLength(17);
  });

  it.each(Object.keys(fixtures))("%s folds, and every tool call has its result", (name) => {
    const items = fold(fixtures[name], name.includes("sidechain"));
    expect(items.length).toBeGreaterThan(0);
    expect(tools(items).filter((t) => t.status === "running")).toEqual([]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("text turn", () => {
    const items = foldFixture("01-text-turn");
    expect(kinds(items)).toEqual(["user", "assistant", "turn-end"]);
    expect(items[1]).toMatchObject({ kind: "assistant", isError: false });
    expect(items[2]).toMatchObject({ durationMs: 5539 });
  });

  it("read: tool calls between two answers", () => {
    const items = foldFixture("02-read");
    expect(kinds(items)).toEqual(["user", "assistant", "tool", "tool", "assistant", "turn-end"]);
    expect(tools(items).map((t) => [t.name, t.status])).toEqual([
      ["Glob", "ok"],
      ["Read", "ok"],
    ]);
    expect(tools(items)[1].resultText).toContain("beta");
  });

  it("bash: output comes from the structured result", () => {
    const [bash] = tools(foldFixture("03-bash-auto-allowed"));
    expect(bash).toMatchObject({ name: "Bash", status: "ok", stdout: "hello-t0", stderr: "" });
    expect(bash.input.command).toBe("echo hello-t0");
  });

  it("denied edit, then the interruption marker", () => {
    const items = foldFixture("05-edit-permission-denied");
    const edit = tools(items).find((t) => t.name === "Edit");
    expect(edit).toMatchObject({ status: "denied", diff: null });
    expect(items[items.length - 2]).toMatchObject({ kind: "interrupted", forToolUse: true });
  });

  it("edit and write carry a diff; failed tools are errors", () => {
    const [edit, write, read, bash] = tools(foldFixture("06-edit-write-failed-tools"));
    expect(edit.diff?.[0].lines).toEqual(["-def add(a, b):", "+def add_numbers(a, b):", "     return a + b"]);
    expect(write.diff?.[0].lines).toEqual(["+hi", "+there"]);
    expect(read).toMatchObject({ name: "Read", status: "error" });
    expect(read.resultText).toContain("File does not exist");
    expect(bash).toMatchObject({ name: "Bash", status: "error", stdout: null, resultText: "Exit code 3\n7" });
  });

  it("questions keep their options and get their answers", () => {
    const [single] = tools(foldFixture("07-ask-single-select"));
    expect(single.questions).toHaveLength(1);
    expect(single.questions?.[0]).toMatchObject({ question: "Which color do you prefer?", answer: "Green" });
    expect(single.questions?.[0].options.map((o) => o.label)).toContain("Green");

    const [multi] = tools(foldFixture("08-ask-multi-question-multi-select"));
    expect(multi.questions?.map((q) => [q.multiSelect, q.answer])).toEqual([
      [false, "Large"],
      [true, "Cheese, Basil"],
    ]);

    const [free] = tools(foldFixture("09-ask-free-text"));
    expect(free.questions?.[0].answer).toBe("a purple axolotl");
  });

  it("plan approved, then a permission prompt cancelled", () => {
    const items = foldFixture("10-plan-approved-then-permission-cancelled");
    expect(items[1].kind).toBe("thinking");
    const byName = Object.fromEntries(tools(items).map((t) => [t.name, t]));
    expect(byName.ExitPlanMode.status).toBe("ok");
    expect(String(byName.ExitPlanMode.input.plan)).toContain("subtract");
    expect(byName.Edit.status).toBe("ok");
    expect(byName.Bash.status).toBe("denied");
    expect(items.some((i) => i.kind === "interrupted" && i.forToolUse)).toBe(true);
  });

  it("subagent: the later task notification completes the Agent call", () => {
    const items = foldFixture("11-subagent");
    const [agent] = tools(items);
    expect(agent.status).toBe("ok");
    expect(agent.agent).toMatchObject({
      description: "Count lines in two files",
      type: "Explore",
      agentId: "a76e7c21d40c641bd",
      running: false,
    });
    expect(agent.agent?.result).toContain("`notes.txt`: 3 lines");
    // The notification is not something the user typed.
    expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(items.some((i) => i.kind === "notice")).toBe(false);
  });

  it("subagent: while it runs, the call is still running", () => {
    const lines = fixtures["11-subagent"];
    const cut = lines.findIndex((l) => l.includes("<task-notification>"));
    const [agent] = tools(fold(lines.slice(0, cut)));
    expect(agent.status).toBe("running");
    expect(agent.agent).toMatchObject({ running: true, result: null });
  });

  it("subagent file folds on its own when asked for the sidechain", () => {
    const lines = fixtures["11-subagent.sidechain"];
    expect(fold(lines)).toEqual([]);
    const items = fold(lines, true);
    expect(kinds(items)).toEqual(["user", "tool", "tool", "assistant"]);
  });

  it("interrupted turn keeps the partial answer", () => {
    const items = foldFixture("12-interrupted-turn");
    expect(kinds(items)).toEqual(["user", "thinking", "assistant", "interrupted"]);
    expect(items[items.length - 1]).toMatchObject({ forToolUse: false });
  });

  it("slash command with its output", () => {
    const items = foldFixture("13-slash-command");
    const command = items.find((i) => i.kind === "command");
    expect(command).toMatchObject({ name: "/context", args: "" });
    expect(command?.kind === "command" && command.output).toContain("Context Usage");
    // The markdown copy written for the model (isMeta) is not shown.
    expect(items[items.length - 1]).toBe(command);
  });

  it("image paste", () => {
    const items = foldFixture("14-image-paste");
    expect(items[0]).toMatchObject({ kind: "user" });
    expect(items[0].kind === "user" && items[0].images.map((i) => i.mediaType)).toEqual(["image/png"]);
    expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  it("/compact becomes one divider carrying the summary", () => {
    const items = foldFixture("15-compact");
    expect(kinds(items)).toEqual(["divider", "user", "assistant", "turn-end"]);
    expect(items[0]).toMatchObject({ reason: "compact", preTokens: 73767, postTokens: 7058 });
    expect(items[0].kind === "divider" && items[0].summary).toContain("Primary Request");
    expect(items[1]).toMatchObject({ text: "Reply with only the word AFTERCOMPACT." });
  });

  it("/clear starts the new file with a divider", () => {
    const items = foldFixture("16-clear-new-session");
    expect(kinds(items)).toEqual(["divider", "user", "assistant", "turn-end"]);
    expect(items[0]).toMatchObject({ reason: "clear" });
  });
});

describe("delivery", () => {
  const whole = () => fold(sessionLines);

  it("is the same line by line as all at once", () => {
    const t = createTranscript();
    for (const line of sessionLines) t.append([line]);
    expect(t.items).toEqual(whole());
  });

  it("ignores lines it has already seen", () => {
    const t = createTranscript();
    expect(t.append(sessionLines)).toBe(true);
    const before = structuredClone(t.items);
    expect(t.append(sessionLines)).toBe(false);
    expect(t.append(sessionLines.slice(-40))).toBe(false);
    expect(t.items).toEqual(before);
  });

  it("pairs calls and results across a page boundary, wherever it falls", () => {
    const expected = whole();
    for (let cut = 25; cut < sessionLines.length; cut += 97) {
      const t = createTranscript();
      t.append(sessionLines.slice(cut));
      expect(t.prepend(sessionLines.slice(0, cut))).toBe(true);
      expect(t.items).toEqual(expected);
    }
  });

  it("pages in from the end in several steps", () => {
    const t = createTranscript();
    const size = 120;
    for (let end = sessionLines.length; end > 0; end -= size) {
      t.prepend(sessionLines.slice(Math.max(0, end - size), end));
    }
    expect(t.items).toEqual(whole());
  });

  it("a result whose call is in an unloaded page is held back, not shown bare", () => {
    const lines = fixtures["03-bash-auto-allowed"];
    const call = lines.findIndex((l) => l.includes('"tool_use"'));
    const t = createTranscript();
    t.append(lines.slice(call + 1));
    expect(tools([...t.items])).toEqual([]);
    t.prepend(lines.slice(0, call + 1));
    expect(tools([...t.items])).toMatchObject([{ name: "Bash", status: "ok" }]);
  });

  it("reset forgets everything, including what it has seen", () => {
    const t = createTranscript();
    t.append(fixtures["01-text-turn"]);
    t.reset();
    expect(t.items).toEqual([]);
    expect(t.append(fixtures["01-text-turn"])).toBe(true);
    expect(t.items).toHaveLength(3);
  });

  it("drops the pasted-content markers around pasted text", () => {
    const text = 'see this:\n<pasted_content id="da8e">\nline one\nline two\n</pasted_content id="da8e">';
    const items = fold([JSON.stringify({ type: "user", uuid: "a", message: { content: text } })]);
    expect(items).toMatchObject([{ kind: "user", text: "see this:\nline one\nline two" }]);
  });

  it("skips what it does not understand", () => {
    const t = createTranscript();
    const changed = t.append([
      "{ not json",
      "[]",
      "null",
      '{"type":"brand-new-line-type","uuid":"a"}',
      '{"type":"user"}',
      '{"type":"user","uuid":"b","message":null}',
      '{"type":"assistant","uuid":"c","message":{"content":[null,{"type":"mystery"},{"type":"tool_use"}]}}',
      '{"type":"user","uuid":"d","message":{"content":[{"type":"tool_result","tool_use_id":"nope"}]}}',
      '{"type":"system","uuid":"e","subtype":"something_new","content":"fyi","level":"info"}',
      '{"type":"system","uuid":"f","subtype":"api_error","content":"overloaded","level":"error"}',
    ]);
    expect(changed).toBe(true);
    expect(t.items).toMatchObject([{ kind: "notice", level: "error", text: "overloaded" }]);
  });
});
