// Every tool Duck has, and the ones it loads on demand: one list for the engine
// (`index.ts`) and the tests that check what the modes name (step S1).

import { ACT_TOOLS } from "./tools/act";
import { AUTOPILOT_TOOLS } from "./tools/autopilot";
import { getTime } from "./tools/getTime";
import { HAIKU_TOOLS } from "./tools/haikuTask";
import { IMPROVE_TOOLS } from "./tools/improve";
import { MCP_TOOLS } from "./tools/mcp";
import { MEMORY_TOOLS } from "./tools/memory";
import { MORNING_TOOLS } from "./tools/morning";
import { PLUGIN_TOOLS } from "./tools/plugins";
import { PREP_TOOLS } from "./tools/prep";
import { QUIET_TOOLS } from "./tools/quiet";
import { READ_TOOLS } from "./tools/read";
import { READ_ALOUD_TOOLS } from "./tools/readAloud";
import { ROUTINE_TOOLS } from "./tools/routines";
import { SCREEN_TOOLS } from "./tools/screen";
import { SCREENSHOT_TOOLS } from "./tools/screenshot";
import { SHEET_TOOLS } from "./tools/sheets";
import { SKILL_TOOLS } from "./tools/skills";
import { SUMMARY_TOOLS } from "./tools/summaries";
import { TASK_TOOLS } from "./tools/tasks";
import { testAnnounce, testConfirm } from "./tools/testConfirm";
import { THREAD_TOOLS } from "./tools/threads";

/** Every tool Duck has. Order doesn't matter: the registry sorts them. The
 *  confirmation test tool exists in dev builds only. */
export const TOOLS = [
  getTime,
  ...READ_TOOLS,
  ...ACT_TOOLS,
  ...PLUGIN_TOOLS,
  ...TASK_TOOLS,
  ...SUMMARY_TOOLS,
  ...SCREEN_TOOLS,
  ...READ_ALOUD_TOOLS,
  ...SCREENSHOT_TOOLS,
  ...QUIET_TOOLS,
  ...AUTOPILOT_TOOLS,
  ...THREAD_TOOLS,
  ...HAIKU_TOOLS,
  ...MCP_TOOLS,
  ...MORNING_TOOLS,
  ...SHEET_TOOLS,
  ...PREP_TOOLS,
  ...MEMORY_TOOLS,
  ...IMPROVE_TOOLS,
  ...ROUTINE_TOOLS,
  ...SKILL_TOOLS,
  ...(import.meta.env.DEV ? [testConfirm, testAnnounce] : []),
];

/** Tools the model finds with the tool search when it needs them (step M2):
 *  the rarely used, and the large ones that are rarely used. The rest load up
 *  front, so most turns need no search. */
export const DEFERRED = new Set([
  ...PLUGIN_TOOLS.map((t) => t.name),
  ...AUTOPILOT_TOOLS.map((t) => t.name),
  ...SCREEN_TOOLS.map((t) => t.name),
  "delete_thread",
  "compact_thread",
  "delete_note",
  "task_rerun",
  "save_screenshot",
  "set_quiet",
  "duck_spend",
  "find_sheet",
  "read_sheet",
  "create_sheet_draft",
  "prep_ahead",
  "merge_duck_change",
  "rebuild_duck",
  "draft_skill",
  ...ROUTINE_TOOLS.map((t) => t.name),
]);
