// What Duck knows of the user's machines (fleet plan F3.2): which there are, which
// are on, what each is for, and the work waiting for one that's off.
//
// - **The machines** come from the fleet's status (`ipc/fleet.ts`), as the app last
//   heard it.
// - **The prompt** gets a paragraph about them (`promptBlock`): their names and
//   kinds, where coding goes (a desktop or a laptop; the server takes research and
//   heavy thinking only), and the waiting queue. Only names and kinds, which rarely
//   change, so the cached prefix holds; who's on is `list_machines`'s to say.
// - **The waiting queue** (`duck.db`, `waiting.rs`): a task for a machine that's
//   off. When it connects to the main (its host says hello, `fleetHosts.ts`), each
//   of its tasks goes back to the thread it came from as an event, and Duck does it
//   then with the usual tools.

import type { FleetStatus } from "../ipc/fleet";

export interface MachineView {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  /** This machine (where Duck runs, at the main). */
  here: boolean;
  /** Duck's machine. */
  duck: boolean;
  os: string | null;
  caps: string[];
}

export interface WaitingItem {
  id: string;
  /** The machine's fleet id, and its name when queued. */
  machine: string;
  machineName: string;
  /** The thread it goes back to; null for a new one. */
  threadId: string | null;
  task: string;
  /** Epoch ms. */
  at: number;
}

export interface FleetTools {
  machines(): MachineView[];
  /** The machine `ref` names (name or id), or null. */
  find(ref: string): MachineView | null;
  promptBlock(): string | null;
  queue(machine: MachineView, task: string, threadId: string | null): Promise<WaitingItem>;
  waiting(): WaitingItem[];
  drop(id: string): Promise<boolean>;
  /** Machine `id` connected: hand over its tasks. */
  connected(id: string): Promise<void>;
  setStatus(s: FleetStatus): void;
  load(): Promise<void>;
  onChange(cb: () => void): () => void;
}

export interface WaitingStore {
  put(id: string, data: string): Promise<void>;
  list(): Promise<string[]>;
  delete(id: string): Promise<boolean>;
}

const TASK_MAX = 4000;

export function createFleetTools(deps: {
  store: WaitingStore;
  /** Put an event in a thread (null: a new one); rejects when it couldn't. */
  tell: (threadId: string | null, text: string) => Promise<void>;
  newId?: () => string;
}): FleetTools {
  let status: FleetStatus | null = null;
  let items: WaitingItem[] = [];
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((cb) => cb());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const norm = (s: string) => s.trim().toLowerCase();

  const machines = (): MachineView[] => {
    if (!status) return [];
    const duck = status.config.duck ?? status.me.id;
    const view = (m: FleetStatus["me"], here: boolean): MachineView => ({
      id: m.id,
      name: m.name,
      kind: m.kind || "desktop",
      online: here || m.online,
      here,
      duck: m.id === duck,
      os: m.os,
      caps: m.caps,
    });
    const all = [view(status.me, true), ...status.members.map((m) => view(m, false))];
    const order = status.config.order;
    return all.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
  };

  return {
    machines,
    find(ref) {
      const r = norm(ref);
      return machines().find((m) => m.id === ref.trim() || norm(m.name) === r) ?? null;
    },
    promptBlock() {
      const all = machines();
      if (all.length < 2) return null;
      const duck = all.find((m) => m.duck)?.name ?? all[0].name;
      const list = all.map((m) => `${m.name} (${m.kind})`).join(", ");
      const servers = all.filter((m) => m.kind === "server").map((m) => m.name);
      const lines = [
        `## The user's computers`,
        `Workbench runs on several of the user's computers: ${list}. You run on ${duck}, and each one's projects and sessions are its own: list_projects and list_sessions say whose, and a project's sessions start on its machine (name it as name@machine when several have it).`,
        servers.length
          ? `Coding sessions go to a desktop or a laptop. ${servers.join(" and ")} take${servers.length === 1 ? "s" : ""} only research or heavy-thinking sessions, never coding.`
          : `Coding sessions go to whichever machine has the project.`,
        `A machine that's off can't take work. When the user asks for something on one (or it can only be done there), say it's off and offer to wait: wait_for_machine hands the task back to you in this thread when that machine connects. Queue without asking only when they said it can wait ("whenever", "when it's on"). list_machines says which are on and what's waiting.`,
      ];
      return lines.join("\n");
    },
    async queue(machine, task, threadId) {
      const item: WaitingItem = {
        id: newId(),
        machine: machine.id,
        machineName: machine.name,
        threadId,
        task: task.trim().slice(0, TASK_MAX),
        at: Date.now(),
      };
      await deps.store.put(item.id, JSON.stringify(item));
      items = [...items, item];
      changed();
      return item;
    },
    waiting: () => items,
    async drop(id) {
      const had = items.some((i) => i.id === id);
      await deps.store.delete(id);
      items = items.filter((i) => i.id !== id);
      if (had) changed();
      return had;
    },
    async connected(id) {
      const due = items.filter((i) => i.machine === id);
      for (const item of due) {
        const name = machines().find((m) => m.id === id)?.name ?? item.machineName;
        const text = `${name} is connected now. You queued this for it: ${item.task}\nDo it now, on ${name}.`;
        try {
          await deps.tell(item.threadId, text);
        } catch {
          // Its thread is gone: a new one.
          await deps.tell(null, text).catch((e: unknown) => console.warn("duck: a waiting task couldn't be handed over", e));
        }
        await deps.store.delete(item.id).catch(() => false);
        items = items.filter((i) => i.id !== item.id);
      }
      if (due.length) changed();
    },
    setStatus(s) {
      status = s;
    },
    async load() {
      const rows = await deps.store.list();
      items = rows.flatMap((r) => {
        try {
          return [JSON.parse(r) as WaitingItem];
        } catch {
          return [];
        }
      });
      changed();
    },
    onChange(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}
