// Duck at the boss desk (office plan O3.1): what it's doing, shown while it's home.
// Speaking (aloud, or its reply streaming into the office's chat) moves the beak;
// thinking or running a tool looks up with a "…"; a routine looks up with "routine";
// a card waiting for your yes or no is a "?" in the needs-you colour. Otherwise it
// bobs. Out on a trip (`reactions.ts`) it's busy with that instead.

import type { TurnState } from "../../assistant/protocol";
import type { DuckActivity } from "../../remote/protocol";
import type { DuckAnim } from "../art/duck";
import { setDuckAnim, type Bubble, type World } from "./entities";
import type { Staff } from "./sessions";
import { duckLine } from "./standup";

/** What Duck is doing, as far as the office knows: the snapshot's word for it, and the
 *  turn in the thread open in the office's chat. */
export interface DuckDoing {
  state: DuckActivity;
  chat: TurnState;
}

/** Duck's pose and bubble for what it's doing. */
export function mood(d: DuckDoing): { anim: DuckAnim; bubble: Bubble | null } {
  if (d.chat === "streaming" || d.state === "speaking") return { anim: "speak", bubble: null };
  if (d.chat === "waiting") return { anim: "idle", bubble: { text: "?", tone: "needs" } };
  if (d.chat === "thinking" || d.chat === "tool" || d.state === "thinking") return { anim: "think", bubble: { text: "…", tone: "say" } };
  if (d.state === "routine") return { anim: "think", bubble: { text: "routine", tone: "say" } };
  return { anim: "idle", bubble: null };
}

const sameBubble = (a: Bubble | null, b: Bubble | null) => a?.text === b?.text && a?.tone === b?.tone;

/** Duck at home shows what it's doing; true when the picture changed. */
export function duckAtDesk(world: World, staff: Staff, ms: number): boolean {
  const d = world.duck;
  if (staff.trip || d.walk) return false;
  // Chairing the standup (O5.5), when nothing else has it.
  const chair = duckLine(staff, ms);
  const busy = mood(staff.duckDoing);
  const want = chair && busy.anim === "idle" && !busy.bubble ? { anim: "speak" as const, bubble: { text: chair, tone: "say" as const } } : busy;
  let changed = false;
  if (d.anim !== want.anim) {
    setDuckAnim(d, want.anim, ms);
    changed = true;
  }
  if (!sameBubble(d.bubble, want.bubble)) {
    d.bubble = want.bubble;
    changed = true;
  }
  return changed;
}
