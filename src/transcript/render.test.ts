// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { fixtures, sessionLines } from "./fixtures.test-util";
import { createTranscript, type Item } from "./model";
import { createRenderer, renderItem } from "./render";

function fold(lines: string[], sidechain = false): Item[] {
  const t = createTranscript({ sidechain });
  t.append(lines);
  return [...t.items];
}

/** Open every card under `root`, nested ones included, the way a click would. */
function openAll(root: HTMLElement): void {
  for (;;) {
    const closed = [root, ...root.querySelectorAll("details")].filter(
      (d): d is HTMLDetailsElement => d instanceof HTMLDetailsElement && !d.open,
    );
    if (closed.length === 0) return;
    for (const d of closed) {
      d.open = true;
      d.dispatchEvent(new Event("toggle"));
    }
  }
}

function user(id: string, text: string): string {
  return JSON.stringify({ type: "user", uuid: id, message: { role: "user", content: text } });
}
function assistant(id: string, block: unknown): string {
  return JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", content: [block] } });
}
function result(id: string, toolUseId: string, content: string, extra: object = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: id,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    ...extra,
  });
}

describe("T0 fixtures", () => {
  it.each(Object.keys(fixtures))("%s renders, cards open included", (name) => {
    const items = fold(fixtures[name], name.includes("sidechain"));
    const host = document.createElement("div");
    createRenderer(host).update(items);
    expect(host.children).toHaveLength(items.length);
    expect([...host.children].map((c) => (c as HTMLElement).dataset.itemId)).toEqual(items.map((i) => i.id));
    openAll(host);
    expect(host.querySelectorAll("script, iframe, img:not(.wb-tx-image)")).toHaveLength(0);
  });

  it("shows a tool call as one line, and its result on opening it", () => {
    const [, tool] = fold(fixtures["03-bash-auto-allowed"]);
    const node = renderItem(tool);
    expect(node.querySelector(".wb-tx-tool-name")?.textContent).toBe("Bash");
    expect(node.querySelector(".wb-tx-tool-target")?.textContent).toBe("echo hello-t0");
    expect(node.classList.contains("wb-tx-tool-ok")).toBe(true);
    expect(node.querySelector(".wb-tx-body")).toBeNull();
    openAll(node);
    expect(node.querySelector(".wb-tx-body")?.textContent).toContain("hello-t0");
  });

  it("shows an edit as a path with counts, and a diff on opening it", () => {
    const edit = fold(fixtures["06-edit-write-failed-tools"]).find((i) => i.kind === "tool")!;
    const node = renderItem(edit);
    expect(node.querySelector(".wb-tx-tool-target")?.textContent).toBe("…/proj/calc.py");
    expect(node.querySelector(".wb-tx-tool-meta")?.textContent).toBe("+1 −1");
    openAll(node);
    expect([...node.querySelectorAll(".wb-tx-diff-line")].map((l) => l.className.split("-").pop())).toEqual([
      "del",
      "add",
      "ctx",
    ]);
  });

  it("shows the subagent's description and its final report", () => {
    const agent = fold(fixtures["11-subagent"]).find((i) => i.kind === "tool")!;
    const node = renderItem(agent);
    expect(node.querySelector(".wb-tx-summary")?.textContent).toContain("Explore");
    expect(node.querySelector(".wb-tx-summary")?.textContent).toContain("Count lines in two files");
    openAll(node);
    expect(node.querySelector(".wb-tx-body .wb-md")?.textContent).toContain("3 lines");
  });

  it("marks the answer that was picked", () => {
    const ask = fold(fixtures["07-ask-single-select"]).find((i) => i.kind === "tool")!;
    const node = renderItem(ask);
    expect(node.querySelector(".wb-tx-tool-target")?.textContent).toBe("Which color do you prefer? → Green");
    openAll(node);
    expect(node.querySelector(".wb-tx-option-picked")?.textContent).toContain("Green");
  });
});

describe("untrusted content", () => {
  const nasty = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script><b onclick="x()">hi</b>';

  it("sanitizes assistant markdown", () => {
    const [item] = fold([assistant("a", { type: "text", text: `${nasty}\n\n[link](https://example.com)` })]);
    const node = renderItem(item);
    expect(node.querySelectorAll("img, script, [onclick], [onerror]")).toHaveLength(0);
    expect(node.querySelector("b")?.textContent).toBe("hi");
    const link = node.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("drops javascript: links", () => {
    const [item] = fold([assistant("a", { type: "text", text: "[x](javascript:alert(1))" })]);
    expect(renderItem(item).querySelector("a[href^='javascript']")).toBeNull();
  });

  it("never parses user text or tool output as HTML", () => {
    const items = fold([
      user("u", nasty),
      assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: nasty } }),
      result("r", "t1", nasty, { toolUseResult: { stdout: nasty, stderr: nasty } }),
      assistant("b", { type: "tool_use", id: "t2", name: "SomethingNew", input: { arg: nasty } }),
      result("s", "t2", nasty),
    ]);
    const host = document.createElement("div");
    createRenderer(host).update(items);
    openAll(host);
    expect(host.querySelectorAll("img, script, b")).toHaveLength(0);
    expect(host.querySelector(".wb-tx-user-text")?.textContent).toBe(nasty);
    expect(host.textContent).toContain("<script>");
  });
});

describe("copy buttons", () => {
  const source = "Two lines\nof one paragraph.\n\n```sh\necho hi\n```\n";

  it("copy the message as markdown, and a code block as its code", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    const node = renderItem(fold([assistant("a", { type: "text", text: source })])[0]);
    node.querySelector<HTMLButtonElement>(":scope > .wb-tx-copy")!.click();
    node.querySelector<HTMLButtonElement>(".wb-tx-code > .wb-tx-copy")!.click();
    await Promise.resolve();
    expect(copied).toEqual([source, "echo hi"]);
    expect(node.querySelector(".wb-tx-copied")).not.toBeNull();
  });

  it("add nothing to the text a selection would copy", () => {
    const node = renderItem(fold([assistant("a", { type: "text", text: source })])[0]);
    expect(node.querySelectorAll(".wb-tx-copy")).toHaveLength(2);
    expect(node.textContent).not.toMatch(/copy/);
    // A paragraph's source line break is a soft one: it copies as a space.
    expect(node.querySelector("p")?.innerHTML).toBe("Two lines\nof one paragraph.");
    expect(node.querySelector("br")).toBeNull();
  });
});

describe("long output", () => {
  it("is cut, with a button that shows the rest", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const items = fold([
      assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: "seq" } }),
      result("r", "t1", long, { toolUseResult: { stdout: long, stderr: "" } }),
    ]);
    const node = renderItem(items[0]);
    openAll(node);
    const pre = node.querySelectorAll(".wb-tx-pre")[1];
    expect(pre.textContent?.split("\n")).toHaveLength(40);
    const more = node.querySelector<HTMLButtonElement>(".wb-tx-more")!;
    expect(more.textContent).toBe("show all (200 lines)");
    more.click();
    expect(pre.textContent).toBe(long);
    expect(node.querySelector(".wb-tx-more")).toBeNull();
  });
});

describe("renderer", () => {
  it("keeps untouched elements and carries an open card across its update", () => {
    const t = createTranscript();
    const host = document.createElement("div");
    const r = createRenderer(host);
    t.append([
      user("u", "go"),
      assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1" } }),
    ]);
    r.update(t.items);
    const [userNode, running] = [...host.children] as HTMLElement[];
    expect(running.classList.contains("wb-tx-tool-running")).toBe(true);
    openAll(running);

    t.append([result("r", "t1", "ok", { toolUseResult: { stdout: "done", stderr: "" } }), user("v", "next")]);
    r.update(t.items);
    expect(host.children).toHaveLength(3);
    expect(host.children[0]).toBe(userNode);
    const done = host.children[1] as HTMLDetailsElement;
    expect(done).not.toBe(running);
    expect(done.classList.contains("wb-tx-tool-ok")).toBe(true);
    expect(done.open).toBe(true);
    expect(done.querySelector(".wb-tx-body")?.textContent).toContain("done");
  });

  it("puts an earlier page above what is already shown", () => {
    const cut = Math.floor(sessionLines.length / 2);
    const t = createTranscript();
    const host = document.createElement("div");
    const r = createRenderer(host);
    t.append(sessionLines.slice(cut));
    r.update(t.items);
    const last = host.lastElementChild;
    expect(last).not.toBeNull();
    t.prepend(sessionLines.slice(0, cut));
    r.update(t.items);
    expect(host.lastElementChild).toBe(last);
    expect([...host.children].map((c) => (c as HTMLElement).dataset.itemId)).toEqual(t.items.map((i) => i.id));
  });

  it("empties the container on reset", () => {
    const t = createTranscript();
    const host = document.createElement("div");
    const r = createRenderer(host);
    t.append(fixtures["01-text-turn"]);
    r.update(t.items);
    t.reset();
    r.update(t.items);
    expect(host.children).toHaveLength(0);
    r.clear();
  });
});
