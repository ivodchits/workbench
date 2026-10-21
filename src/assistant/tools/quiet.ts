// "Duck, quiet" / «Дак, тихо» / "stop talking" (step V5): Do Not Disturb and the
// Speak switch by voice or text. Do Not Disturb holds Duck's announcements back
// (said in one catch-up when it ends); Speak off silences Duck's voice on this PC
// altogether until it's turned back on.

import { z } from "zod";
import { nextMorning } from "../announce";
import { DND_FOREVER } from "../settings";
import { when } from "./read";
import { defineTool } from "./registry";

export interface QuietHost {
  /** Do Not Disturb until a moment (epoch ms), or off (null). */
  setDnd(until: number | null): void;
  /** Speak on this PC; null when its voice isn't running. */
  speakOn(): boolean | null;
  setSpeakOn(on: boolean): void;
}

export const setQuiet = defineTool({
  name: "set_quiet",
  description:
    "Do Not Disturb and Speak, when the user asks: \"quiet\", \"тихо\", \"don't disturb me for an hour\" (dnd), \"stop talking\", \"молчи\" (speak off), \"you can talk again\" (speak on, or dnd off). Do Not Disturb holds announcements of news back until it ends, then says them in one catch-up; Speak off silences your voice on this PC entirely. Say in a few words what you set; nothing else.",
  schema: z.object({
    dnd: z
      .enum(["off", "1h", "2h", "morning", "on"])
      .optional()
      .describe('"on" is until the user turns it off; "morning" is until 8:00.'),
    speak: z.boolean().optional().describe("Turn Speak (your voice on this PC) on or off."),
  }),
  tier: "read",
  run({ dnd, speak }, ctx) {
    const q = ctx.quiet;
    if (!q) throw new Error("Do Not Disturb isn't available here.");
    if (dnd === undefined && speak === undefined) throw new Error("say what to set: dnd or speak.");
    const now = Date.now();
    const out: Record<string, string> = {};
    if (dnd !== undefined) {
      const until =
        dnd === "off" ? null : dnd === "1h" ? now + 3_600_000 : dnd === "2h" ? now + 7_200_000 : dnd === "morning" ? nextMorning(now) : DND_FOREVER;
      q.setDnd(until);
      out.dnd = until === null ? "off" : until === DND_FOREVER ? "on until the user turns it off" : `on until ${when(until)}`;
    }
    if (speak !== undefined) {
      q.setSpeakOn(speak);
      out.speak = speak ? "on" : "off";
    }
    return out;
  },
});

export const QUIET_TOOLS = [setQuiet];
