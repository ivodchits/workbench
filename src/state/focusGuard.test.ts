// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { duckHoldsFocus, markFocusIntent, watchFocusIntent } from "./focusGuard";

let stop: () => void;
let now = 10_000;
const $ = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="dock"><textarea id="term"></textarea></div>
    <div data-wb-duck tabindex="-1" aria-hidden="false">
      <p id="reply">branch <code>agent/fix-duck-chat-focus</code></p>
      <button id="open">open diff</button>
      <textarea id="composer"></textarea>
    </div>`;
  window.getSelection()!.removeAllRanges();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  now += 60_000; // any earlier intent has run out
  stop = watchFocusIntent();
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

const press = (id: string) => $(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

describe("duckHoldsFocus", () => {
  it("holds while the keyboard is in the open drawer", () => {
    $("composer").focus();
    expect(duckHoldsFocus()).toBe(true);
  });

  it("holds while text is selected in the drawer, wherever the focus is", () => {
    $("term").focus();
    expect(duckHoldsFocus()).toBe(false);
    const code = document.querySelector("code")!;
    window.getSelection()!.selectAllChildren(code);
    expect(duckHoldsFocus()).toBe(true);
  });

  it("doesn't hold for a closed drawer", () => {
    $("composer").focus();
    document.querySelector("[data-wb-duck]")!.setAttribute("aria-hidden", "true");
    expect(duckHoldsFocus()).toBe(false);
  });

  it("lets a chord you pressed through, for a while", () => {
    $("composer").focus();
    markFocusIntent();
    expect(duckHoldsFocus()).toBe(false);
    now += 2_000;
    expect(duckHoldsFocus()).toBe(true);
  });

  it("a click on a drawer control or outside it is intent; one on its text or composer isn't", () => {
    $("composer").focus();
    press("reply");
    expect(duckHoldsFocus()).toBe(true);
    press("composer");
    expect(duckHoldsFocus()).toBe(true);
    press("open");
    expect(duckHoldsFocus()).toBe(false);
    now += 2_000;
    press("dock");
    expect(duckHoldsFocus()).toBe(false);
  });

  it("Enter on a drawer button is intent; Enter in the composer (sending) isn't", () => {
    $("composer").focus();
    $("composer").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(duckHoldsFocus()).toBe(true);
    $("open").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(duckHoldsFocus()).toBe(false);
  });
});
