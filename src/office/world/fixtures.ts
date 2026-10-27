// Made-up sessions (office plan O1.4): for the tests, and for the preview, which shows
// every state from "Status → behaviour" at once — some are rare in real use.

import type { RemoteChoice, RemoteInstance, RemoteSnapshot } from "../../remote/protocol";
import { createStaff, type Staff } from "./sessions";

export const instance = (id: string, projectId: string, over: Partial<RemoteInstance> = {}): RemoteInstance => ({
  id,
  projectId,
  projectName: projectId,
  title: id,
  taskNote: "",
  branch: null,
  worktreeOn: false,
  remote: false,
  phase: "working",
  compacting: false,
  subagents: 0,
  activity: null,
  status: "idle",
  ctxTokens: 0,
  live: true,
  needsSince: null,
  escalated: false,
  stuck: false,
  choice: null,
  ...over,
});

export const snapshot = (instances: RemoteInstance[]): RemoteSnapshot => ({
  updatedAt: 0,
  usageLimits: null,
  instances,
  projects: [],
  duck: { state: "idle", autopilots: [] },
  created: [],
});

const question: RemoteChoice = { id: "q", kind: "question", toolName: "AskUserQuestion", input: {}, questions: [], options: [], terminalOnly: null, sent: null };

/** One session per state, the rooms they sit in, and two contractors (one needing
 *  you). The preview seats it; Demiurge and TinyWizardRoyale get their own rooms. */
export const EVERY_STATE: RemoteInstance[] = [
  instance("edit", "dem", { activity: "edit" }),
  instance("subagents", "dem", { activity: "task", subagents: 2 }),
  instance("test", "dem", { activity: "test" }),
  instance("bash", "dem", { activity: "bash" }),
  instance("needs", "twr", { phase: "needs_you" }),
  instance("question", "twr", { phase: "needs_you", choice: question }),
  instance("web", "misc", { activity: "web" }),
  instance("read", "misc", { activity: "read" }),
  instance("compacting", "misc", { compacting: true }),
  instance("escalated", "misc", { phase: "needs_you", escalated: true }),
  instance("stuck", "misc", { activity: "edit", stuck: true }),
  instance("done", "misc", { phase: "done" }),
  instance("contractor", "misc", { activity: "edit" }),
  instance("contractor-needs", "misc", { phase: "needs_you" }),
];

export const EVERY_STATE_ROOMS = { dem: "demiurge", twr: "tinywizard" } as const;

/** Dice that roll the same every run (mulberry32), for the idle planner in tests. */
export function dice(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Staff for tests: at ten in the morning, with dice that roll the same every run. */
export const testStaff = (saved?: Parameters<typeof createStaff>[0]): Staff => Object.assign(createStaff(saved), { hour: () => 10, random: dice() });
