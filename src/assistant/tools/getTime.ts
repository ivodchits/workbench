// The stub tool of step A2: proves the round trip (the model calls it, the engine
// validates and runs it, the result goes back) before the real tools of track W.

import { z } from "zod";
import { defineTool } from "./registry";

export const getTime = defineTool({
  name: "get_time",
  description:
    "The current local date and time on the user's PC, with the time zone. Use it whenever the answer depends on today's date or the time of day.",
  schema: z.object({}),
  tier: "read",
  run() {
    const now = new Date();
    return {
      local: now.toLocaleString("en-GB", {
        dateStyle: "full",
        timeStyle: "short",
      }),
      iso: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
});
