// Which sessions run headless (step D4): Duck's workers, launched as `claude -p`
// over stream-json instead of a TUI in a PTY. The console store reads this when it
// opens a console; `state/headless.ts` runs the process. A session taken over in a
// terminal drops out.

const flagged = new Set<string>();

export function markHeadless(instanceId: string, on: boolean): void {
  if (on) flagged.add(instanceId);
  else flagged.delete(instanceId);
}

export function isHeadless(instanceId: string): boolean {
  return flagged.has(instanceId);
}
