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
  sheetCells,
  sheetDraft,
  sheetDrafts,
  sheetRead,
  sheetSearch,
  sheetExport,
  workspacePrepare,
  taskResult,
  attachBytes,
  attachData,
  attachPrepare,
  attachPrune,
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
import { createBrainHost } from "./brain/subscription";
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
import { createTurnClock, statLine, timingStats, type TurnTiming } from "./timings";
import { createThreadStore, ipcBackend, type ThreadStore } from "./threads";
import type { ReaderHost } from "./tools/readAloud";
import type { ScreenHost } from "./tools/screenshot";
import type { QuietHost } from "./tools/quiet";
import { routineView, type RoutinesHost } from "./tools/routines";
import { watchedThreads } from "./tools/act";
import { createRoutines, Routine, type RoutineBackend } from "./routines";
import { createHousekeeping, type GitLane, type Housekeeping } from "./housekeeping";
import { backupCreate, backupPush, backupStatus, branchReview, housekeep, routineDelete, routineList, routinePut } from "../ipc/routines";
import { createCoreHost } from "./core";
import { createConfig, ipcConfigStore } from "./config";
import { createMemoryHost, type TidyReport } from "./memory";
import { Consolidation, createConsolidator, type Consolidator } from "./consolidate";
import { memoryApply, memoryList, memoryStateGet, memoryStateSet } from "../ipc/memory";
import { createMcpHost } from "./mcp";
import { createGoogleHost } from "./google";
import { createRegistry, toolsOn } from "./tools/registry";
import { connectLocal, createHosts } from "./hosts";
import { pcHandlers } from "./tools/pc";
import { youtubeMusic } from "./music/youtube";
import { youtubeSearch } from "../ipc/music";
import {
  onReminderAction,
  onRemindersChanged,
  reminderPush,
  reminderSeenSet,
  remindersPut,
  remindersRead,
  remindersSeen,
  remindersWatch,
  timerSet,
  timersList,
} from "../ipc/reminders";
import {
  createReminderClock,
  createReminders,
  dueText,
  localStamp,
  phoneAlarms,
  projectLine,
  repeatText,
  SNOOZE_MINUTES,
  view as reminderView,
  type RemindersBackend,
  type RemindersHost,
} from "./reminders";
import { change as changeReminder, closing, snoozing } from "./tools/reminders";
import { OFFLINE_TITLE } from "./offline";
import { mediaControl, mediaNowPlaying, pcOpen, steamActivity, steamLibrary, steamStoreSearch } from "../ipc/pc";
import { createBrowserHost } from "./browser";
import { createHostedSync, type HostedSync } from "./hosted";
import { firefoxStartProfile, mcpHostCall, mcpHostRunning, mcpHostServers, mcpHostTools } from "../ipc/mcpHost";
import { DEFERRED, SERVER_TOOLS, TOOL_NAMES, TOOLS } from "./toolset";
import { createTaskManager, ipcTaskBackend, type Task, type TaskManager } from "./tasks";
import { voiceMessage } from "./voiceNames";
import { createSkills, type Skill, type SkillsHost } from "./skills";
import { allModes, isModeId, modeOf, thinksOnSession } from "./modes";
import { skillsList, skillWrite } from "../ipc/duckSkills";
import { FLOOR } from "./trust/floor";
import { replay, type ReplayReport } from "./trust/replay";
import { createTrustStore, ipcTrustBackend, type TrustStore } from "./trust/store";
import { startTrustWatcher } from "./trust/watcher";
import { startDelegateWatcher } from "./trust/delegate";
import { createPromoter, type Promoter } from "./trust/promote";
import { claudeLocalSettingsRead, claudeLocalSettingsWrite } from "../ipc/fs";
import { timingAdd, timingsSince } from "../ipc/assistant";

/** Decisions per page of the log. */
const DECISION_PAGE = 50;

export function trustView(t: TrustStore): TrustView {
  const c = t.config();
  return {
    ...c,
    floor: FLOOR.map((f) => ({ id: f.id, label: f.label, on: !c.floorOff.includes(f.id) })),
  };
}

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
let consolidator: Consolidator | null = null;

/** How often the nightly tidy (step L2) checks whether it's due. */
const TIDY_CHECK_MS = 5 * 60_000;
/** How often routines (step L4) check what's due. */
const ROUTINE_CHECK_MS = 60_000;
/** A thread a surface showed this recently counts as open there (L4). */
const VIEWED_MS = 12 * 3_600_000;

/** The thread each surface shows (`thread.view`), and when it said so. */
const viewing = new Map<string, { threadId: string; at: number }>();

/** Routine records in duck.db; a record that no longer parses is skipped. */
const ipcRoutineBackend: RoutineBackend = {
  put: (r) => routinePut(r.id, JSON.stringify(r)),
  async list() {
    const out: Routine[] = [];
    for (const row of await routineList()) {
      try {
        out.push(Routine.parse(JSON.parse(row)));
      } catch (e) {
        console.warn("duck: a routine record didn't parse", e);
      }
    }
    return out;
  },
  remove: routineDelete,
};

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
    self: t.self,
    changes: t.changes && { branch: t.changes.branch, files: t.changes.files, uncommitted: t.changes.uncommitted, safety: t.changes.safety },
  };
}

/** Connect a surface to an engine over the protocol. */
/** Where the turns' timings are kept (step D3). */
export interface TimingsHost {
  add(t: TurnTiming): Promise<void>;
  since(ms: number): Promise<TurnTiming[]>;
  /** The subscription's 5-hour window now, in percent. */
  fiveHour(): Promise<number | null>;
}

/** The settings' readout covers this many days. */
const TIMINGS_DAYS = 30;

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
  routines?: RoutinesHost,
  skills?: SkillsHost,
  promoter?: Promoter,
  timings?: TimingsHost,
  hosted?: HostedSync,
  reminders?: RemindersHost,
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

  // How long each turn took, on which brain (step D3).
  if (timings) {
    const clock = createTurnClock({
      fiveHour: timings.fiveHour,
      cost: (threadId) => meter.turns()[threadId] ?? 0,
      subscriptionModel: (mode) => {
        const now = settings?.get();
        return now && thinksOnSession(modeOf(mode), now.sessionModes) ? now.sessionModel : "sonnet";
      },
      keep: (t) => void timings.add(t).catch((err: unknown) => console.warn("duck: a turn's timing was dropped", err)),
    });
    e.onEvent((ev) => clock.event(ev));
  }

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
  const sendRoutines = async (to = say) => {
    if (!routines) return;
    const st = await routines.backup.status().catch(() => null);
    const b = routines.routines.list().find((r) => r.action.kind === "job" && r.action.job === "backup");
    const failing = b && typeof b.memo.failingSince === "number" && typeof b.memo.lastError === "string" ? b.memo.lastError : null;
    to({
      type: "routines",
      routines: routines.routines.list().map((r) => {
        const v = routineView(r);
        return { id: r.id, title: r.title, when: v.when, does: v.does, on: r.enabled, builtIn: r.builtIn, next: r.nextRun, last: r.lastRun, lastResult: r.lastResult };
      }),
      backup: st && { repo: st.repo, remote: st.remote, ahead: st.ahead, failing },
    });
  };
  routines?.routines.subscribe(() => void sendRoutines().catch(fail));
  const skillsEvent = (list: Skill[]): DuckEvent => ({
    type: "skills",
    skills: list.map((x) => ({
      name: x.name,
      description: x.description,
      path: x.path,
      mode: x.mode?.id ?? null,
      tools: x.tools,
      problems: x.problems,
      enabled: x.enabled,
    })),
    modes: allModes().map((m) => ({ id: m.id, title: m.title, about: m.about, own: !isModeId(m.id) })),
  });
  const sendSkills = async (to = say) => {
    if (skills) to(skillsEvent(await skills.list()));
  };
  skills?.onChange((list) => say(skillsEvent(list)));
  reader?.subscribe((v) => say({ type: "reader", reader: v }));
  // The open reminders (H8), for the widget.
  const sendReminders = (to = say, pulse = false) => {
    if (!reminders) return;
    const now = Date.now();
    to({
      type: "reminders",
      reminders: reminders.list().filter((r) => r.state === "open").map((r) => reminderView(r, now)),
      problem: reminders.problem(),
      ...(pulse && { pulse }),
    });
  };
  reminders?.subscribe((pulse) => sendReminders(say, pulse));
  const needTrust = () => {
    if (!trust) throw new Error("Duck's trust settings didn't load.");
    return trust;
  };
  const sendPromotions = (to = say) => {
    if (promoter) to({ type: "promotions", promotions: promoter.list() });
  };
  promoter?.subscribe(() => sendPromotions());
  const needPromoter = () => {
    if (!promoter) throw new Error("Promotions aren't available here.");
    return promoter;
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
      case "turn.files":
        e.lateFiles(msg.threadId, msg.attachments, msg.source);
        return;
      case "confirm":
        await e.confirm(msg.threadId, msg.toolUseId, msg.allow, msg.choice);
        return;
      case "thread.new":
        await e.newThread(msg.mode);
        return;
      case "thread.delete":
        await e.deleteThread(msg.threadId);
        return;
      case "thread.compact":
        await e.compact(msg.threadId);
        return;
      case "thread.memory":
        await e.notice(msg.threadId, {
          kind: "memoryOff",
          off: msg.off,
          text: msg.off ? "Duck won't remember this conversation." : "Duck may remember this conversation again.",
        });
        return;
      case "sync":
        answer({ type: "threads", threads: [...s.threads()] });
        for (const request of e.pendingRequests())
          answer({ type: "confirm", request });
        if (settings) answer({ type: "settings", settings: settings.get() });
        if (trust) answer({ type: "trust", trust: trustView(trust) });
        sendPromotions(answer);
        sendTasks(answer);
        sendAutopilots(answer);
        await sendRoutines(answer);
        await sendSkills(answer).catch(fail);
        if (reader) answer({ type: "reader", reader: reader.reader.view() });
        sendReminders(answer);
        await sendSpend(answer);
        return;
      case "settings.set":
        if (!settings) throw new Error("Duck's settings aren't available.");
        say({
          type: "settings",
          settings: await settings.set(msg.settings),
        });
        onSettings?.();
        // A skill turned on or off is told by the list's change.
        if (msg.settings.disabledSkills) void skills?.list().catch(fail);
        // A hosted server turned on or off (B2): its tools come or go.
        if (hosted && (msg.settings.mcpHost || msg.settings.firefox))
          void hosted
            .sync()
            .then(async () => say({ type: "hosted", servers: await hosted.view() }))
            .catch(fail);
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
      case "trust.promotion.preview":
        answer({ type: "promotionPreview", preview: await needPromoter().preview(msg.key) });
        return;
      case "trust.promote":
        answer({ type: "promoted", key: msg.key, text: await needPromoter().promote(msg.key, msg.to, msg.before) });
        return;
      case "trust.promotion.dismiss":
        await needPromoter().dismiss(msg.key);
        return;
      case "hosted.get": {
        if (hosted && msg.refresh) await hosted.sync(msg.refresh);
        answer({ type: "hosted", servers: hosted ? await hosted.view() : [] });
        return;
      }
      case "timings.get": {
        const rows = timings ? await timings.since(Date.now() - TIMINGS_DAYS * 86_400_000) : [];
        answer({ type: "timings", lines: timingStats(rows).map(statLine) });
        return;
      }
      case "thread.keep":
        await e.keepThread(msg.threadId, msg.keep);
        return;
      case "thread.view":
        if (msg.threadId) viewing.set(msg.surface, { threadId: msg.threadId, at: Date.now() });
        else viewing.delete(msg.surface);
        return;
      case "routine.set": {
        if (!routines) throw new Error("Routines aren't available here.");
        const r = routines.routines;
        if (msg.action === "delete") await r.remove(msg.id);
        else if (msg.action === "run") await r.runNow(msg.id);
        else await r.setEnabled(msg.id, msg.action === "resume");
        return;
      }
      case "backup.create": {
        if (!routines) throw new Error("Routines aren't available here.");
        await routines.backup.create(msg.name);
        const b = routines.routines.list().find((x) => x.action.kind === "job" && x.action.job === "backup");
        if (b) await routines.routines.runNow(b.id);
        await sendRoutines();
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
      case "task.diff": {
        const t = tasks?.get(msg.taskId);
        if (!t?.projectId || !t.instanceId) throw new Error("That task has no session to show the diff of.");
        localPort.openPanel(t.projectId, "diff", t.instanceId);
        return;
      }
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
    const startedAt = Date.now();
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
      // What a worker made (G1): chips in its thread, before the report.
      files: (threadId, files, title) =>
        void engineRef
          ?.notice(threadId, { kind: "files", text: `Files from ${title}`, files })
          .catch((e: unknown) => console.warn("duck: a task's files weren't posted", e)),
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
    // Long-term memory (L1), tidied every night (L2).
    const memory = createMemoryHost(() => settings.get().workspace);
    const tidier = createConsolidator({
      threads: () => s.threads(),
      messages: (id) => s.messages(id),
      tasks: () => tasks.list(),
      list: () => memoryList(settings.get().workspace),
      apply: (plan, message) => memoryApply(settings.get().workspace, plan, message),
      state: { get: memoryStateGet, set: memoryStateSet },
      call: (input, signal) => oneShot("consolidate", input, { schema: Consolidation, signal }),
      idleMs: () => getPresence().then((p) => p.idleMs),
    });
    memory.question = () => tidier.question();
    memory.suggestion = () => tidier.suggestion();
    memory.skillOffer = () => tidier.skillOffer();
    // Routines (step L4): the backup, the weekly housekeeping, the monthly docs
    // clean-up, and the user's own.
    const ws = () => settings.get().workspace;
    // Reminders (H8): `reminders.json` in Duck's repo, read again on a hand edit.
    const remindersBackend: RemindersBackend = {
      read: () => remindersRead(ws()),
      put: (id, before, after, message) => remindersPut(ws(), id, before, after, message),
      seen: remindersSeen,
      setSeen: reminderSeenSet,
      timers: timersList,
      setTimer: timerSet,
    };
    const reminders = createReminders({ backend: remindersBackend, spellMinutes: () => settings.get().reminderSpellMinutes });
    const warnReminders = (e: unknown) => console.warn("duck: reminders", e);
    const watchReminders = () => {
      void remindersWatch(ws()).catch(warnReminders);
      void reminders.load().catch(warnReminders);
    };
    watchReminders();
    void reminders.loadTimers().catch(warnReminders);
    onRemindersChanged(() => void reminders.load().catch(warnReminders));
    const git: GitLane = {
      status: () => backupStatus(ws()),
      push: () => backupPush(ws()),
      review: (b) => branchReview(ws(), b),
      housekeep: (cutoff) => housekeep(ws(), cutoff),
    };
    let housekeeping: Housekeeping | null = null;
    const routines = createRoutines({
      backend: ipcRoutineBackend,
      run: (r) => (housekeeping ? housekeeping.run(r) : Promise.reject(new Error("housekeeping isn't ready"))),
      idleMs: () => getPresence().then((p) => p.idleMs),
    });
    const pushAfterTidy = () => {
      const b = routines.list().find((r) => r.action.kind === "job" && r.action.job === "backup");
      if (b) void routines.runNow(b.id).catch((e: unknown) => console.warn("duck: the backup after the tidy failed", e));
    };
    housekeeping = createHousekeeping({
      routines,
      tasks,
      port: localPort,
      settings: settings.get,
      git,
      duckProject: async () => (await localPort.ensureProject("Duck", await workspacePrepare(ws()))).id,
      threads: {
        list: () => s.threads(),
        create: async (title) => {
          if (!engineRef) throw new Error("Duck isn't started yet.");
          return (await engineRef.newThread(undefined, title)).id;
        },
        remove: async (id) => {
          if (!engineRef) throw new Error("Duck isn't started yet.");
          await engineRef.deleteThread(id);
        },
      },
      busy: (id) => {
        const state = engineRef?.state(id) ?? "idle";
        if (state !== "idle") return state === "waiting" ? "parked on a card" : "a reply is running";
        if (s.pending().some((b) => b.threadId === id)) return "parked on a card";
        if (watchedThreads().has(id)) return "it watches a session";
        const now = Date.now();
        for (const v of viewing.values()) if (v.threadId === id && now - v.at < VIEWED_MS) return "open on a surface";
        return null;
      },
      piloted: () => new Set(autopilot.list().filter((a) => a.state !== "stopped").map((a) => a.threadId)),
      consolidatedTo: async () => (await tidier.last())?.at ?? null,
      resultJson: (t) => taskResult(t.workspace, t.folder).then((r) => r.json),
      pruneFiles: attachPrune,
      tell: (threadId, text, level) => {
        levels.set(threadId, level);
        void engineRef
          ?.send({ threadId, text: eventText(text), source: "event" })
          .catch((e: unknown) => console.warn("duck: a routine's report was dropped", e));
      },
    });
    // Duck's skills (S2): the files in the workspace's skills/, read on every request.
    const skills = createSkills({
      store: {
        list: () => skillsList(settings.get().workspace),
        write: (name, text, expected, message) => skillWrite(settings.get().workspace, name, text, expected, message),
      },
      tools: () => TOOL_NAMES,
      disabled: () => settings.get().disabledSkills,
    });
    // The modes they declare are known before any thread of theirs runs.
    await skills.list().catch((e: unknown) => console.warn("duck: the skills couldn't be read", e));
    const routinesHost: RoutinesHost = {
      routines,
      housekeeping,
      backup: { status: git.status, create: (name) => backupCreate(ws(), name) },
    };
    memory.tidy = () =>
      tidier.run().then((r) => {
        pushAfterTidy();
        return r;
      });
    consolidator = tidier;
    setInterval(
      () =>
        void tidier
          .tick()
          .then((r) => r && pushAfterTidy())
          .catch((e: unknown) => console.warn("duck: the nightly memory tidy failed", e)),
      TIDY_CHECK_MS,
    );
    // Duck's own processes for stdio MCP servers, your Firefox bridge first (B2).
    const registry = createRegistry(TOOLS, { deferred: DEFERRED, server: SERVER_TOOLS });
    const browser = createBrowserHost({ call: mcpHostCall, startProfile: firefoxStartProfile });
    const hosted = createHostedSync({
      registry,
      settings: settings.get,
      listTools: mcpHostTools,
      servers: mcpHostServers,
      running: mcpHostRunning,
      refLine: browser.refLine,
    });
    void hosted.sync().catch((e: unknown) => console.warn("duck: the hosted MCP servers didn't load", e));
    // Tools that run where they act (H1): the PC's here, in process (H2: Steam,
    // the media sessions, opening a link); the phone's over its socket.
    const hosts = createHosts((host) => toolsOn(TOOLS, host));
    connectLocal(
      hosts,
      "pc",
      pcHandlers({
        library: steamLibrary,
        storeSearch: steamStoreSearch,
        activity: steamActivity,
        open: pcOpen,
        nowPlaying: mediaNowPlaying,
        control: mediaControl,
      }),
    );
    const engine = createEngine({
      attachments: { prepare: attachPrepare, data: attachData },
      tasks,
      autopilot,
      summaries,
      reader: readerHost,
      screen: screenHost,
      quiet: quietHost,
      haiku: (input, signal) => oneShot("haiku_task", input, { signal }),
      mcp: createMcpHost(mcpRequest),
      hosted: { call: mcpHostCall, browser },
      hosts,
      music: youtubeMusic({ search: youtubeSearch }),
      reminders,
      google: createGoogleHost({ workspacePrepare, sheetExport, sheetCells, sheetDraft, sheetDrafts, sheetSearch, sheetRead }),
      core: createCoreHost(() => settings.get().workspace),
      memory,
      config: createConfig(ipcConfigStore(() => settings.get().workspace)),
      routines: routinesHost,
      skills,
      eventLevel: (threadId, level) => levels.set(threadId, level),
      store: s,
      registry,
      port: localPort,
      gate: createPolicy({ settings: settings.get, trust, messages: s.loaded }),
      settings: settings.get,
      degraded: () => localPort.spend().then((x) => x.softReached),
      brain: createBrainHost(() => workspacePrepare(settings.get().workspace)),
      limits: () => localPort.usageLimits(),
      stream: async (params, opts) =>
        (await getClient()).beta.messages.stream(params, opts),
      nameThread: (text) => oneShot("title", text.slice(0, 2000)),
    });
    const trustNotice = (threadId: string, text: string) =>
      void engine
        .notice(threadId, { kind: "trust", text })
        .catch((e: unknown) => console.warn("duck: a trust notice was dropped", e));
    // Questions and plans outside autopilot runs and workers (T3).
    const delegate = trust
      ? startDelegateWatcher({
          port: localPort,
          trust,
          call: (r) => structured(r),
          notice: trustNotice,
          planApproval: () => settings.get().planApproval,
          skip: (id) => autopilot.get(id)?.state === "running",
        })
      : null;
    // Claude Code permission prompts (T2): decided under the same trust store.
    if (trust)
      startTrustWatcher({
        port: localPort,
        trust,
        judge: (r) => structured(r),
        answering: () => settings.get().answerSessionPrompts,
        holdOther: delegate ? (id) => delegate.hold(id) : undefined,
        notice: trustNotice,
      });
    // Often-approved patterns, offered for Claude Code's allow list (T3).
    const promoter = trust
      ? createPromoter({
          trust,
          projects: () => localPort.listProjects(),
          settled: () => settings.get().settledPromotions,
          settle: (keys) => settings.set({ settledPromotions: keys }).then(() => {}),
          readSettings: claudeLocalSettingsRead,
          writeSettings: claudeLocalSettingsWrite,
        })
      : undefined;
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
    // Where a reminder's line goes: the thread the drawer shows, else the latest.
    const activeThread = async (): Promise<string> => {
      const v = viewing.get("desktop");
      if (v && s.thread(v.threadId)) return v.threadId;
      return s.threads()[0]?.id ?? (await engine.newThread(undefined, "Reminders")).id;
    };
    // Timed reminders, announced once when due (late when the app was closed).
    void createReminderClock({
      reminders,
      backend: remindersBackend,
      startedAt,
      // Every channel at once (H4): the thread, the announcer (spoken with Speak
      // on), the widget's pulse, and a push to the phone with Done and Snooze.
      announce: (r, late, at) =>
        void (async () => {
          const threadId = await activeThread();
          const text = late ? `Reminder, late (it was due ${dueText(at)}): ${r.title}` : `Reminder: ${r.title}`;
          await engine.notice(threadId, { kind: "reminder", text });
          announcer.add({ level: "report", text, threadId, key: `reminder:${r.id}` });
          reminders.pulse();
          const body = [late && `Late: it was due ${dueText(at)}`, r.details, r.repeat && repeatText(r.repeat)].filter(Boolean).join(" · ");
          await reminderPush(r.id, threadId, `⏰ ${r.title}`, body, true);
        })().catch(warnReminders),
      ring: (t, late) =>
        void (async () => {
          const threadId = t.threadId && s.thread(t.threadId) ? t.threadId : await activeThread();
          const what = t.label ? `${t.label} (${t.length})` : t.length;
          const text = late ? `Timer done while the app was closed: ${what}` : `Timer done: ${what}`;
          await engine.notice(threadId, { kind: "reminder", text });
          announcer.add({ level: "report", text, threadId, key: `timer:${t.id}` });
          reminders.pulse();
          await reminderPush(t.id, threadId, `⏲ ${t.label ?? "Timer"}`, `${t.length} timer done`, false);
        })().catch(warnReminders),
    })
      .then((clock) => {
        reminders.subscribe((pulse) => pulse || clock.arm());
        clock.arm();
      })
      .catch(warnReminders);
    // A push's Done or Snooze, tapped on the phone (H4): the same change Duck's
    // tools make, with its chip in the thread.
    // Done or Snooze from a notification: the push's (H4), or the phone app's own (H5).
    const actOnReminder = (id: string, action: "done" | "snooze") =>
      void (async () => {
        const threadId = await activeThread();
        const until = localStamp(new Date(Date.now() + SNOOZE_MINUTES * 60_000));
        await changeReminder({ reminders, notice: (n) => engine.notice(threadId, n) }, id, (now) => {
          if (!now || now.state !== "open") throw new Error("it's no longer open");
          return action === "done" ? closing(now, "done", new Date()) : snoozing(now, until);
        });
      })().catch(warnReminders);
    onReminderAction(({ id, action }) => actOnReminder(id, action));
    // A session you start: its project's reminders, one line (no model turn).
    localPort.onSessionYouStarted((_id, projectId) => {
      const list = reminders.forProject(projectId);
      if (!list.length) return;
      const name = localPort.listProjects().find((p) => p.id === projectId)?.name ?? list[0].project?.name ?? "";
      void activeThread()
        .then((threadId) => engine.notice(threadId, { kind: "reminder", text: projectLine(name, list) }))
        .then(() => reminders.pulse())
        .catch(warnReminders);
    });
    await tasks.load().catch((e: unknown) => console.error("duck: worker tasks didn't load", e));
    await autopilot.load().catch((e: unknown) => console.error("duck: autopilots didn't load", e));
    await routines.load().catch((e: unknown) => console.error("duck: routines didn't load", e));
    void housekeeping.check().catch(() => {});
    // The first check soon after start: a routine missed while the app was closed
    // runs once now.
    const tickRoutines = () => void routines.tick().catch((e: unknown) => console.warn("duck: a routine failed", e));
    setTimeout(tickRoutines, 30_000);
    setInterval(tickRoutines, ROUTINE_CHECK_MS);
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
      () => {
        announcer.poke();
        // The workspace may have moved: watch and read its reminders.
        watchReminders();
      },
      routinesHost,
      skills,
      promoter,
      {
        add: (t) => timingAdd(t.at, JSON.stringify(t)),
        since: async (ms) => (await timingsSince(ms)).flatMap((r) => {
          try {
            return [JSON.parse(r) as TurnTiming];
          } catch {
            return [];
          }
        }),
        fiveHour: async () => (await localPort.usageLimits())?.fiveHour?.usedPercentage ?? null,
      },
      hosted,
      reminders,
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
      hosts,
      attach: attachBytes,
      phoneReminders: {
        alarms: () => phoneAlarms(reminders.list(), Date.now()),
        subscribe: (cb) => reminders.subscribe((pulse) => pulse || cb()),
        act: actOnReminder,
      },
      // What the phone's offline brain made (H7): reminders by id, each
      // conversation a thread of its own.
      offline: async (records, threads) => {
        const took = { reminders: [] as string[], threads: [] as string[] };
        for (const r of records) {
          try {
            if (!reminders.list().some((x) => x.id === r.id)) {
              const threadId = await activeThread();
              await changeReminder({ reminders, notice: (n) => engine.notice(threadId, n) }, null, () => ({
                after: r,
                message: `reminders: added "${r.title.slice(0, 60)}" on the phone, offline`,
                chip: `Reminder added on the phone, offline: ${r.title}`,
              }));
            }
            took.reminders.push(r.id);
          } catch (e) {
            warnReminders(e);
          }
        }
        for (const t of threads) {
          await engine.importThread({
            id: t.id,
            title: OFFLINE_TITLE(t.title),
            messages: t.messages.map((m) => ({ role: m.role, text: m.text, source: m.voice ? "phone-voice" : "phone" })),
          });
          took.threads.push(t.id);
        }
        return took;
      },
    });
  })().catch((e: unknown) => {
    started = null;
    console.error("duck: init failed", e);
  });
  return started;
}

/** Tidy Duck's long-term memory now (the Memory view's button). */
export function tidyMemory(): Promise<TidyReport> {
  if (!consolidator) return Promise.reject(new Error("Duck isn't started yet."));
  return consolidator.run();
}

/** The last tidy, for the Memory view. */
export function lastTidy(): Promise<{ date: string; report: TidyReport } | null> {
  return consolidator?.last() ?? Promise.resolve(null);
}

/** The transport to the running Duck, or `null` until `initAssistant` finished. */
export function getDuck(): Transport | null {
  return duck;
}
