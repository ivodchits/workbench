import { describe, expect, it } from "vitest";

import type { HookEvent } from "../ipc/hooks";
import { reduceStatus, type LiveStatus } from "./status";
import { atRest } from "./queue";

function ev(name: string, extra: Partial<HookEvent> = {}): HookEvent {
  return {
    session_id: "s",
    hook_event_name: name,
    transcript_path: null,
    cwd: null,
    permission_mode: null,
    tool_name: null,
    ...extra,
  };
}

/** Fold a sequence of events from no prior state. */
function run(...events: HookEvent[]): LiveStatus {
  let live: LiveStatus | undefined;
  events.forEach((e, i) => {
    live = reduceStatus(live, e, i).entry;
  });
  return live!;
}

describe("compaction", () => {
  // Claude Code's order: PreCompact → SessionStart{source: compact} → PostCompact.
  it("keeps a mid-turn auto-compaction working, so a queued prompt waits", () => {
    const live = run(ev("UserPromptSubmit"), ev("PreToolUse"), ev("PreCompact"), ev("SessionStart", { source: "compact" }));
    expect(live.phase).toBe("working");
    expect(live.compacting).toBe(false);
    expect(atRest(live)).toBe(false);
    expect(run(ev("UserPromptSubmit"), ev("PreCompact"), ev("SessionStart", { source: "compact" }), ev("PostCompact")).phase).toBe(
      "working",
    );
  });

  it("leaves a /compact from a finished turn at rest", () => {
    const live = run(ev("UserPromptSubmit"), ev("Stop"), ev("PreCompact"), ev("SessionStart", { source: "compact" }), ev("PostCompact"));
    expect(live.phase).toBe("done");
    expect(atRest(live)).toBe(true);
  });

  it("still treats other session starts as a fresh idle session", () => {
    expect(run(ev("UserPromptSubmit"), ev("SessionStart", { source: "startup" })).phase).toBe("idle");
    expect(run(ev("UserPromptSubmit"), ev("SessionStart", { source: "resume" })).phase).toBe("idle");
  });
});
