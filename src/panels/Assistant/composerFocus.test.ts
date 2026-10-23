// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { focusUnlessReading, isReading, isTypingKey, selectionWithin, sendsToComposer, watchSelecting, type KeyLike } from "./composerFocus";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...mods,
});

describe("isTypingKey", () => {
  it("is a character, shifted or not, AltGr included", () => {
    for (const k of ["a", "Z", "1", " ", "é", "😀", "/"]) expect(isTypingKey(key(k))).toBe(true);
    expect(isTypingKey(key("A", { shiftKey: true }))).toBe(true);
    expect(isTypingKey(key("@", { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("isn't a chord, a named key or mid-composition", () => {
    for (const k of ["ArrowUp", "ArrowLeft", "PageDown", "Home", "Enter", "Tab", "Backspace", "Shift", "Control", "F5"])
      expect(isTypingKey(key(k))).toBe(false);
    expect(isTypingKey(key("c", { ctrlKey: true }))).toBe(false);
    expect(isTypingKey(key("c", { metaKey: true }))).toBe(false);
    expect(isTypingKey(key("x", { altKey: true }))).toBe(false);
    expect(isTypingKey(key("a", { isComposing: true }))).toBe(false);
  });
});

describe("sendsToComposer", () => {
  let thread: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-wb-duck tabindex="-1">
        <div id="thread"><p id="reply">branch agent/let-duck-chat-text-be-selectable</p></div>
        <button id="btn">think hard</button>
        <input id="field" />
        <div id="ce" contenteditable="true"></div>
        <textarea id="composer"></textarea>
      </div>`;
    thread = document.getElementById("reply")!;
  });

  it("sends a typed character from the thread", () => {
    expect(sendsToComposer(key("h"), thread)).toBe(true);
    expect(sendsToComposer(key("H", { shiftKey: true }), thread)).toBe(true);
    expect(sendsToComposer(key("h"), document.querySelector("[data-wb-duck]"))).toBe(true);
  });

  it("sends a paste, so Ctrl/Cmd+V lands in the composer", () => {
    expect(sendsToComposer(key("v", { ctrlKey: true }), thread)).toBe(true);
    expect(sendsToComposer(key("V", { ctrlKey: true, shiftKey: true }), thread)).toBe(true);
    expect(sendsToComposer(key("v", { metaKey: true }), thread)).toBe(true);
  });

  it("leaves copy, select-all, cut, the arrows and other chords alone", () => {
    for (const k of ["c", "a", "x", "z", "C"]) {
      expect(sendsToComposer(key(k, { ctrlKey: true }), thread)).toBe(false);
      expect(sendsToComposer(key(k, { metaKey: true }), thread)).toBe(false);
    }
    for (const k of ["ArrowDown", "ArrowRight", "PageUp", "End", "Enter", "Escape", "Tab"])
      expect(sendsToComposer(key(k), thread)).toBe(false);
  });

  it("leaves fields their own keys", () => {
    for (const id of ["field", "ce", "composer"]) {
      expect(sendsToComposer(key("h"), document.getElementById(id))).toBe(false);
      expect(sendsToComposer(key("v", { ctrlKey: true }), document.getElementById(id))).toBe(false);
    }
  });

  it("lets Space press a button, but a letter on it still types", () => {
    const btn = document.getElementById("btn");
    expect(sendsToComposer(key(" "), btn)).toBe(false);
    expect(sendsToComposer(key("h"), btn)).toBe(true);
    expect(sendsToComposer(key(" "), thread)).toBe(true);
  });

  it("stands down for a key already handled", () => {
    expect(sendsToComposer(key("h", { defaultPrevented: true }), thread)).toBe(false);
  });
});

describe("refocusing while you read", () => {
  let root: HTMLElement;
  let composer: HTMLTextAreaElement;
  let stop: () => void;

  beforeEach(() => {
    document.body.innerHTML = `
      <p id="outside">a terminal's text</p>
      <div data-wb-duck tabindex="-1">
        <p id="reply">branch <code>agent/let-duck-chat-text-be-selectable</code></p>
        <textarea id="composer"></textarea>
      </div>`;
    root = document.querySelector("[data-wb-duck]")!;
    composer = document.getElementById("composer") as HTMLTextAreaElement;
    stop = watchSelecting(root);
    window.getSelection()!.removeAllRanges();
  });
  afterEach(() => stop());

  const select = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  it("sees a selection in the drawer, not a caret or one elsewhere", () => {
    expect(selectionWithin(root)).toBe(false);
    select(document.getElementById("reply")!);
    expect(selectionWithin(root)).toBe(true);
    expect(window.getSelection()!.toString()).toBe("branch agent/let-duck-chat-text-be-selectable");
    window.getSelection()!.collapseToStart();
    expect(selectionWithin(root)).toBe(false);
    select(document.getElementById("outside")!);
    expect(selectionWithin(root)).toBe(false);
  });

  it("doesn't take the focus from a selection", () => {
    select(document.querySelector("code")!);
    focusUnlessReading(composer);
    expect(document.activeElement).not.toBe(composer);
    expect(window.getSelection()!.toString()).toBe("agent/let-duck-chat-text-be-selectable");
  });

  it("waits while the button is down, mid-drag", () => {
    root.querySelector("#reply")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(isReading(composer)).toBe(true);
    focusUnlessReading(composer);
    expect(document.activeElement).not.toBe(composer);
    // It comes up anywhere, even outside the drawer.
    document.getElementById("outside")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    expect(isReading(composer)).toBe(false);
    focusUnlessReading(composer);
    expect(document.activeElement).toBe(composer);
  });

  it("a right-click isn't a drag", () => {
    root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    expect(isReading(composer)).toBe(false);
  });

  it("focuses the composer when nothing is selected", () => {
    focusUnlessReading(composer);
    expect(document.activeElement).toBe(composer);
  });

  it("a selection outside the drawer doesn't hold it", () => {
    select(document.getElementById("outside")!);
    focusUnlessReading(composer);
    expect(document.activeElement).toBe(composer);
  });
});
