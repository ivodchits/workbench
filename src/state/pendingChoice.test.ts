import { describe, expect, it } from "vitest";

import type { HookEvent } from "../ipc/hooks";
import type { Item } from "../transcript/model";
import { parseOptionRows, reduceChoice, resolvedBy, type ChoiceState, type PendingChoice } from "./pendingChoice";

const EMPTY: ChoiceState = { lastTool: null, pending: null };

function event(name: string, extra: Record<string, unknown> = {}): HookEvent {
  return {
    session_id: "s",
    hook_event_name: name,
    transcript_path: null,
    cwd: null,
    permission_mode: "default",
    tool_name: null,
    ...extra,
  };
}

/** Fold a run of events, as the store does. */
function run(events: HookEvent[], from: ChoiceState = EMPTY): ChoiceState {
  return events.reduce((state, e, i) => reduceChoice(state, e, 1000 + i), from);
}

const BASH = { tool_name: "Bash", tool_input: { command: "mkdir out", description: "Create out" } };

function asked(extra: Record<string, unknown> = BASH, id = "toolu_1"): ChoiceState {
  return run([event("PreToolUse", { ...extra, tool_use_id: id }), event("PermissionRequest", extra)]);
}

describe("a permission prompt", () => {
  it("opens on the request, with the tool, its input and the id from the tool's start", () => {
    const { pending } = asked();
    expect(pending).toMatchObject({
      kind: "permission",
      toolName: "Bash",
      input: { command: "mkdir out" },
      toolUseId: "toolu_1",
      source: "generic",
      terminalOnly: null,
      sent: null,
    });
    // Until the terminal's options are read: a plain Allow on the first option.
    expect(pending?.options).toEqual([{ key: 1, label: "Allow", detail: "", typed: false }]);
  });

  it("has no tool id when the tool before it was another one", () => {
    const state = run([
      event("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_0" }),
      event("PermissionRequest", BASH),
    ]);
    expect(state.pending?.toolUseId).toBeNull();
  });

  it("closes when its tool runs, and on everything that ends needs-you", () => {
    expect(run([event("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_1" })], asked()).pending).toBeNull();
    expect(run([event("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "toolu_1" })], asked()).pending).toBeNull();
    for (const name of ["PostToolBatch", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "PermissionDenied"]) {
      expect(run([event(name)], asked()).pending, name).toBeNull();
    }
  });

  it("stays open through other tools' events and the reminder notification", () => {
    const state = run(
      [
        event("Notification", { notification_type: "permission_prompt" }),
        event("PreToolUse", { tool_name: "Read", tool_use_id: "toolu_sub", agent_id: "a1" }),
        event("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_sub", agent_id: "a1" }),
        event("SubagentStop", { agent_id: "a1" }),
      ],
      asked(),
    );
    expect(state.pending?.toolUseId).toBe("toolu_1");
  });

  it("is replaced by the next prompt, under a new id", () => {
    const first = asked();
    const second = run(
      [
        event("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_1" }),
        event("PreToolUse", { tool_name: "Edit", tool_use_id: "toolu_2" }),
        event("PermissionRequest", { tool_name: "Edit", tool_input: { file_path: "a.py" } }),
      ],
      first,
    );
    expect(second.pending?.toolName).toBe("Edit");
    expect(second.pending?.id).not.toBe(first.pending?.id);
  });

  it("returns the same state when nothing changed", () => {
    const state = asked();
    expect(reduceChoice(state, event("Notification"), 5)).toBe(state);
    expect(reduceChoice(EMPTY, event("Stop"), 5)).toBe(EMPTY);
  });
});

describe("a question", () => {
  const question = (patch: Record<string, unknown> = {}) => ({
    question: "Which color?",
    header: "Color",
    multiSelect: false,
    options: [
      { label: "Red", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ],
    ...patch,
  });
  const ask = (questions: unknown[]) =>
    asked({ tool_name: "AskUserQuestion", tool_input: { questions } }).pending;

  it("offers the payload's options, numbered by position", () => {
    expect(ask([question()])).toMatchObject({
      kind: "question",
      source: "hook",
      terminalOnly: null,
      options: [
        { key: 1, label: "Red", detail: "Warm", typed: false },
        { key: 2, label: "Blue", detail: "Cool", typed: false },
      ],
    });
  });

  it("is left to the terminal when one key can't answer it", () => {
    const several = ask([question(), question({ question: "Which size?" })]);
    expect(several?.terminalOnly).toMatch(/several/);
    expect(several?.options).toEqual([]);
    expect(several?.questions).toHaveLength(2);

    expect(ask([question({ multiSelect: true })])?.terminalOnly).toMatch(/more than one/);
    expect(ask([question({ options: [] })])?.terminalOnly).not.toBeNull();
    expect(ask([])?.terminalOnly).not.toBeNull();
    expect(asked({ tool_name: "AskUserQuestion", tool_input: "nonsense" }).pending?.terminalOnly).not.toBeNull();
  });
});

describe("a plan approval", () => {
  it("carries the plan and waits for the terminal's options", () => {
    const { pending } = asked({ tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n\n- step" } });
    expect(pending).toMatchObject({ kind: "plan", options: [], source: "generic" });
    expect(pending?.input.plan).toBe("# Plan\n\n- step");
    expect(pending?.terminalOnly).not.toBeNull();
  });
});

describe("options read from the terminal screen", () => {
  it("are the numbered rows of the prompt at the bottom", () => {
    const screen = [
      "● Bash(mkdir t0-made-dir)",
      "",
      " Bash command",
      "   mkdir t0-made-dir",
      "   Create directory t0-made-dir",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to t0-made-dir\\ from this project",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
    ];
    expect(parseOptionRows(screen)).toEqual([
      { key: 1, label: "Yes", detail: "", typed: false },
      { key: 2, label: "Yes, and always allow access to t0-made-dir\\ from this project", detail: "", typed: false },
      { key: 3, label: "No", detail: "", typed: false },
    ]);
  });

  it("join a label the terminal wrapped, without a space where it cut a word", () => {
    const options = parseOptionRows([
      "────────────────────────────────────────",
      " ❯ 1. Yes",
      "   2. Yes, and always allow C:/Users/dev/080c",
      "      8ddd/proj from this project and",
      "      every later session",
      "   3. No",
      " Esc to cancel",
    ]);
    expect(options?.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow C:/Users/dev/080c8ddd/proj from this project and every later session",
      "No",
    ]);
  });

  it("keep the space where a label wrapped between words at the screen's edge", () => {
    const options = parseOptionRows([
      "──────────────────────────────",
      " ❯ 1. Yes",
      "   2. Yes, and switch to auto mode",
      "      for you",
      "   3. No",
    ]);
    expect(options?.[1].label).toBe("Yes, and switch to auto mode for you");
  });

  it("keep an option's hint line and mark the option that opens a text field", () => {
    const options = parseOptionRows([
      " Would you like to proceed?",
      "   1. Yes, and use auto mode",
      " ❯ 2. Yes, manually approve edits",
      "   3. Tell Claude what to change",
      "      shift+tab to approve with this feedback",
      "",
    ]);
    expect(options?.map((o) => [o.key, o.typed])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it("take the last prompt when an answer above it has a numbered list", () => {
    const options = parseOptionRows(["1. first idea", "2. second idea", "", " ❯ 1. Yes", "   2. No", ""]);
    expect(options?.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  it("are refused unless the rows are certainly a live prompt", () => {
    // A numbered list in an answer: no selection marker.
    expect(parseOptionRows(["Steps:", " 1. build", " 2. test", ""])).toBeNull();
    // A gap in the numbering: a row is off screen or misread.
    expect(parseOptionRows([" ❯ 1. Yes", "   3. No"])).toBeNull();
    // A single row is not a choice.
    expect(parseOptionRows([" ❯ 1. Yes"])).toBeNull();
    // Not at the bottom: the screen has moved on since.
    const moved = [" ❯ 1. Yes", "   2. No", ...Array.from({ length: 7 }, (_, i) => `output line ${i}`)];
    expect(parseOptionRows(moved)).toBeNull();
    expect(parseOptionRows([])).toBeNull();
    expect(parseOptionRows(["", "> ", ""])).toBeNull();
  });
});

describe("the transcript's say", () => {
  const pending = { ...asked().pending, at: Date.parse("2026-10-13T10:00:00Z") } as PendingChoice;
  const tool = (status: string, id = "toolu_1") =>
    ({ kind: "tool", id, rev: 0, timestamp: "2026-10-13T09:59:59Z", status }) as unknown as Item;
  const interrupted = (timestamp: string) =>
    ({ kind: "interrupted", id: "i", rev: 0, timestamp, forToolUse: true }) as Item;

  it("is nothing while the tool has no result", () => {
    expect(resolvedBy(pending, [])).toBeNull();
    expect(resolvedBy(pending, [tool("running")])).toBeNull();
    expect(resolvedBy(pending, [tool("denied", "toolu_other"), tool("running")])).toBeNull();
  });

  it("is an answer once the tool ran, and a refusal when it was denied", () => {
    expect(resolvedBy(pending, [tool("ok")])).toBe("answered");
    expect(resolvedBy(pending, [tool("error")])).toBe("answered");
    expect(resolvedBy(pending, [tool("denied")])).toBe("declined");
  });

  it("is a refusal when the turn was interrupted after the prompt opened", () => {
    expect(resolvedBy(pending, [tool("running"), interrupted("2026-10-13T10:00:05Z")])).toBe("declined");
    // An interruption from before this prompt says nothing about it.
    expect(resolvedBy(pending, [interrupted("2026-10-13T09:00:00Z"), tool("running")])).toBeNull();
  });
});
