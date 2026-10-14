// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteChoice } from "../remote/protocol";
import { createChoiceCard } from "./choice";

const permission = (over: Partial<RemoteChoice> = {}): RemoteChoice => ({
  id: "c1",
  kind: "permission",
  toolName: "Bash",
  input: { command: "rm -rf build", description: "Remove the build folder" },
  questions: [],
  options: [
    { key: 1, label: "Yes", detail: "", typed: false },
    { key: 2, label: "No, and tell Claude what to do differently", detail: "", typed: true },
  ],
  terminalOnly: null,
  sent: null,
  ...over,
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const click = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!.click();

describe("phone choice card", () => {
  let chosen: [string, number | "deny"][];
  let terminal: number;
  const card = (compact: boolean) =>
    createChoiceCard(compact, {
      choose: (id, option) => chosen.push([id, option]),
      terminal: () => terminal++,
    });

  beforeEach(() => {
    chosen = [];
    terminal = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("offers the prompt's options and sends the one tapped, once", () => {
    const c = card(false);
    c.update(permission());
    expect(c.root.classList.contains("hidden")).toBe(false);
    expect(c.root.textContent).toContain("Remove the build folder");
    expect(buttons(c.root)).toEqual([
      "1Yes",
      "2No, and tell Claude what to do differently — typed in the terminal",
      "answer in terminal",
      "deny",
    ]);
    click(c.root, "Yes");
    expect(chosen).toEqual([["c1", 1]]);
    // Shown as sent at once; nothing left to tap.
    expect(c.root.textContent).toContain("sent: Yes");
    expect(buttons(c.root)).toEqual([]);
    // The next snapshot still says nothing was sent: the tap is remembered.
    c.update(permission());
    expect(buttons(c.root)).toEqual([]);
    // No sign of it closing: point at the terminal, never re-send.
    vi.advanceTimersByTime(4000);
    expect(buttons(c.root)).toEqual(["check the terminal"]);
    click(c.root, "check the terminal");
    expect(terminal).toBe(1);
    expect(chosen).toHaveLength(1);
  });

  it("switches to the terminal after an option that is typed there", () => {
    const c = card(false);
    c.update(permission());
    click(c.root, "No, and tell");
    expect(chosen).toEqual([["c1", 2]]);
    expect(terminal).toBe(1);
  });

  it("starts fresh for the next prompt and hides when none is open", () => {
    const c = card(true);
    c.update(permission({ sent: "Yes" }));
    expect(c.root.textContent).toContain("sent: Yes");
    c.update(permission({ id: "c2" }));
    expect(buttons(c.root)).toEqual(["1Yes", "2No, and tell Claude what to do differently — typed in the terminal", "terminal", "deny"]);
    click(c.root, "deny");
    expect(chosen).toEqual([["c2", "deny"]]);
    c.update(null);
    expect(c.root.classList.contains("hidden")).toBe(true);
  });

  it("sends a prompt it can't answer to the terminal", () => {
    const c = card(true);
    c.update(
      permission({ kind: "plan", toolName: "ExitPlanMode", options: [], terminalOnly: "the approval options have not been read from the terminal" }),
    );
    expect(c.root.textContent).toContain("plan ready");
    expect(c.root.textContent).toContain("have not been read");
    expect(buttons(c.root)).toEqual(["terminal", "cancel"]);
  });

  it("doesn't redraw for an unchanged snapshot", () => {
    const c = card(false);
    c.update(permission());
    const first = c.root.firstElementChild;
    c.update(permission());
    expect(c.root.firstElementChild).toBe(first);
  });
});
