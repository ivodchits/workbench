import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../ipc/assistant";
import { lineDiff, oneLine, readableInput, sessionLink, toItems } from "./view";

let seq = 0;
const msg = (
  role: StoredMessage["role"],
  content: unknown,
  source = "desktop",
): StoredMessage => ({
  threadId: "t",
  seq: seq++,
  ts: 0,
  role,
  content,
  source,
});

describe("toItems", () => {
  it("folds a tool round trip into text, a chip with its result, and the answer", () => {
    seq = 0;
    const items = toItems([
      msg("user", [{ type: "text", text: "time?" }]),
      msg("system", { content: [], output_config: { effort: "high" } }, "duck"),
      msg("assistant", [
        { type: "thinking", thinking: "…", signature: "s" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "u1", name: "get_time", input: {} },
        {
          type: "tool_use",
          id: "u2",
          name: "test_confirm",
          input: { action: "x" },
        },
      ]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "u1",
          content: [{ type: "text", text: "12:00" }],
        },
        {
          type: "tool_result",
          tool_use_id: "u2",
          content: "declined",
          is_error: true,
        },
      ]),
      msg("assistant", [{ type: "text", text: "It's noon." }]),
      msg("notice", { kind: "stopped", text: "Stopped." }, "duck"),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "reply",
      "tool",
      "tool",
      "reply",
      "notice",
    ]);
    expect(items[2]).toMatchObject({
      name: "get_time",
      result: { text: "12:00", isError: false },
    });
    expect(items[3]).toMatchObject({
      name: "test_confirm",
      result: { text: "declined", isError: true },
    });
    expect(items[4]).toMatchObject({ text: "It's noon." });
  });

  it("leaves a call without a result open, and shows where a message came from", () => {
    seq = 0;
    const items = toItems([
      msg("user", [{ type: "text", text: "hi" }], "phone"),
      msg("assistant", [
        {
          type: "tool_use",
          id: "u1",
          name: "test_confirm",
          input: { action: "x" },
        },
      ]),
    ]);
    expect(items[0]).toMatchObject({ kind: "user", source: "phone" });
    expect(items[1]).toMatchObject({ kind: "tool", result: null });
  });
});

describe("helpers", () => {
  it("summarizes input in one line", () => {
    expect(oneLine({})).toBe("");
    expect(oneLine({ a: "x".repeat(100) }, 20)).toHaveLength(20);
  });

  it("reads only well-formed session links", () => {
    expect(sessionLink("#session/abc-123")).toBe("abc-123");
    expect(sessionLink("#session/")).toBeNull();
    expect(sessionLink("https://x/#session/abc")).toBeNull();
    expect(sessionLink(null)).toBeNull();
  });
});

describe("action items (W2)", () => {
  it("shows a Workbench event as a line, not a bubble, and a note edit as a chip", () => {
    seq = 0;
    const edit = {
      projectId: "p",
      project: "P",
      name: "plan",
      before: "a",
      after: "b",
      revision: "r2",
    };
    const items = toItems([
      msg("user", [{ type: "text", text: "<workbench_event>\nSession x is done.\n</workbench_event>" }], "event"),
      msg("notice", { kind: "note", text: "Duck edited plan", note: edit }, "duck"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["event", "note"]);
    expect(items[0]).toMatchObject({ text: "Session x is done." });
    expect(items[1]).toMatchObject({ text: "Duck edited plan", edit });
  });
});

describe("readableInput", () => {
  it("writes an input as field: value lines", () => {
    expect(readableInput({ session: "api", option: 1, tags: ["a"] })).toBe(
      ["session: api", "option: 1", 'tags: ["a"]'].join(String.fromCharCode(10)),
    );
    expect(readableInput("x")).toBe('"x"');
  });
});

describe("lineDiff", () => {
  it("marks changed lines and cuts long unchanged runs", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
    expect(lineDiff(before, after, 1)).toEqual([
      { op: " ", text: "4" },
      { op: "-", text: "5" },
      { op: "+", text: "five" },
      { op: " ", text: "6" },
      null,
      { op: " ", text: "8" },
      { op: "+", text: "9" },
    ]);
    expect(lineDiff("", "new\n")).toEqual([{ op: "+", text: "new" }]);
    expect(lineDiff("same\n", "same")).toEqual([]);
  });
});
