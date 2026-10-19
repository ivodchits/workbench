// Notes sync store (step N3) — the backend sync's status and its notices (conflict
// copies, restored notes, links, an hour of failing), for the status-bar menu. The
// notices are the *info* items the plan names; until Duck's attention levels exist
// (assistant plan V5) they live here, with a count of the ones not yet seen.
//
// Also tells the backend when the window comes back into focus, so it can pull
// after five minutes away.

import { useSyncExternalStore } from "react";

import {
  notesSyncFocus,
  notesSyncStatus,
  onSyncNotice,
  onSyncStatus,
  type SyncNotice,
  type SyncStatus,
} from "../ipc/notes";
import { flash } from "../util/flash";

interface NotesSyncState {
  status: SyncStatus | null;
  notices: SyncNotice[];
  /** Notices that arrived since the menu was last opened. */
  unseen: number;
}

let state: NotesSyncState = { status: null, notices: [], unseen: 0 };
const listeners = new Set<() => void>();

function emit(next: NotesSyncState): void {
  state = next;
  for (const l of listeners) l();
}

let started = false;

export function initNotesSync(): void {
  if (started) return;
  started = true;
  void notesSyncStatus()
    .then(({ status, notices }) => emit({ ...state, status, notices: [...notices, ...state.notices] }))
    .catch(() => {});
  void onSyncStatus((status) => emit({ ...state, status }));
  void onSyncNotice((n) => {
    emit({ ...state, notices: [...state.notices, n].slice(-50), unseen: state.unseen + 1 });
    if (n.kind === "conflict" || n.kind === "failing") flash(n.text);
  });
  window.addEventListener("focus", () => void notesSyncFocus().catch(() => {}));
}

export function markNoticesSeen(): void {
  if (state.unseen) emit({ ...state, unseen: 0 });
}

export function useNotesSync(): NotesSyncState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
