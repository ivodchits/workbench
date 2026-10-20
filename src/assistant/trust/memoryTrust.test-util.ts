// duck.db's trust tables in memory, for the trust store in tests.

import type { DecisionRow, TrustStateRow } from "../../ipc/assistant";
import type { TrustBackend } from "./store";

export function memoryTrust() {
  const state: TrustStateRow = { paused: false, rules: [], modes: [], floorOff: [], seeded: false };
  const log: DecisionRow[] = [];
  const backend: TrustBackend = {
    load: async () => structuredClone(state),
    async seed(rules) {
      if (!state.seeded) state.rules.push(...rules);
      state.seeded = true;
      return structuredClone(state);
    },
    pause: async (p) => (state.paused = p),
    ruleAdd: async (r) => void state.rules.push(r),
    ruleRemove: async (id) => void (state.rules = state.rules.filter((r) => r.id !== id)),
    async modeSet(projectId, mode) {
      state.modes = state.modes.filter((m) => m.projectId !== projectId);
      if (mode) state.modes.push({ projectId, mode });
    },
    async floorSet(id, enabled) {
      state.floorOff = state.floorOff.filter((x) => x !== id);
      if (!enabled) state.floorOff.push(id);
      return [...state.floorOff];
    },
    decisionAdd: async (d) => log.push({ ...d, id: log.length + 1 }),
    decisions: async () => [...log].reverse(),
    onPaused: () => () => {},
  };
  return { backend, log };
}
