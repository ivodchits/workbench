// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { encodePaste, getDraft, insertIntoDraft, setDraft, spliceText, terminalCommand } from "./composer";
import { atRest } from "./queue";
import type { LiveStatus } from "./status";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function live(patch: Partial<LiveStatus>): LiveStatus {
  return { phase: "idle", compacting: false, subagents: 0, updatedAt: 0, needsSince: null, ...patch } as LiveStatus;
}

describe("drafts", () => {
  beforeEach(() => localStorage.clear());

  it("are kept per instance, and outlive the window", () => {
    setDraft("a", "first");
    setDraft("b", "second");
    expect(getDraft("a")).toBe("first");
    expect(getDraft("b")).toBe("second");
    expect(localStorage.getItem("wb-draft:a")).toBe("first");
    // A window that has not seen this instance yet reads the saved draft.
    localStorage.setItem("wb-draft:c", "from another window");
    expect(getDraft("c")).toBe("from another window");
  });

  it("leave nothing behind once sent", () => {
    setDraft("a", "text");
    setDraft("a", "");
    expect(getDraft("a")).toBe("");
    expect(localStorage.getItem("wb-draft:a")).toBeNull();
  });

  it("take inserted text on a line of its own", () => {
    insertIntoDraft("d", "one");
    insertIntoDraft("d", "two");
    expect(getDraft("d")).toBe("one\ntwo");
  });
});

describe("paste encoding", () => {
  it("wraps the text so a line break does not submit", () => {
    expect(decode(encodePaste("a\nb\r\nc"))).toBe("\x1b[200~a\rb\rc\x1b[201~");
  });

  it("cannot be ended early by the text itself", () => {
    const out = decode(encodePaste("safe\x1b[201~\rrm -rf"));
    expect(out.indexOf("\x1b[201~")).toBe(out.length - 6);
    expect(out.split("\x1b")).toHaveLength(3);
  });
});

describe("commands that answer in the terminal", () => {
  it("are the bare built-ins with a menu or a screen", () => {
    expect(terminalCommand("/model")).toBe("model");
    expect(terminalCommand("  /resume \n")).toBe("resume");
  });

  it("are not commands with an argument, other commands, or prose", () => {
    expect(terminalCommand("/model opus")).toBeNull();
    expect(terminalCommand("/clear")).toBeNull();
    expect(terminalCommand("/compact")).toBeNull();
    expect(terminalCommand("/my-skill")).toBeNull();
    expect(terminalCommand("see /model\n/model")).toBeNull();
    expect(terminalCommand("what does /model do")).toBeNull();
  });
});

describe("inserting a template", () => {
  it("replaces the selection and leaves the caret after it", () => {
    expect(spliceText("hello world", 6, 11, "there")).toEqual({ text: "hello there", selection: [11, 11] });
  });

  it("selects the first placeholder to type over", () => {
    const out = spliceText("", 0, 0, "Review {0} for {1} bugs");
    expect(out.text.slice(...out.selection)).toBe("{0}");
  });
});

describe("at rest", () => {
  it("is between turns, or before any signal", () => {
    expect(atRest(undefined)).toBe(true);
    expect(atRest(live({ phase: "idle" }))).toBe(true);
    expect(atRest(live({ phase: "done" }))).toBe(true);
  });

  it("is not mid-turn, waiting on an answer, or compacting", () => {
    expect(atRest(live({ phase: "working" }))).toBe(false);
    expect(atRest(live({ phase: "needs_you" }))).toBe(false);
    expect(atRest(live({ phase: "done", compacting: true }))).toBe(false);
  });
});
