// Remote state mirror (step 4.3, design §11) — pushes a live snapshot of the app's
// state to the backend whenever it changes, so the remote server can serve it to
// paired clients. This is the decision-1 boundary: the card-status state machine
// stays in the frontend (`state/status.ts`), and rather than reimplement it in Rust
// we mirror the *result* here.
//
// Implemented as a render-nothing component (not a store subscription) so it can read
// the four contributing stores through their existing hooks — registry, live
// statuses, consoles (is it running?), and account usage limits — and re-push on any
// change. Pushes are debounced to coalesce the ~2 s token ticks; gated on the server
// actually running so we don't do needless IPC while remote access is off (the
// default). Mounted once from `App.tsx` (main window only).

import { useEffect, useRef } from "react";
import { remotePushSnapshot } from "../ipc/remote";
import { useRegistry } from "../state/registry";
import { useConsoles } from "../state/consoles";
import { useLiveStatuses } from "../state/status";
import { useUsageLimits } from "../state/usageLimits";
import { useRemoteServer } from "../state/remoteServer";
import { contextWindowTokens } from "../util/format";

/** One push per this window, to coalesce bursts of token/status updates. */
const PUSH_DEBOUNCE_MS = 250;

export default function RemoteMirror(): null {
  const registry = useRegistry();
  const consoles = useConsoles();
  const statuses = useLiveStatuses();
  const limits = useUsageLimits();
  const server = useRemoteServer();
  const running = server?.running ?? false;
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
      const liveIds = new Set(
        consoles.open.filter((c) => c.status === "running").map((c) => c.instanceId),
      );
      const snapshot = {
        updatedAt: Math.floor(Date.now() / 1000),
        usageLimits: limits,
        instances: registry.instances.map((i) => {
          const live = statuses.get(i.id);
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
            status: i.status, // persisted fallback for a card with no live status
            ctxTokens: contextWindowTokens(i),
            live: liveIds.has(i.id),
          };
        }),
      };
      void remotePushSnapshot(JSON.stringify(snapshot)).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [running, registry, consoles, statuses, limits]);

  return null;
}
