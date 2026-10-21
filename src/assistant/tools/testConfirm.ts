// A dev-build-only stub for the confirmation flow (step A3): a "consequential" tool
// that does nothing, so the drawer's confirmation card can be tried without a real
// action behind it. Not registered in release builds (see `TOOLS` in `index.ts`).
// `test_announce` (V5) is its twin for announcements: a Workbench event after a delay.

import { z } from "zod";
import { defineTool } from "./registry";

export const testConfirm = defineTool({
  name: "test_confirm",
  description:
    "A test of the confirmation flow: it does nothing, but the user must approve it before it runs. Use it only when the user asks to test confirmations.",
  schema: z.object({
    action: z
      .string()
      .describe("What the test pretends to do, in a few words."),
  }),
  tier: "consequential",
  run({ action }) {
    return { done: true, note: `nothing happened (test of "${action}")` };
  },
});

export const testAnnounce = defineTool({
  name: "test_announce",
  description:
    "A test of announcements: after `delaySeconds`, a Workbench event arrives in this thread saying `news`, at `level`. Use it only when the user asks to test announcements.",
  schema: z.object({
    news: z.string().describe("What the event reports."),
    level: z.enum(["info", "report", "needs_you"]),
    delaySeconds: z.number().min(0).max(600),
  }),
  tier: "read",
  run({ news, level, delaySeconds }, ctx) {
    setTimeout(() => ctx.later(`Test event: ${news} Tell the user.`, level), delaySeconds * 1000);
    return { scheduled: `in ${delaySeconds} s` };
  },
});
