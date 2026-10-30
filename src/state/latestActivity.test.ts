import { describe, expect, it } from "vitest";

import type { HookEvent } from "../ipc/hooks";
import { hookTool, reduceLatest } from "./latestActivity";

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

describe("reduceLatest", () => {
  it("follows a turn: its prompt, each tool call, then the reply", () => {
    let s = reduceLatest(undefined, event("UserPromptSubmit", { prompt: "fix\n  the build" }), 1);
    expect(s).toEqual({ tool: null, prompt: "fix the build", reply: null, at: 1 });
    s = reduceLatest(s, event("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test\nmore" } }), 2);
    expect(s?.tool).toEqual({ name: "Bash", target: "npm test …" });
    s = reduceLatest(s, event("Stop", { last_assistant_message: "All   green." }), 3);
    expect(s).toEqual({ tool: null, prompt: "fix the build", reply: "All green.", at: 3 });
  });

  it("keeps the last reply over a Stop with none, and ignores other events", () => {
    const s = { tool: null, prompt: null, reply: "earlier", at: 1 };
    expect(reduceLatest(s, event("Stop"), 2)?.reply).toBe("earlier");
    expect(reduceLatest(s, event("Notification"), 2)).toBe(s);
    expect(reduceLatest(undefined, event("PostToolUse"), 2)).toBeUndefined();
  });

  it("cuts a long reply", () => {
    const s = reduceLatest(undefined, event("Stop", { last_assistant_message: "x".repeat(1000) }), 1);
    expect(s?.reply?.length).toBe(400);
    expect(s?.reply?.endsWith("…")).toBe(true);
  });
});

describe("hookTool", () => {
  it("names a call as the transcript does", () => {
    expect(hookTool("Edit", { file_path: "C:/repo/src/pwa/dashboard.ts" })).toEqual({ name: "Edit", target: "…/pwa/dashboard.ts" });
    expect(hookTool("Agent", { description: "find the card", subagent_type: "Explore" })).toEqual({ name: "Explore", target: "find the card" });
    expect(hookTool("AskUserQuestion", { questions: [{ question: "Which?" }] }).target).toBe("Which?");
    expect(hookTool("mcp__github__get_me", {})).toEqual({ name: "github: get_me", target: "" });
  });
});
