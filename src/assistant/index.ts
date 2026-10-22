// Duck's entry point (step A2): `initAssistant()` builds the engine over the thread
// store, the tool registry and the local port, and `getDuck()` hands surfaces a
// transport. Started with the app like the other engines (App.tsx), not when a
// surface first opens, so Duck is there for every surface from the start. The
// phone reaches the same endpoint through the remote bridge (step R1).
//
// The reader (step V3) is made here too: one for the app, heard on this PC
// (`registerDesktopSpeech`, from the drawer's speech) or on the phone that asked.
//
// So is the announcer (step V5): a turn started by a Workbench event (a task's
// report, a watched session, an autopilot) ends with Duck's reply, whose headline
// is announced at the level the event's producer gave; a confirmation card nobody
// is looking at is one too.

import { homeDir } from "@tauri-apps/api/path";

import {
  getSpend,
  mcpRequest,
  onUsage,
  replayCalls,
  type Spend,
  type UsageRecord,
} from "../ipc/assistant";
import { readFile } from "../ipc/fs";
import { getPref, setPref } from "../ipc/prefs";
import { listMonitors, saveScreenshot, screenshot } from "../ipc/screen";
import { badgeText, createAutopilot, ipcAutopilotBackend, type AutopilotManager } from "./autopilot";
import { errorMessage, getClient, oneShot, structured } from "./client";
import { createEngine, eventText, type Engine } from "./engine";
import { createPolicy } from "./policy";
import { ttsRender, ttsWarm } from "../ipc/tts";
import { ipcLink, startRemoteBridge, type RemoteBridge } from "./remoteBridge";
import { prepareSentence } from "./speakable";
import { Reader, type ReaderView, type ReadPosition, type Voice } from "./reader";
import { Announcer, headline, type Level } from "./announce";
import { getPresence } from "../ipc/presence";
import { localPort } from "./port.local";
import {
  USER_SOURCES,
  createLocalTransport,
  type ClientMessage,
  type DuckEndpoint,
  type AutopilotView,
  type DuckEvent,
  type TaskView,
  type Transport,
  type TrustView,
} from "./protocol";
import { loadSettings, type SettingsStore } from "./settings";
import { createSummarizer, ipcSummaryBackend, Summary } from "./summarize";
import { createTurnMeter } from "./spend";
import { createThreadStore, ipcBackend, type ThreadStore } from "./threads";
import { ACT_TOOLS } from "./tools/act";
import { PLUGIN_TOOLS } from "./tools/plugins";
import { getTime } from "./tools/getTime";
import { READ_TOOLS } from "./tools/read";
import { SCREEN_TOOLS } from "./tools/screen";
import { READ_ALOUD_TOOLS, type ReaderHost } from "./tools/readAloud";
import { SCREENSHOT_TOOLS, type ScreenHost } from "./tools/screenshot";
import { QUIET_TOOLS, type QuietHost } from "./tools/quiet";
import { MCP_TOOLS } from "./tools/mcp";
import { createMcpHost } from "./mcp";
import { SUMMARY_TOOLS } from "./tools/summaries";
import { createRegistry } from "./tools/registry";
import { TASK_TOOLS } from "./tools/tasks";
import { AUTOPILOT_TOOLS } from "./tools/autopilot";
import { THREAD_TOOLS } from "./tools/threads";
import { createTaskManager, ipcTaskBackend, type Task, type TaskManager } from "./tasks";
import { voiceMessage } from "./voiceNames";
import { testAnnounce, testConfirm } from "./tools/testConfirm";
import { FLOOR } from "./trust/floor";
import { replay, type ReplayReport } from "./trust/replay";
import { createTrustStore, ipcTrustBackend, type TrustStore } from "./trust/store";
import { startTrustWatcher } from "./trust/watcher";

/** Decisions per page of the log. */
const DECISION_PAGE = 50;

export function trustView(t: TrustStore): TrustView {
  const c = t.config();
  return {
    ...c,
    floor: FLOOR.map((f) => ({ id: f.id, label: f.label, on: !c.floorOff.includes(f.id) })),
  };
}

/** Every tool Duck has. Order doesn't matter: the registry sorts them. The
 *  confirmation test tool exists in dev builds only. */
const TOOLS = [
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
  ...MCP_TOOLS,
  ...(import.meta.env.DEV ? [testConfirm, testAnnounce] : []),
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

/** Runs the trust replay (step T2): the app's reads the transcripts and judges
 *  through the proxy. */
export type Replayer = (
  days: number,
  judgeMax: number,
  progress: (done: number, of: number) => void,
) => Promise<ReplayReport>;

/** The most calls the replay reads. */
const REPLAY_MAX_CALLS = 20_000;

let started: Promise<void> | null = null;
let duck: Transport | null = null;

/** The text blocks of a stored message. */
function replyText(content: unknown): string {
  return Array.isArray(content)
    ? (content as { type?: string; text?: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
}

/** This PC's voice for reads and announcements, from the drawer's speech
 *  (`replySpeech.ts`). */
export interface DesktopSpeech {
  voice: Voice;
  /** Resolves once the thread's reply is spoken. */
  quiet(threadId: string): Promise<void>;
  /** Say an announcement; false when it can't. A reply to it goes to `threadId`. */
  announce(text: string, threadId?: string): Promise<boolean>;
  /** Something is speaking or queued to. */
  busy(): boolean;
  /** Speak, the master switch. */
  speakOn(): boolean;
  setSpeakOn(on: boolean): void;
}

let desktopSpeech: DesktopSpeech | null = null;

export function registerDesktopSpeech(s: DesktopSpeech): void {
  desktopSpeech = s;
}

/** Kept read positions (the newest this many). */
const KEPT_READS = 30;
/** The longest a read waits for the reply that asked for it. */
const QUIET_MAX_MS = 60_000;

/** The reader's view, for the endpoint. */
export interface ReaderLink {
  reader: Reader;
  subscribe(cb: (v: ReaderView | null) => void): () => void;
}

const screenHost: ScreenHost = { capture: screenshot, monitors: listMonitors, save: saveScreenshot };

export function taskView(t: Task): TaskView {
  return {
    id: t.id,
    threadId: t.threadId,
    title: t.title,
    kind: t.kind,
    state: t.state,
    model: t.model,
    effort: t.effort,
    tier: t.tier,
    instanceId: t.instanceId,
    folder: t.folder,
    started: t.started,
    finished: t.finished,
    headline: t.headline,
    runner: t.runner,
    why: t.why,
    costUsd: t.costUsd,
    answers: t.answers.map(({ question, answer, reason }) => ({ question, answer, reason })),
  };
}

/** Connect a surface to an engine over the protocol. */
export function endpoint(
  e: Engine,
  s: ThreadStore,
  spend?: SpendSource,
  settings?: SettingsStore,
  trust?: TrustStore | null,
  replayer?: Replayer,
  tasks?: TaskManager,
  autopilot?: AutopilotManager,
  reader?: ReaderLink,
  onSettings?: () => void,
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
  const sendSpend = async (to = say) => {
    if (spend)
      to({ type: "spend", spend: await spend.get(), turns: meter.turns() });
  };
  spend?.onUsage((r) => {
    meter.usage(r.purpose, r.costUsd);
    void sendSpend().catch(fail);
  });

  trust?.subscribe((c) => {
    if (c.decision) say({ type: "decision", row: c.decision });
    else say({ type: "trust", trust: trustView(trust) });
  });
  const sendTasks = (to = say) => {
    if (tasks) to({ type: "tasks", tasks: tasks.list().map(taskView) });
  };
  tasks?.subscribe(() => sendTasks());
  const sendAutopilots = (to = say) => {
    if (!autopilot) return;
    const title = (id: string) => localPort.listSessions().find((x) => x.id === id)?.title ?? id;
    const autopilots: AutopilotView[] = autopilot
      .list()
      .filter((a) => a.state !== "stopped")
      .map((a) => ({ instanceId: a.instanceId, session: title(a.instanceId), threadId: a.threadId, state: a.state, text: badgeText(a) }));
    to({ type: "autopilots", autopilots });
  };
  autopilot?.subscribe(() => sendAutopilots());
  reader?.subscribe((v) => say({ type: "reader", reader: v }));
  const needTrust = () => {
    if (!trust) throw new Error("Duck's trust settings didn't load.");
    return trust;
  };

  /** `answer`: where the answers to this request go (the surface that asked, or
   *  every surface). */
  async function handle(msg: ClientMessage, answer: (ev: DuckEvent) => void): Promise<void> {
    switch (msg.type) {
      case "send":
        await e.send(msg);
        return;
      case "stop":
        e.stop(msg.threadId);
        return;
      case "turn.commit":
        e.commit(msg.threadId);
        return;
      case "turn.withdraw":
        e.withdraw(msg.threadId);
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
        answer({ type: "threads", threads: [...s.threads()] });
        for (const request of e.pendingRequests())
          answer({ type: "confirm", request });
        if (settings) answer({ type: "settings", settings: settings.get() });
        if (trust) answer({ type: "trust", trust: trustView(trust) });
        sendTasks(answer);
        sendAutopilots(answer);
        if (reader) answer({ type: "reader", reader: reader.reader.view() });
        await sendSpend(answer);
        return;
      case "settings.set":
        if (!settings) throw new Error("Duck's settings aren't available.");
        say({
          type: "settings",
          settings: await settings.set(msg.settings),
        });
        onSettings?.();
        return;
      case "dnd":
        if (!settings) throw new Error("Duck's settings aren't available.");
        say({ type: "settings", settings: await settings.set({ dndUntil: msg.until }) });
        onSettings?.();
        return;
      case "trust.pause":
        await needTrust().setPaused(msg.paused);
        return;
      case "trust.rule.add":
        await needTrust().addRule(msg.effect, msg.pattern, msg.projectId);
        return;
      case "trust.rule.remove":
        await needTrust().removeRule(msg.id);
        return;
      case "trust.mode":
        await needTrust().setMode(msg.projectId, msg.mode);
        return;
      case "trust.floor":
        await needTrust().setFloor(msg.id, msg.enabled);
        return;
      case "trust.decisions": {
        const rows = await needTrust().decisions(msg.before, DECISION_PAGE + 1);
        answer({
          type: "decisions",
          rows: rows.slice(0, DECISION_PAGE),
          before: msg.before,
          more: rows.length > DECISION_PAGE,
        });
        return;
      }
      case "trust.replay": {
        if (!replayer) throw new Error("The replay isn't available here.");
        const report = await replayer(msg.days, msg.judgeMax, (done, of) =>
          answer({ type: "replay", done, of, report: null }),
        );
        answer({ type: "replay", done: report.judged, of: report.judged, report });
        return;
      }
      case "task.close":
        if (!tasks) throw new Error("Worker tasks aren't available here.");
        await tasks.close(msg.taskId);
        return;
      case "task.rerun":
        if (!tasks) throw new Error("Worker tasks aren't available here.");
        await tasks.rerun(msg.taskId);
        return;
      case "autopilot": {
        if (!autopilot) throw new Error("Autopilot isn't available here.");
        if (msg.action === "pause") autopilot.pause(msg.instanceId);
        else if (msg.action === "stop") autopilot.stop(msg.instanceId);
        else await autopilot.resume(msg.instanceId);
        return;
      }
      case "reader": {
        if (!reader) throw new Error("Reading aloud isn't available here.");
        const r = reader.reader;
        if (msg.action === "pause") r.pause();
        else if (msg.action === "resume") r.resume();
        else if (msg.action === "next") r.skip(1);
        else if (msg.action === "prev") r.skip(-1);
        else r.stop();
        return;
      }
      case "thread.open": {
        if (!s.thread(msg.threadId))
          throw new Error(`no thread ${msg.threadId}`);
        const messages = await s.messages(msg.threadId);
        answer({
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
    handle: (msg, reply) =>
      void handle(msg, reply ?? say).catch((err: unknown) =>
        (reply ?? say)({ type: "error", message: errorMessage(err) }),
      ),
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
    // Without its store, trust falls back to W2's cards rather than keeping Duck off.
    const trust = await createTrustStore(ipcTrustBackend).catch((e: unknown) => {
      console.error("duck: trust didn't load; every consequential call asks", e);
      return null;
    });
    // Worker tasks (D1) report into their thread as Workbench events; the engine
    // that takes them is made just below.
    let engineRef: Engine | null = null;
    /** The level of the next Workbench event in each thread (V5). */
    const levels = new Map<string, Level>();
    const tasks = createTaskManager({
      port: localPort,
      backend: ipcTaskBackend,
      settings: settings.get,
      tell: (threadId, text, level) => {
        levels.set(threadId, level ?? "report");
        void engineRef
          ?.send({ threadId, text: eventText(text), source: "event" })
          .catch((e: unknown) => console.warn("duck: a task report was dropped", e));
      },
    });
    // Plan autopilots (P1) report the same way; their step log is notices.
    const autopilot = createAutopilot({
      port: localPort,
      backend: ipcAutopilotBackend,
      call: (r) => structured(r),
      readFile,
      tell: (threadId, text, level) => {
        levels.set(threadId, level ?? "report");
        void engineRef
          ?.send({ threadId, text: eventText(text), source: "event" })
          .catch((e: unknown) => console.warn("duck: an autopilot report was dropped", e));
      },
      notice: (threadId, text) =>
        void engineRef
          ?.notice(threadId, { kind: "autopilot", text })
          .catch((e: unknown) => console.warn("duck: an autopilot step line was dropped", e)),
    });
    const summaries = createSummarizer({
      port: localPort,
      backend: ipcSummaryBackend,
      call: (input, signal) => oneShot("summary", input, { schema: Summary, signal }),
    });
    // The done alert's body (W3, when the setting is on): the turn's headline.
    localPort.setDoneSummary(async (id, reply) => {
      if (!settings.get().summaryOnDone) return null;
      const s = localPort.listSessions().find((x) => x.id === id);
      return s ? ((await summaries.summarize(s, { reply })).summary?.headline ?? null) : null;
    });
    // Read-aloud (V3): positions in the prefs, heard on the phone that asked or here.
    const kept = new Map<string, ReadPosition>(
      Object.entries(await getPref("readAloud", {}).catch(() => ({}) as Record<string, ReadPosition>)),
    );
    const readerListeners = new Set<(v: ReaderView | null) => void>();
    let bridge: RemoteBridge | null = null;
    const ru = (t: string, signal: AbortSignal) => oneShot("speakable_ru", t, { signal });
    const reader = new Reader({
      narrate: (t, signal) => oneShot("narrate", t, { signal }),
      prepare: (sentence) => prepareSentence(sentence, ru),
      load: (k) => kept.get(k),
      save(k, p) {
        if (p) kept.set(k, p);
        else kept.delete(k);
        const newest = [...kept.values()].sort((a, b) => b.at - a.at).slice(0, KEPT_READS);
        void setPref("readAloud", Object.fromEntries(newest.map((x) => [x.key, x]))).catch(() => {});
      },
      quiet: (threadId) =>
        Promise.race([
          (async () => {
            while (engineRef && engineRef.state(threadId) !== "idle" && engineRef.state(threadId) !== "waiting")
              await new Promise((r) => setTimeout(r, 100));
            await Promise.all([desktopSpeech?.quiet(threadId), bridge?.quiet(threadId)]);
          })(),
          new Promise<void>((r) => setTimeout(r, QUIET_MAX_MS)),
        ]),
      changed: (v) => {
        for (const l of readerListeners) l(v);
      },
      ended: (threadId, why) => {
        if (why === "the end") return;
        void engineRef
          ?.notice(threadId, { kind: "reader", text: `Reading stopped: ${why}.` })
          .catch((e: unknown) => console.warn("duck: a reader notice was dropped", e));
      },
    });
    const readerHost: ReaderHost = {
      reader,
      voiceFor(threadId) {
        const v = bridge?.voiceFor(threadId) ?? desktopSpeech?.voice;
        if (!v) throw new Error("There's no voice to read with yet: open Duck's drawer once on this PC.");
        return v;
      },
      lastKept: () => [...kept.values()].sort((a, b) => b.at - a.at)[0] ?? null,
      summarize: (text, signal) => oneShot("spoken_summary", text, { signal }),
    };
    // Announcements (V5).
    const announcer = new Announcer({
      settings: () => settings.get().announce,
      dndUntil: () => settings.get().dndUntil,
      // Unknown presence counts as away: a push rather than talking to an empty room.
      presence: () => getPresence().catch(() => ({ idleMs: 3_600_000, locked: false, fullScreen: false, focus: null })),
      speakOn: () => desktopSpeech?.speakOn() ?? false,
      busy: () => (desktopSpeech?.busy() ?? false) || (reader.view()?.state === "reading" && reader.view()?.where === "desktop"),
      sayHere: (text, threadId) => desktopSpeech?.announce(text, threadId) ?? Promise.resolve(false),
      phones: () => bridge?.phones() ?? 0,
      sayOnPhones: (text, threadId) => bridge?.announce(text, threadId),
      push: (threadId, title, body) => ipcLink.push(threadId, title, body),
    });
    // Through the endpoint, so every surface hears the new settings.
    let epRef: DuckEndpoint | null = null;
    const quietHost: QuietHost = {
      setDnd(until) {
        if (!epRef) throw new Error("Duck isn't started yet.");
        epRef.handle({ type: "dnd", until });
      },
      speakOn: () => desktopSpeech?.speakOn() ?? null,
      setSpeakOn(on) {
        if (!desktopSpeech) throw new Error("This PC's voice isn't running yet (open Duck's drawer once).");
        desktopSpeech.setSpeakOn(on);
      },
    };
    const engine = createEngine({
      tasks,
      autopilot,
      summaries,
      reader: readerHost,
      screen: screenHost,
      quiet: quietHost,
      mcp: createMcpHost(mcpRequest),
      eventLevel: (threadId, level) => levels.set(threadId, level),
      store: s,
      registry: createRegistry(TOOLS),
      port: localPort,
      gate: createPolicy({ settings: settings.get, trust, messages: s.loaded }),
      settings: settings.get,
      stream: async (params, opts) =>
        (await getClient()).beta.messages.stream(params, opts),
      nameThread: (text) => oneShot("title", text.slice(0, 2000)),
    });
    // Claude Code permission prompts (T2): decided under the same trust store.
    if (trust)
      startTrustWatcher({
        port: localPort,
        trust,
        judge: (r) => structured(r),
        answering: () => settings.get().answerSessionPrompts,
        notice: (threadId, text) =>
          void engine
            .notice(threadId, { kind: "trust", text })
            .catch((e: unknown) => console.warn("duck: a trust notice was dropped", e)),
      });
    const replayer: Replayer | undefined = trust
      ? async (days, judgeMax, progress) =>
          replay(await replayCalls(days, REPLAY_MAX_CALLS), {
            config: trust.config(),
            projects: localPort.listProjects(),
            judge: judgeMax > 0 ? (r) => structured(r) : null,
            judgeMax,
            home: (await homeDir().catch(() => null)) ?? undefined,
            progress,
          })
      : undefined;
    engineRef = engine;
    // Anything you say pauses a read (you've moved on; "continue reading" resumes).
    engine.onEvent((ev) => {
      if (ev.type === "message" && ev.message.role === "user" && USER_SOURCES.has(ev.message.source)) {
        reader.pause();
        announcer.answeredThread(ev.message.threadId);
      }
    });
    // A Workbench event's turn: its reply is the news.
    const eventTurns = new Map<string, { level: Level; reply: string; seq: number }>();
    engine.onEvent((ev) => {
      if (ev.type === "message") {
        const m = ev.message;
        if (m.role === "user" && m.source === "event") {
          eventTurns.set(m.threadId, { level: levels.get(m.threadId) ?? "report", reply: "", seq: m.seq });
          levels.delete(m.threadId);
        } else if (m.role === "assistant") {
          const t = eventTurns.get(m.threadId);
          const text = replyText(m.content);
          if (t && text.trim()) t.reply = text;
        }
      } else if (ev.type === "turnState" && (ev.state === "idle" || ev.state === "waiting")) {
        const t = eventTurns.get(ev.threadId);
        if (!t) return;
        eventTurns.delete(ev.threadId);
        if (!t.reply) return;
        // A reply that ends asking the user something needs them.
        const asks = /\?\s*$/.test(t.reply.trim());
        announcer.add({
          level: asks ? "needs_you" : t.level,
          text: headline(t.reply),
          threadId: ev.threadId,
          key: `event:${ev.threadId}:${t.seq}`,
        });
      } else if (ev.type === "confirm") {
        // A card nobody is looking at.
        if (document.hasFocus() && !document.hidden) return;
        const r = ev.request;
        announcer.add({
          level: "needs_you",
          text: `Duck is waiting for a yes or no: ${r.summary ?? `it wants to use ${r.name}`}`,
          threadId: r.threadId,
          key: `card:${r.toolUseId}`,
        });
      } else if (ev.type === "confirmed") announcer.answered(`card:${ev.toolUseId}`);
    });
    await tasks.load().catch((e: unknown) => console.error("duck: worker tasks didn't load", e));
    await autopilot.load().catch((e: unknown) => console.error("duck: autopilots didn't load", e));
    const ep = endpoint(
      engine,
      s,
      ledger,
      settings,
      trust,
      replayer,
      tasks,
      autopilot,
      {
        reader,
        subscribe(cb) {
          readerListeners.add(cb);
          return () => readerListeners.delete(cb);
        },
      },
      () => announcer.poke(),
    );
    epRef = ep;
    duck = createLocalTransport(ep);
    bridge = startRemoteBridge({
      duck: ep,
      link: ipcLink,
      watching: () => document.hasFocus() && !document.hidden,
      fixVoice: (text) =>
        voiceMessage(text, [
          ...localPort.listProjects().map((p) => p.name),
          ...localPort.listSessions().map((x) => x.title),
        ]),
      prepare: (sentence) => prepareSentence(sentence, (t, signal) => oneShot("speakable_ru", t, { signal })),
      render: async (text, lang) => {
        const id = crypto.randomUUID();
        return { id, seconds: await ttsRender(id, text, lang) };
      },
      warm: (ru) => void ttsWarm(ru).catch(() => {}),
    });
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
