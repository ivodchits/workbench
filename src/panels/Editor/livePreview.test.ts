import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";

import { activeLines, linkAt, liveDecorations } from "./livePreview";

function stateOf(doc: string, cursor = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** What the reader sees with these lines active: the text with hidden ranges cut
 *  out and widgets as their glyphs. */
function shown(doc: string, active: number[]) {
  const state = stateOf(doc);
  const cuts = liveDecorations(state, new Set(active))
    // The replacing ones: marks and line styles carry a class.
    .filter((r) => r.from < r.to && !r.value.spec.class)
    .sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const r of cuts) {
    if (r.from < at) continue;
    out += doc.slice(at, r.from);
    const widget = (r.value.spec as { widget?: { checked?: boolean } }).widget;
    if (widget) out += "checked" in widget ? (widget.checked ? "[x]" : "[ ]") : "•";
    at = r.to;
  }
  return out + doc.slice(at);
}

function classesOnLine(doc: string, n: number) {
  const state = stateOf(doc);
  const start = state.doc.line(n).from;
  return liveDecorations(state, new Set())
    .filter((r) => r.from === start && r.from === r.to)
    .map((r) => r.value.spec.class as string)
    .join(" ");
}

describe("live markdown", () => {
  it("hides heading, emphasis and code markup off the active line", () => {
    const doc = "# Title\n\nSome **bold**, *it* and `code`.";
    expect(shown(doc, [])).toBe("Title\n\nSome bold, it and code.");
    expect(classesOnLine(doc, 1)).toContain("cm-md-h1");
  });

  it("keeps the markup on the line being edited", () => {
    const doc = "# Title\n\nSome **bold**.";
    expect(shown(doc, [3])).toBe("Title\n\nSome **bold**.");
    expect(shown(doc, [1])).toBe("# Title\n\nSome bold.");
  });

  it("shows a link as its text", () => {
    expect(shown("see [docs](https://example.com) here", [])).toBe("see docs here");
    expect(shown("see [docs](https://example.com) here", [1])).toBe("see [docs](https://example.com) here");
    expect(shown("at <https://x.org>.", [])).toBe("at https://x.org.");
  });

  it("draws bullets and task boxes", () => {
    expect(shown("- one\n- [ ] two\n- [x] three", [])).toBe("• one\n[ ] two\n[x] three");
    expect(classesOnLine("- [x] done", 1)).toContain("cm-md-done");
  });

  it("hides quote marks and fences, keeping the language label", () => {
    expect(shown("> quoted", [])).toBe("quoted");
    expect(classesOnLine("> quoted", 1)).toContain("cm-md-quote");
    const fence = "```ts\nlet a = 1;\n```";
    expect(shown(fence, [])).toBe("ts\nlet a = 1;\n");
    expect(classesOnLine(fence, 2)).toContain("cm-md-fence");
  });

  it("reads the active lines from the selection", () => {
    const state = stateOf("a\nb\nc", 2);
    expect([...activeLines(state)]).toEqual([2]);
  });

  it("finds a link's address under the cursor", () => {
    const state = stateOf("see [docs](https://example.com) and <https://x.org>");
    expect(linkAt(state, 6)).toBe("https://example.com");
    expect(linkAt(state, 40)).toBe("https://x.org");
    expect(linkAt(state, 1)).toBeNull();
  });
});
