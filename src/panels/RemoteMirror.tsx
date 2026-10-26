// Remote state mirror (step 4.3, design §11) — pushes a live snapshot of the app's
// state to the backend whenever it changes, so the remote server can serve it to
// paired clients. This is the decision-1 boundary: the card-status state machine
// stays in the frontend (`state/status.ts`), and rather than reimplement it in Rust
// we mirror the *result* here.
//
// Implemented as a render-nothing component (not a store subscription) so it can read
// the contributing stores through their existing hooks — registry, live statuses,
// consoles (is it running?), account usage limits, the phone's own `create`
// requests (step R7) and pending prompts (step R5) — and re-push on any
// change. The office (office plan O0.3) adds each session's activity, Duck's
// state and each project's latest commit time. Pushes are debounced to coalesce
// the ~2 s token ticks; gated on the server actually running so we don't do
// needless IPC while remote access is off (the default). Mounted once from
// `App.tsx` (main window only).

import { useEffect, useRef, useState } from "react";
import { officeLastCommits } from "../ipc/office";
import type { Project } from "../ipc/registry";
import { remotePushSnapshot } from "../ipc/remote";
import type { RemoteChoice, RemoteDuck, RemoteSnapshot } from "../remote/protocol";
import { useChoiceStates, type PendingChoice } from "../state/pendingChoice";
import { useRegistry } from "../state/registry";
import { useConsoles } from "../state/consoles";
import { onStatusTransition, useLiveStatuses } from "../state/status";
import { officeDuck } from "../state/officeDuck";
import { useDuckState } from "./Assistant/duckState";
import { useSpeechState } from "./Assistant/replySpeech";
import { useUsageLimits } from "../state/usageLimits";
import { useRemoteServer } from "../state/remoteServer";
import { useCreated } from "../state/remoteCreate";
import { useAlerts, useNotificationConfig } from "../state/notifications";
import { contextWindowTokens } from "../util/format";

/** One push per this window, to coalesce bursts of token/status updates. */
const PUSH_DEBOUNCE_MS = 250;
/** How often the latest commits are read again; a session finishing its turn
 *  reads them sooner. */
const COMMITS_EVERY_MS = 60_000;
const COMMITS_AFTER_TURN_MS = 3_000;
/** A tool argument longer than this is cut for the phone: the snapshot is pushed
 *  on every change, and a whole file being written would ride along each time. */
const MAX_INPUT_CHARS = 6000;

function capped(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}
… (cut short)` : value;
  }
  if (Array.isArray(value)) return value.map(capped);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capped(v)]));
  }
  return value;
}

function remoteChoice(p: PendingChoice): RemoteChoice {
  return {
    id: p.id,
    kind: p.kind,
    toolName: p.toolName,
    input: capped(p.input) as Record<string, unknown>,
    questions: p.questions,
    options: p.terminalOnly ? [] : p.options,
    terminalOnly: p.terminalOnly,
    sent: p.sent?.label ?? null,
  };
}

/** Each local project's latest commit time (epoch seconds), read while `on`. */
function useLastCommits(projects: readonly Project[], on: boolean): ReadonlyMap<string, number | null> {
  const [commits, setCommits] = useState<ReadonlyMap<string, number | null>>(new Map());
  // The projects as a string, so a registry change elsewhere doesn't run git again.
  const key = JSON.stringify(projects.filter((p) => p.remoteSshDest == null).map((p) => [p.id, p.rootPath]));
  useEffect(() => {
    const local = JSON.parse(key) as [string, string][];
    if (!on || local.length === 0) return;
    let live = true;
    let soon: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      officeLastCommits(local.map(([, root]) => root))
        .then((times) => {
          if (live) setCommits(new Map(local.map(([id], i) => [id, times[i] ?? null])));
        })
        .catch(() => {});
    };
    read();
    const every = setInterval(read, COMMITS_EVERY_MS);
    // A turn that ends has often just committed.
    const off = onStatusTransition((_id, phase) => {
      if (phase !== "done" || soon !== null) return;
      soon = setTimeout(() => {
        soon = null;
        read();
      }, COMMITS_AFTER_TURN_MS);
    });
    return () => {
      live = false;
      clearInterval(every);
      if (soon !== null) clearTimeout(soon);
      off();
    };
  }, [on, key]);
  return commits;
}

export default function RemoteMirror(): null {
  const registry = useRegistry();
  const consoles = useConsoles();
  const statuses = useLiveStatuses();
  const limits = useUsageLimits();
  const server = useRemoteServer().status;
  const alerts = useAlerts();
  const notif = useNotificationConfig();
  const created = useCreated();
  const choices = useChoiceStates();
  // The phone's server, or the office (office plan O0.2): both read this snapshot.
  const running = (server?.running || server?.office) ?? false;
  const lastCommits = useLastCommits(registry.projects, running);
  const duckStore = useDuckState();
  const speech = useSpeechState();
  // Kept as a string so a streaming reply, which changes the store many times a
  // second, doesn't keep putting the push off.
  const duckKey = JSON.stringify(
    officeDuck({
      speaking: speech.speaking !== null,
      routines: duckStore.routines,
      states: duckStore.states,
      autopilots: duckStore.autopilots,
    }),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!running) return;
    // Trailing debounce: each state change reschedules via the cleanup below, so a
    // burst of token/status updates collapses into one push of the latest state.
    timer.current = setTimeout(() => {
      timer.current = null;
      const projectName = new Map(registry.projects.map((p) => [p.id, p.name]));
      const remoteProject = new Map(
        registry.projects.map((p) => [p.id, p.remoteSshDest != null]),
      );
      const groupName = new Map(registry.groups.map((g) => [g.id, g.name]));
      const liveIds = new Set(
        consoles.open.filter((c) => c.status === "running").map((c) => c.instanceId),
      );
      // Escalation cues (step 4.6) ride the snapshot only when the phone route is on;
      // off, the dashboard still shows live status without the extra 4.6 emphasis.
      const withAlerts = notif.phone;
      const snapshot: RemoteSnapshot = {
        updatedAt: Math.floor(Date.now() / 1000),
        usageLimits: limits,
        instances: registry.instances.map((i) => {
          const live = statuses.get(i.id);
          const pending = choices.get(i.id)?.pending ?? null;
          return {
            id: i.id,
            projectId: i.projectId,
            projectName: projectName.get(i.projectId) ?? "",
            title: i.title,
            taskNote: i.taskNote,
            branch: i.branch,
            worktreeOn: i.worktreeOn,
            remote: remoteProject.get(i.projectId) ?? false,
            // Live phase from the status engine, or null when no session is running.
            phase: live?.phase ?? null,
            compacting: live?.compacting ?? false,
            subagents: live?.subagents ?? 0,
            activity: live?.activity ?? null,
            status: i.status, // persisted fallback for a card with no live status
            ctxTokens: contextWindowTokens(i),
            live: liveIds.has(i.id),
            // Step 4.6 attention cues: when this needs-you began (live "waiting Nm"),
            // whether it has escalated, and whether a working card looks stuck.
            needsSince: withAlerts ? alerts.needsSince.get(i.id) ?? null : null,
            escalated: withAlerts && alerts.escalated.has(i.id),
            stuck: withAlerts && alerts.stuck.has(i.id),
            // Only while it is waiting: a prompt outlives needs-you by a moment.
            choice: live?.phase === "needs_you" && pending ? remoteChoice(pending) : null,
          };
        }),
        // What the phone can start a session in (step R7), in the rail's order.
        projects: registry.projects.map((p) => ({
          id: p.id,
          name: p.name,
          group: p.groupId ? groupName.get(p.groupId) ?? null : null,
          remote: p.remoteSshDest != null,
          lastCommitAt: lastCommits.get(p.id) ?? null,
        })),
        duck: JSON.parse(duckKey) as RemoteDuck,
        created: [...created],
      };
      void remotePushSnapshot(JSON.stringify(snapshot)).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [running, registry, consoles, statuses, limits, alerts, notif, created, choices, lastCommits, duckKey]);

  return null;
}
