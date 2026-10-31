// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { holdSelection, keepingSelection, restoreSelection } from "./keepSelection";

let root: HTMLElement;
const sel = () => window.getSelection()!;

/** Select `len` characters from `start` in `node`'s text (backward: from the end). */
function select(node: Node, start: number, len: number, backward = false) {
  if (backward) sel().setBaseAndExtent(node, start + len, node, start);
  else sel().setBaseAndExtent(node, start, node, start + len);
}

beforeEach(() => {
  document.body.innerHTML = `
    <p id="outside">a terminal's text</p>
    <div id="chat">
      <div class="reply"><p>check out <code>agent/fix-duck-chat-focus</code> first</p></div>
      <div id="stream"><p>and then the stre</p></div>
    </div>`;
  root = document.getElementById("chat")!;
  sel().removeAllRanges();
});

const code = () => root.querySelector("code")!.firstChild!;

describe("holdSelection", () => {
  it("holds a selection in the root by its text offsets", () => {
    select(code(), 6, 3);
    const held = holdSelection(root)!;
    expect(held.text).toBe("fix");
    expect(held.end - held.start).toBe(3);
    expect(held.backward).toBe(false);
  });

  it("knows a backward selection", () => {
    select(code(), 6, 3, true);
    expect(holdSelection(root)!.backward).toBe(true);
  });

  it("holds nothing for a caret or a selection elsewhere", () => {
    expect(holdSelection(root)).toBeNull();
    select(code(), 4, 0);
    expect(holdSelection(root)).toBeNull();
    select(document.getElementById("outside")!.firstChild!, 2, 8);
    expect(holdSelection(root)).toBeNull();
  });
});

describe("keeping a selection through a repaint", () => {
  it("puts it back after the reply above is rebuilt with the same text", () => {
    select(code(), 0, 25);
    keepingSelection(root, () => {
      root.querySelector(".reply")!.innerHTML = "<p>check out <code>agent/fix-duck-chat-focus</code> first</p>";
    });
    expect(sel().toString()).toBe("agent/fix-duck-chat-focus");
    expect(sel().anchorNode!.isConnected).toBe(true);
  });

  it("survives the streaming reply growing under it", () => {
    const stream = document.getElementById("stream")!;
    select(stream.querySelector("p")!.firstChild!, 4, 4);
    expect(sel().toString()).toBe("then");
    keepingSelection(root, () => {
      stream.innerHTML = "<p>and then the <strong>stream</strong> goes on</p>";
    });
    expect(sel().toString()).toBe("then");
  });

  it("keeps its direction", () => {
    select(code(), 6, 3, true);
    keepingSelection(root, () => {
      root.querySelector(".reply")!.innerHTML = "<p>check out <code>agent/fix-duck-chat-focus</code> first</p>";
    });
    expect(sel().toString()).toBe("fix");
    expect(sel().focusOffset).toBeLessThan(sel().anchorOffset);
  });

  it("lets it go when the text there changed", () => {
    select(code(), 0, 5);
    keepingSelection(root, () => {
      root.querySelector(".reply")!.innerHTML = "<p>something else entirely, longer</p>";
    });
    expect(sel().toString()).toBe("");
  });

  it("leaves an untouched selection alone", () => {
    select(code(), 0, 5);
    const node = sel().anchorNode;
    expect(restoreSelection(root, holdSelection(root))).toBe(false);
    expect(sel().anchorNode).toBe(node);
  });

  it("does nothing without one", () => {
    keepingSelection(root, () => {
      root.querySelector(".reply")!.innerHTML = "<p>new</p>";
    });
    expect(sel().rangeCount === 0 || sel().isCollapsed).toBe(true);
  });
});
