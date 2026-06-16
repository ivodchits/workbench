// Resume-picker store (step 4.x) — drives the Ctrl+Shift+R session picker.
//
// A tiny external store (like `consoles`/`diff`) holding which project's instances
// the picker should offer and which instance to preselect. The picker itself
// (`panels/ResumePicker`) reads this via `useResumePicker`; `openResumePicker`
// is called from the resume command and `closeResumePicker` when it dismisses.

import { useSyncExternalStore } from "react";

export interface ResumePickerState {
  open: boolean;
  /** The project whose instances the picker lists; null until opened. */
  projectId: string | null;
  /** The instance to preselect (the one the shortcut was invoked on), or null. */
  preselectInstanceId: string | null;
}

let state: ResumePickerState = { open: false, projectId: null, preselectInstanceId: null };
const listeners = new Set<() => void>();

function emit(next: ResumePickerState): void {
  state = next;
  for (const l of listeners) l();
}

/** Open the resume picker for `projectId`, preselecting `instanceId` if given. */
export function openResumePicker(projectId: string, instanceId: string | null): void {
  emit({ open: true, projectId, preselectInstanceId: instanceId });
}

/** Close the picker. */
export function closeResumePicker(): void {
  if (!state.open) return;
  emit({ open: false, projectId: null, preselectInstanceId: null });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ResumePickerState {
  return state;
}

/** Subscribe a component to the resume-picker store. */
export function useResumePicker(): ResumePickerState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
