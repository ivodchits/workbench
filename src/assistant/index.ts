// Duck's entry point (step A2): `initAssistant()` builds the engine over the thread
// store, the tool registry and the local port, and `getDuck()` hands surfaces a
// transport. Started with the app like the other engines (App.tsx), not when a
// surface first opens, so Duck is there for every surface from the start.

import {
  getSpend,
  onUsage,
  type Spend,
  type UsageRecord,
} from "../ipc/assistant";
import { errorMessage, getClient, oneShot } from "./client";
import { createEngine, type Engine } from "./engine";
import { createPolicy } from "./policy";
import { localPort } from "./port.local";
import {
  createLocalTransport,
  type ClientMessage,
  type DuckEndpoint,
  type DuckEvent,
  type Transport,
} from "./protocol";
import { loadSettings, type SettingsStore } from "./settings";
import { createTurnMeter } from "./spend";
import { createThreadStore, ipcBackend, type ThreadStore } from "./threads";
import { ACT_TOOLS } from "./tools/act";
import { getTime } from "./tools/getTime";
import { READ_TOOLS } from "./tools/read";
import { createRegistry } from "./tools/registry";
import { testConfirm } from "./tools/testConfirm";

/** Every tool Duck has. Order doesn't matter: the registry sorts them. The
 *  confirmation test tool exists in dev builds only. */
const TOOLS = [
  getTime,
  ...READ_TOOLS,
  ...ACT_TOOLS,
  ...(import.meta.env.DEV ? [testConfirm] : []),
];

/** Where the spend comes from: the ledger commands in the app, fakes in tests. */
export interface SpendSource {
  get(): Promise<Spend>;
  /** Every metered call; returns the unsubscribe. */
  onUsage(cb: (r: UsageRecord) => void): () => void;
}

const ledger: SpendSource = {
  get: getSpend,
  onUsage(cb) {
    const off = onUsage(cb);
    return () => void off.then((f) => f());
  },
};

let started: Promise<void> | null = null;
let duck: Transport | null = null;

/** Connect a surface to an engine over the protocol. */
export function endpoint(
  e: Engine,
  s: ThreadStore,
  spend?: SpendSource,
  settings?: SettingsStore,
): DuckEndpoint {
  const listeners = new Set<(ev: DuckEvent) => void>();
  const say = (ev: DuckEvent) => {
    for (const l of listeners) l(ev);
  };
  const fail = (err: unknown) =>
    say({ type: "error", message: errorMessage(err) });
  e.onEvent(say);

  // The spend line: the month from the ledger, each turn from the meter.
  const meter = createTurnMeter();
  e.onEvent((ev) => {
    if (ev.type === "turnState") meter.state(ev.threadId, ev.state);
  });
  const sendSpend = async () => {
    if (spend)
      say({ type: "spend", spend: await spend.get(), turns: meter.turns() });
  };
  spend?.onUsage((r) => {
    meter.usage(r.purpose, r.costUsd);
    void sendSpend().catch(fail);
  });

  async function handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "send":
        await e.send(msg);
        return;
      case "stop":
        e.stop(msg.threadId);
        return;
      case "confirm":
        await e.confirm(msg.threadId, msg.toolUseId, msg.allow);
        return;
      case "thread.new":
        await e.newThread(msg.mode);
        return;
      case "thread.delete":
        await e.deleteThread(msg.threadId);
        return;
      case "sync":
        say({ type: "threads", threads: [...s.threads()] });
        for (const request of e.pendingRequests())
          say({ type: "confirm", request });
        if (settings) say({ type: "settings", settings: settings.get() });
        await sendSpend();
        return;
      case "settings.set":
        if (!settings) throw new Error("Duck's settings aren't available.");
        say({
          type: "settings",
          settings: await settings.set(msg.settings),
        });
        return;
      case "thread.open": {
        if (!s.thread(msg.threadId))
          throw new Error(`no thread ${msg.threadId}`);
        const messages = await s.messages(msg.threadId);
        say({
          type: "history",
          threadId: msg.threadId,
          messages: [...messages],
          state: e.state(msg.threadId),
        });
        return;
      }
    }
  }

  return {
    handle: (msg) => void handle(msg).catch(fail),
    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/** Start Duck. Idempotent; a failure to load (no backend) leaves Duck off and is
 *  retried on the next call. */
export function initAssistant(): Promise<void> {
  started ??= (async () => {
    const s = createThreadStore(ipcBackend);
    await s.load();
    const settings = await loadSettings();
    const engine = createEngine({
      store: s,
      registry: createRegistry(TOOLS),
      port: localPort,
      gate: createPolicy(settings.get),
      settings: settings.get,
      stream: async (params, opts) =>
        (await getClient()).beta.messages.stream(params, opts),
      nameThread: (text) => oneShot("title", text.slice(0, 2000)),
    });
    duck = createLocalTransport(endpoint(engine, s, ledger, settings));
  })().catch((e: unknown) => {
    started = null;
    console.error("duck: init failed", e);
  });
  return started;
}

/** The transport to the running Duck, or `null` until `initAssistant` finished. */
export function getDuck(): Transport | null {
  return duck;
}
