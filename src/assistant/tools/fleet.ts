// The user's machines, for Duck (fleet plan F3.2): which are on and what's
// waiting for one that's off, and queueing a task for a machine until it connects
// (`fleet.ts`).

import { z } from "zod";
import { defineTool } from "./registry";

const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export const listMachines = defineTool({
  name: "list_machines",
  description:
    "The user's computers that run Workbench: each one's name, kind (desktop, laptop, server), whether it's on now, whether you run on it, what it can do, and the tasks waiting for one that's off.",
  schema: z.object({}),
  tier: "read",
  run(_input, { fleet }) {
    if (!fleet) return { machines: [], note: "Workbench runs on this computer only." };
    const waiting = fleet.waiting();
    return {
      machines: fleet.machines().map((m) => ({
        name: m.name,
        kind: m.kind,
        on: m.online,
        ...(m.duck && { duck: true }),
        ...(!m.online && m.canWake && { canWake: true }),
        ...(m.caps.length && { can: m.caps }),
        ...(m.os && { os: m.os }),
        ...(waiting.some((w) => w.machine === m.id) && {
          waiting: waiting.filter((w) => w.machine === m.id).map((w) => ({ id: w.id, task: w.task, since: when(w.at) })),
        }),
      })),
    };
  },
});

export const waitForMachine = defineTool({
  name: "wait_for_machine",
  description:
    "Queue a task for one of the user's computers that's off. When it connects, the task comes back to you in this thread and you do it then, with the usual tools. Say what's to be done in full: it's all you'll have.",
  schema: z.object({
    machine: z.string().describe("The computer, by name."),
    task: z.string().min(1).describe("What to do there, in full."),
  }),
  tier: "reversible",
  describe: ({ machine, task }) => `Do this on ${machine} when it's on: ${task}`,
  async run({ machine, task }, { fleet, threadId }) {
    if (!fleet) throw new Error("Workbench runs on this computer only.");
    const m = fleet.find(machine);
    if (!m) throw new Error(`no computer "${machine}"; they are: ${fleet.machines().map((x) => x.name).join(", ")}`);
    if (m.online) throw new Error(`${m.name} is on now: do it there directly.`);
    const item = await fleet.queue(m, task, threadId);
    return `Queued for ${m.name} (${item.id}). It comes back here when ${m.name} connects.`;
  },
});

export const dropWaiting = defineTool({
  name: "drop_waiting",
  description: "Take a task off the waiting queue (list_machines lists them with their ids).",
  schema: z.object({ id: z.string().min(1).describe("The waiting task's id.") }),
  tier: "reversible",
  async run({ id }, { fleet }) {
    if (!fleet || !(await fleet.drop(id))) throw new Error(`nothing waiting with the id ${id}`);
    return "Dropped.";
  },
});

export const wakeMachine = defineTool({
  name: "wake_machine",
  description:
    "Wake one of the user's computers that's off or asleep (Wake-on-LAN), when list_machines says it can be woken, and wait up to 90 s for it to connect. Then work on it as usual; if it doesn't come up, offer wait_for_machine.",
  schema: z.object({ machine: z.string().describe("The computer, by name.") }),
  tier: "reversible",
  describe: ({ machine }) => `Wake ${machine}`,
  timeoutMs: 100_000,
  async run({ machine }, { fleet, signal }) {
    if (!fleet) throw new Error("Workbench runs on this computer only.");
    const m = fleet.find(machine);
    if (!m) throw new Error(`no computer "${machine}"; they are: ${fleet.machines().map((x) => x.name).join(", ")}`);
    if (m.online) return `${m.name} is on already.`;
    if (!m.canWake) throw new Error(`${m.name} isn't set to be woken (the user turns that on in Remote Access → fleet).`);
    return fleet.wake(m, signal);
  },
});

export const FLEET_TOOLS = [listMachines, waitForMachine, dropWaiting, wakeMachine];
