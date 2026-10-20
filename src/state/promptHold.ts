// Prompt hold (step T2): a permission prompt Duck may answer on its own shouldn't
// notify anyone first. Whoever delivers a fresh needs-you (the desktop toast and
// phone push in `notifications.ts`, Duck's own session watches) asks here first;
// the trust watcher registers the one hold, which resolves once it has decided:
// `true` — tell the user as usual; `false` — it answered the prompt (or refused
// it), so there is nothing to tell. With no hold registered, everything is told at
// once.
//
// A hold that hangs is cut off after `MAX_HOLD_MS`: a late notification beats a
// lost one.

/** The longest a needs-you waits on the hold (two judge calls fit well inside). */
export const MAX_HOLD_MS = 45_000;

type Hold = (instanceId: string) => Promise<boolean>;

let hold: Hold | null = null;

/** Register the hold (the trust watcher); returns the unregister. */
export function setPromptHold(fn: Hold): () => void {
  hold = fn;
  return () => {
    if (hold === fn) hold = null;
  };
}

/** Whether a fresh needs-you of `instanceId` should be told. */
export function shouldTell(instanceId: string): Promise<boolean> {
  if (!hold) return Promise.resolve(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), MAX_HOLD_MS);
  });
  return Promise.race([hold(instanceId).catch(() => true), cut]).finally(() => clearTimeout(timer));
}
