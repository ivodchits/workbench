import { describe, expect, it } from "vitest";

import type { HookEvent } from "../ipc/hooks";
import { toolActivity } from "./activity";
import { reduceStatus, type LiveStatus } from "./status";

const bash = (command: string) => toolActivity("Bash", { command });

describe("toolActivity", () => {
  it("sorts the built-in tools", () => {
    expect(toolActivity("Edit", {})).toBe("edit");
    expect(toolActivity("Write", {})).toBe("edit");
    expect(toolActivity("NotebookEdit", {})).toBe("edit");
    expect(toolActivity("Read", {})).toBe("read");
    expect(toolActivity("Grep", {})).toBe("read");
    expect(toolActivity("Glob", {})).toBe("read");
    expect(toolActivity("WebFetch", {})).toBe("web");
    expect(toolActivity("WebSearch", {})).toBe("web");
    expect(toolActivity("Task", {})).toBe("task");
    expect(toolActivity("Agent", {})).toBe("task");
    expect(toolActivity("TodoWrite", {})).toBe("other");
    expect(toolActivity("", undefined)).toBe("other");
  });

  it("tells a test run from other shell commands", () => {
    expect(bash("ls -la")).toBe("bash");
    expect(bash("npm run build")).toBe("bash");
    expect(bash("git commit -m 'test fixes'")).toBe("bash");
    expect(bash("npm test")).toBe("test");
    expect(bash("npm run test -- status")).toBe("test");
    expect(bash("npx vitest run src/state")).toBe("test");
    expect(bash("cd src-tauri && cargo test office")).toBe("test");
    expect(bash("python -m pytest -q")).toBe("test");
    expect(bash("go test ./...")).toBe("test");
    expect(toolActivity("PowerShell", { command: "dotnet test" })).toBe("test");
    expect(toolActivity("Bash", {})).toBe("bash");
  });

  it("counts running a test script of your own as a test run", () => {
    expect(toolActivity("PowerShell", { command: String.raw`& "C:\Temp\scratchpad\random_test.ps1"` })).toBe("test");
    expect(bash("python test_api.py")).toBe("test");
    expect(bash("./scripts/run-tests.sh")).toBe("test");
    expect(bash("node app.test.js")).toBe("test");
    expect(toolActivity("PowerShell", { command: "Invoke-Pester ./tests" })).toBe("test");
    expect(bash("./scripts/build.sh")).toBe("bash");
    expect(bash("python latest.py")).toBe("bash");
    expect(bash("cat contest.txt")).toBe("bash");
  });

  it("counts a browser over MCP as the web", () => {
    expect(toolActivity("mcp__firefox__navigation_go_to_url", {})).toBe("web");
    expect(toolActivity("mcp__github__list_issues", {})).toBe("other");
  });
});

function ev(name: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { session_id: "s", hook_event_name: name, transcript_path: null, cwd: null, permission_mode: null, tool_name: null, ...extra };
}

function run(...events: HookEvent[]): LiveStatus {
  let live: LiveStatus | undefined;
  events.forEach((e, i) => {
    live = reduceStatus(live, e, i).entry;
  });
  return live!;
}

describe("the status engine's activity", () => {
  it("follows the latest tool and resets on a new turn", () => {
    const edit = ev("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "a" } });
    const test = ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
    expect(run(ev("UserPromptSubmit")).activity).toBeNull();
    expect(run(ev("UserPromptSubmit"), edit).activity).toBe("edit");
    expect(run(ev("UserPromptSubmit"), edit, ev("PostToolUse"), test).activity).toBe("test");
    expect(run(ev("UserPromptSubmit"), edit, ev("Stop"), ev("UserPromptSubmit")).activity).toBeNull();
  });

  it("isn't moved by tool churn under a held prompt", () => {
    const read = ev("PreToolUse", { tool_name: "Read" });
    const live = run(ev("UserPromptSubmit"), read, ev("PermissionRequest"), ev("PreToolUse", { tool_name: "Edit" }));
    expect(live.phase).toBe("needs_you");
    expect(live.activity).toBe("read");
  });
});
