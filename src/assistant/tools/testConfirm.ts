// A dev-build-only stub for the confirmation flow (step A3): a "consequential" tool
// that does nothing, so the drawer's confirmation card can be tried without a real
// action behind it. Not registered in release builds (see `TOOLS` in `index.ts`).

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
