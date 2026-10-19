import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../ipc/assistant";
import { oneLine, sessionLink, toItems } from "./view";

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
