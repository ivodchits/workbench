// Duck as the office's boss sees it (office plan O0.3): one word for what Duck is
// doing, and the sessions its autopilots drive. Pure; `RemoteMirror` feeds it the
// drawer's store and the speech state.

import type { AutopilotView, RoutineView, TurnState } from "../assistant/protocol";
import type { DuckActivity, RemoteDuck } from "../remote/protocol";

export interface DuckInputs {
  /** Audio is playing. */
  speaking: boolean;
  routines: readonly RoutineView[];
  /** Each thread's turn state. */
  states: Readonly<Record<string, TurnState>>;
  autopilots: readonly AutopilotView[];
}

/** Speaking shows over everything; a routine's turn is the routine, not thinking. */
export function officeDuck(d: DuckInputs): RemoteDuck {
  let state: DuckActivity = "idle";
  if (d.speaking) state = "speaking";
  else if (d.routines.some((r) => r.running)) state = "routine";
  else if (Object.values(d.states).some((s) => s !== "idle")) state = "thinking";
  return {
    state,
    autopilots: d.autopilots.filter((a) => a.state === "running").map((a) => a.instanceId),
  };
}
