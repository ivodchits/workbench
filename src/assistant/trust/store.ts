// The trust engine's state (step T1): the rules, the modes, the floor entries
// turned off and the kill switch, loaded once from duck.db and kept in memory so a
// decision never waits on storage. Every change is written through first. Also the
// rate guard (layer 6), which lives only in memory: an app restart, or resuming
// trust, clears it.

import * as ipc from "../../ipc/assistant";
import type { DecisionRow, TrustStateRow } from "../../ipc/assistant";
import type { Mode, TrustConfig } from "./decide";
import type { Effect, Rule } from "./rules";
import { parseRule } from "./rules";

/** More automatic approvals than this in one thread within the window pauses
 *  trust for that thread. */
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 10 * 60_000;

/** The rules a new install starts with (global; edit or delete them freely). */
export const STARTER_RULES: readonly { effect: Effect; pattern: string }[] = [
  { effect: "allow", pattern: "assistant:send_prompt" },
  { effect: "allow", pattern: "assistant:create_session" },
  { effect: "allow", pattern: "assistant:create_note" },
  { effect: "allow", pattern: "assistant:append_note" },
  { effect: "allow", pattern: "assistant:write_note" },
  { effect: "allow", pattern: "assistant:interrupt_session" },
  { effect: "allow", pattern: "assistant:answer_choice(question)" },
];
// Stopping or killing a session, deleting a note, a permission answer and resuming
// over a running session have no rule: they ask, unless the user's own words asked
// for that call. An `ask` rule would block even that, so none ships.

/** The persistence the store needs; the duck.db commands in the app, fakes in tests. */
export interface TrustBackend {
  load(): Promise<TrustStateRow>;
  seed(rules: Rule[]): Promise<TrustStateRow>;
  pause(paused: boolean): Promise<boolean>;
  ruleAdd(rule: Rule): Promise<void>;
  ruleRemove(id: string): Promise<void>;
  /** null: back to the default, `live`. */
  modeSet(projectId: string, mode: Exclude<Mode, "live"> | null): Promise<void>;
  floorSet(id: string, enabled: boolean): Promise<string[]>;
  decisionAdd(d: DecisionRow): Promise<number>;
  decisions(before: number | null, limit: number): Promise<DecisionRow[]>;
  /** The kill switch flipped elsewhere (the tray). */
  onPaused(cb: (paused: boolean) => void): () => void;
}

export const ipcTrustBackend: TrustBackend = {
  load: ipc.trustLoad,
  seed: ipc.trustSeed,
  pause: ipc.trustPause,
  ruleAdd: ipc.ruleAdd,
  ruleRemove: ipc.ruleRemove,
  modeSet: ipc.trustModeSet,
  floorSet: ipc.floorSet,
  decisionAdd: ipc.decisionAdd,
  decisions: ipc.decisions,
  onPaused(cb) {
    const off = ipc.onTrustPaused(cb);
    return () => void off.then((f) => f());
  },
};

export interface TrustStore {
  config(): TrustConfig;
  setPaused(paused: boolean): Promise<void>;
  /** Throws when the pattern isn't a rule. */
  addRule(effect: Effect, pattern: string, projectId: string | null): Promise<Rule>;
  removeRule(id: string): Promise<void>;
  /** `live` is the default, so it clears the project's row. */
  setMode(projectId: string, mode: Mode): Promise<void>;
  setFloor(id: string, enabled: boolean): Promise<void>;
  /** Count one automatic approval; true when it trips the guard for the thread. */
  approved(threadId: string, now: number): boolean;
  log(d: Omit<DecisionRow, "id">): Promise<DecisionRow>;
  decisions(before: number | null, limit: number): Promise<DecisionRow[]>;
  /** Hear config changes and new decisions. */
  subscribe(cb: (change: { decision?: DecisionRow }) => void): () => void;
}

export async function createTrustStore(
  backend: TrustBackend,
  opts: { newId?: () => string; now?: () => number } = {},
): Promise<TrustStore> {
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? Date.now;
  let row = await backend.load();
  if (!row.seeded)
    row = await backend.seed(
      STARTER_RULES.map((r, i) => ({
        id: newId(),
        effect: r.effect,
        pattern: r.pattern,
        projectId: null,
        created: now() + i,
      })),
    );
  let rules: Rule[] = row.rules;
  let modes: Record<string, Mode> = Object.fromEntries(row.modes.map((m) => [m.projectId, m.mode]));
  let floorOff: string[] = row.floorOff;
  let paused = row.paused;
  let tripped: string[] = [];
  const approvals = new Map<string, number[]>();
  let snapshot: TrustConfig | null = null;
  const listeners = new Set<(c: { decision?: DecisionRow }) => void>();

  const changed = (c: { decision?: DecisionRow } = {}) => {
    snapshot = null;
    for (const l of listeners) l(c);
  };
  const applyPaused = (p: boolean) => {
    paused = p;
    // Resuming starts the rate guard over.
    if (!p) {
      tripped = [];
      approvals.clear();
    }
    changed();
  };
  backend.onPaused((p) => {
    if (p !== paused) applyPaused(p);
  });

  return {
    config: () =>
      (snapshot ??= { paused, rules, modes, floorOff, tripped }),
    async setPaused(p) {
      await backend.pause(p);
      applyPaused(p);
    },
    async addRule(effect, pattern, projectId) {
      parseRule(pattern);
      const r: Rule = { id: newId(), effect, pattern: pattern.trim(), projectId, created: now() };
      await backend.ruleAdd(r);
      rules = [...rules, r];
      changed();
      return r;
    },
    async removeRule(id) {
      await backend.ruleRemove(id);
      rules = rules.filter((r) => r.id !== id);
      changed();
    },
    async setMode(projectId, mode) {
      await backend.modeSet(projectId, mode === "live" ? null : mode);
      const next = { ...modes };
      if (mode === "live") delete next[projectId];
      else next[projectId] = mode;
      modes = next;
      changed();
    },
    async setFloor(id, enabled) {
      floorOff = await backend.floorSet(id, enabled);
      changed();
    },
    approved(threadId, at) {
      const recent = (approvals.get(threadId) ?? []).filter((t) => at - t < RATE_WINDOW_MS);
      recent.push(at);
      approvals.set(threadId, recent);
      if (recent.length <= RATE_LIMIT || tripped.includes(threadId)) return false;
      tripped = [...tripped, threadId];
      changed();
      return true;
    },
    async log(d) {
      const id = await backend.decisionAdd({ ...d, id: 0 });
      const decision = { ...d, id };
      changed({ decision });
      return decision;
    },
    decisions: (before, limit) => backend.decisions(before, limit),
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
