// Imperative opener for the prompt-queue modal (step 3.5), split out from the
// component file so `QueuePromptHost` stays a pure component export (HMR-friendly)
// while a card's quick-queue action can open the modal already targeted at its
// instance — without prop-drilling a callback through the rail tree.

let opener: ((instanceId: string | null) => void) | null = null;

/** The host registers its setter here on mount (and clears it on unmount). */
export function bindQueueDialogOpener(fn: ((instanceId: string | null) => void) | null): void {
  opener = fn;
}

/** Open the queue modal. Pass an instance id to pre-target it, or null to default
 *  to the focused console. No-op until the host has mounted. */
export function openQueueDialog(instanceId: string | null = null): void {
  opener?.(instanceId);
}
