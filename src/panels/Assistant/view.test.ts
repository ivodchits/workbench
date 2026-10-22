import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../ipc/assistant";
import { lineDiff, oneLine, overviewOrder, readableInput, sessionLink, toItems, unreadTotal } from "./view";

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
  it("shows a web search as a chip, and its citations as numbered links (B1)", () => {
    seq = 0;
    const page = (url: string, title: string) => ({ type: "web_search_result", url, title, encrypted_content: "e" });
    const cite = (url: string, title: string) => ({ type: "web_search_result_location", url, title, cited_text: "…" });
    const items = toItems([
      msg("user", [{ type: "text", text: "what's new in Tauri?" }]),
      msg(
        "assistant",
        [
          { type: "tool_search_tool_result", tool_use_id: "ts1", content: {} },
          { type: "server_tool_use", id: "ts1", name: "tool_search_tool_regex", input: { pattern: "x" } },
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "tauri release" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [page("https://tauri.app/b(1)", "Tauri [2.10]"), page("https://x.dev", "X")] },
          { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://gone.dev" } },
          { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" } },
          { type: "text", text: "It has a new updater.", citations: [cite("https://tauri.app/b(1)", "Tauri [2.10]")] },
          { type: "text", text: " And faster builds.", citations: [cite("https://x.dev", "X"), cite("https://tauri.app/b(1)", "Tauri [2.10]")] },
        ],
        "duck",
      ),
    ]);
    // The tool search's own call isn't shown; the web's are, with their results.
    expect(items.map((i) => (i.kind === "tool" ? i.name : i.kind))).toEqual(["user", "web_search", "web_fetch", "reply"]);
    const [search, fetch] = items.filter((i) => i.kind === "tool");
    expect(search.result).toEqual({ text: "Tauri [2.10] — https://tauri.app/b(1)\nX — https://x.dev", isError: false });
    expect(fetch.result).toEqual({ text: "failed: url_not_accessible", isError: true });
    const reply = items[items.length - 1];
    expect(reply?.kind === "reply" && reply.text).toBe(
      "It has a new updater.[¹](https://tauri.app/b%281%29) And faster builds.[¹](https://tauri.app/b%281%29)[²](https://x.dev)" +
        "\n\nSources: ¹ [Tauri 2.10](https://tauri.app/b%281%29) · ² [X](https://x.dev)",
    );
  });

  it("shows a compaction's line where it cut, not where it was stored (A6)", () => {
    seq = 0;
    const say = (t: string) => [{ type: "text", text: t }];
    const items = toItems([
      msg("user", say("old")),
      msg("assistant", say("old reply"), "duck"),
      msg("user", say("kept")),
      msg("assistant", say("kept reply"), "duck"),
      msg("notice", { kind: "compacted", text: "Compacted here", compaction: { summary: "s", through: 1 } }, "duck"),
      msg("notice", { kind: "compacted", text: "Nothing to compact yet" }, "duck"),
    ]);
    expect(items.map((i) => (i.kind === "notice" ? i.notice.text : i.kind))).toEqual([
      "user",
      "reply",
      "Compacted here",
      "user",
      "reply",
      "Nothing to compact yet",
    ]);
  });

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

  it("shows a core memory edit as a chip with its diff (W4)", () => {
    seq = 0;
    const memory = { path: "C:\\Duck\\memory\\core.md", before: null, after: "## About you\n- x\n" };
    const items = toItems([msg("notice", { kind: "memory", text: "Duck remembered: x", memory }, "duck")]);
    expect(items).toMatchObject([{ kind: "memory", text: "Duck remembered: x", edit: memory }]);
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

describe("threads at a glance", () => {
  it("puts unread threads first, then the ones at work, then the recent", () => {
    const threads = [
      { id: "a", updated: 5 },
      { id: "b", updated: 4 },
      { id: "c", updated: 3 },
      { id: "d", updated: 2 },
    ];
    const order = overviewOrder(
      { threads, unread: { d: 2 }, autopilots: [{ threadId: "c", state: "running" }], tasks: [{ threadId: "b", state: "done" }] },
      () => false,
    );
    expect(order.map((t) => t.id)).toEqual(["d", "c", "a", "b"]);
    expect(unreadTotal({ unread: { a: 1, d: 2 } })).toBe(3);
  });
});
