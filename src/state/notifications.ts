// Notification routing & escalation (step 4.6, design §7).
//
// The one place that turns live card status into *outbound* alerts — both the
// routing (which destinations a "needs you" reaches) and the escalation (when a
// waiting/working card deserves a louder nudge).
//
// Routing (design §7 "notification routing"): a fresh ● needs-you is delivered to
// the enabled destinations — the **desktop** (an OS toast) and the **phone
// dashboard** (which already streams the live snapshot, step 4.4; we add the
// escalation emphasis to that snapshot via the alerts store below). A **webhook**
// route (Discord/Slack/ntfy) is a deliberate, isolated future seam: it would slot
// into `deliver*` and the prefs shape, nothing else. (Workbench can't call a Discord
// *MCP* server — those are the agent's tools, not an app API — so a webhook URL is
// the natively-feasible path when that route lands.)
//
// Escalation (design §7 "idle/stuck escalation"): a background tick watches every
// live card. A card held in ● needs-you past `escalateAfterMin` gets a louder
// desktop re-ping and is marked *escalated* for the phone; a card in ◐ working past
// `stuckAfterMin` is flagged *possibly stuck*. "Far longer than usual" is
// approximated by a fixed, user-configurable threshold — a learned per-instance
// baseline is a future refinement, not needed to make the feature useful.
//
// Layering: sole owner of the needs-you → notification path (the rail's old direct
// OS-toast call moved here). Reads live status from the 2.2 store, names from the
// registry, and writes a tiny external alerts store that the remote mirror (4.3) and
// any rail UI subscribe to. App-lifetime, like the status engine: started once, no
// teardown.

import { useSyncExternalStore } from "react";
import { getLiveStatuses, onStatusTransition, type StatusPhase } from "./status";
import { getRegistry } from "./registry";
import { notifyAlert, notifyNeedsYou } from "../ipc/attention";
import { getPref, setPref, type NotificationPrefs } from "../ipc/prefs";

export type { NotificationPrefs };

/** Sensible defaults: desktop + phone on; escalate a stuck-waiting prompt after 5
 *  min; flag a working agent as possibly stuck after 30. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  desktop: true,
  phone: true,
  escalateAfterMin: 5,
  stuckAfterMin: 30,
};

/** How often the escalation watch re-evaluates every live card. Coarse on purpose —
 *  the thresholds are in minutes, so ±15 s granularity is invisible. */
const TICK_MS = 15_000;

// --- config store -----------------------------------------------------------
// In-memory mirror of the persisted prefs, so the synchronous delivery path and the
// tick read it without an await. The settings UI writes through `setNotificationConfig`.

let config: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
const configListeners = new Set<() => void>();
/** Set once the user (or a write) touches the config, so the initial async load
 *  doesn't clobber a change made in the brief window before it resolved. */
let configDirty = false;

export function getNotificationConfig(): NotificationPrefs {
  return config;
}

/** Patch the config: apply in memory (instant), persist, and re-evaluate now so a
 *  lowered threshold escalates immediately instead of waiting for the next tick. */
export async function setNotificationConfig(patch: Partial<NotificationPrefs>): Promise<void> {
  configDirty = true;
  config = { ...config, ...patch };
  for (const l of configListeners) l();
  await setPref("notifications", config);
  tick();
}

/** Subscribe a component (the settings menu) to config changes. */
export function useNotificationConfig(): NotificationPrefs {
  return useSyncExternalStore(
    (cb) => {
      configListeners.add(cb);
      return () => {
        configListeners.delete(cb);
      };
    },
    () => config,
  );
}

// --- alerts store -----------------------------------------------------------
// Which instances are currently escalated (needs-you too long) or stuck (working too
// long), plus when each needs-you began (for a live "waiting Nm" on the phone).
// Rebuilt each tick; only re-published on an actual change so the remote mirror
// doesn't re-push every 15 s for nothing.

export interface AlertState {
  escalated: ReadonlySet<string>;
  stuck: ReadonlySet<string>;
  /** instance id → epoch seconds the current needs-you began. */
  needsSince: ReadonlyMap<string, number>;
}

let alerts: AlertState = { escalated: new Set(), stuck: new Set(), needsSince: new Map() };
const alertListeners = new Set<() => void>();

export function getAlerts(): AlertState {
  return alerts;
}

export function useAlerts(): AlertState {
  return useSyncExternalStore(
    (cb) => {
      alertListeners.add(cb);
      return () => {
        alertListeners.delete(cb);
      };
    },
    () => alerts,
  );
}

// --- escalation watch -------------------------------------------------------

interface Track {
  phase: StatusPhase;
  /** Epoch s the current phase began — the clock for working-stuck timing. (Needs-you
   *  timing uses the status engine's own `needsSince`, which is the authoritative
   *  "when you were first asked".) */
  since: number;
  escalated: boolean;
  stuck: boolean;
}

const tracks = new Map<string, Track>();

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Re-evaluate every live card: escalate held needs-you, flag stuck working, and
 *  reconcile tracks against the live set (so a closed/killed console drops cleanly).
 *  Idempotent — a card escalates/flags at most once per phase occupancy. */
function tick(): void {
  const live = getLiveStatuses();
  const now = nowSecs();
  const escalateAfter = Math.max(1, config.escalateAfterMin) * 60;
  const stuckAfter = Math.max(1, config.stuckAfterMin) * 60;

  const escalated = new Set<string>();
  const stuck = new Set<string>();
  const needsSince = new Map<string, number>();

  for (const [id, s] of live) {
    let t = tracks.get(id);
    if (!t || t.phase !== s.phase) {
      // First sight, or a phase change: reset the clock and the per-phase flags so a
      // resolved-then-recurring needs-you (or a new working stretch) can alert again.
      t = { phase: s.phase, since: now, escalated: false, stuck: false };
      tracks.set(id, t);
    }

    if (s.phase === "needs_you") {
      const since = s.needsSince ?? t.since;
      needsSince.set(id, since);
      if (!t.escalated && now - since >= escalateAfter) {
        t.escalated = true;
        escalateNeedsYou(id, Math.max(1, Math.round((now - since) / 60)));
      }
      if (t.escalated) escalated.add(id);
    } else if (s.phase === "working") {
      if (!t.stuck && now - t.since >= stuckAfter) {
        t.stuck = true;
        flagStuck(id, Math.max(1, Math.round((now - t.since) / 60)));
      }
      if (t.stuck) stuck.add(id);
    }
  }

  // Forget instances whose live status is gone (console closed / instance killed):
  // `clearLiveStatus` doesn't fire a transition, so the tick is where we reconcile.
  for (const id of tracks.keys()) {
    if (!live.has(id)) tracks.delete(id);
  }

  if (!sameAlerts(alerts, escalated, stuck, needsSince)) {
    alerts = { escalated, stuck, needsSince };
    for (const l of alertListeners) l();
  }
}

function setEq(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function mapEq(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function sameAlerts(
  prev: AlertState,
  esc: ReadonlySet<string>,
  stk: ReadonlySet<string>,
  ns: ReadonlyMap<string, number>,
): boolean {
  return setEq(prev.escalated, esc) && setEq(prev.stuck, stk) && mapEq(prev.needsSince, ns);
}

// --- delivery ---------------------------------------------------------------

interface Resolved {
  project: string;
  title: string;
  note?: string;
}

function resolve(id: string): Resolved | null {
  const reg = getRegistry();
  const inst = reg.instances.find((i) => i.id === id);
  if (!inst) return null;
  const project = reg.projects.find((p) => p.id === inst.projectId);
  return { project: project?.name ?? "", title: inst.title, note: inst.taskNote ?? undefined };
}

function label(r: Resolved): string {
  return r.project ? `${r.project}.${r.title}` : r.title;
}

/** A fresh needs-you transition → route to the enabled destinations. The phone needs
 *  no push here: it already renders the needs-you from the live snapshot (step 4.4). */
function deliverNeedsYou(id: string): void {
  if (!config.desktop) return;
  const r = resolve(id);
  if (!r) return;
  void notifyNeedsYou(r.project, r.title, r.note).catch(() => {});
}

/** Escalation: the card has sat in needs-you past the threshold. A louder desktop
 *  re-ping; the phone picks it up via the alerts store → snapshot emphasis. */
function escalateNeedsYou(id: string, mins: number): void {
  if (!config.desktop) return;
  const r = resolve(id);
  if (!r) return;
  void notifyAlert(
    `⚠ Still waiting · ${label(r)}`,
    `Has needed you for ${mins} min with no response.`,
  ).catch(() => {});
}

/** Stuck flag: the card has run in working past the threshold (possibly hung). */
function flagStuck(id: string, mins: number): void {
  if (!config.desktop) return;
  const r = resolve(id);
  if (!r) return;
  void notifyAlert(
    `Possibly stuck · ${label(r)}`,
    `Working for ${mins} min — longer than usual.`,
  ).catch(() => {});
}

// --- lifecycle --------------------------------------------------------------

let started = false;

/** Start the routing + escalation engine. Idempotent and app-lifetime (mounted once
 *  from `App`). Loads persisted config, takes over needs-you delivery from the rail,
 *  and begins the escalation watch. */
export function initNotifications(): void {
  if (started) return;
  started = true;

  void getPref("notifications", DEFAULT_NOTIFICATION_PREFS)
    .then((c) => {
      // A toggle made before this resolved wins — don't overwrite it with the load.
      if (configDirty) return;
      config = { ...DEFAULT_NOTIFICATION_PREFS, ...c };
      for (const l of configListeners) l();
    })
    .catch(() => {});

  // Route fresh needs-you transitions (replaces the rail's old direct OS-toast call).
  onStatusTransition((id, phase, prev) => {
    if (phase === "needs_you" && prev !== "needs_you") deliverNeedsYou(id);
  });

  tick();
  setInterval(tick, TICK_MS);
}
