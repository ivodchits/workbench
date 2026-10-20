// Trust lines (step T2): the last thing Duck's trust watcher did about a session's
// permission prompt ("auto-approved `npm test`"), shown under the session's card in
// the rail so an answer nobody saw still leaves a trace. One line per session, the
// latest; the full record is the decision log. Ephemeral, like live status.

import { useSyncExternalStore } from "react";

export interface TrustLine {
  text: string;
  /** Epoch ms. */
  at: number;
  /** Duck answered on its own (allow / deny) rather than leaving it to you. */
  acted: boolean;
}

let lines: ReadonlyMap<string, TrustLine> = new Map();
const listeners = new Set<() => void>();

export function setTrustLine(instanceId: string, line: TrustLine): void {
  const next = new Map(lines);
  next.set(instanceId, line);
  lines = next;
  for (const l of listeners) l();
}

export function useTrustLine(instanceId: string): TrustLine | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => lines.get(instanceId) ?? null,
  );
}
