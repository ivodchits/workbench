// A session's launch prompt: the first prompt, handed to Claude Code on its command
// line (`claude … -- <prompt>`) when the console spawns, instead of being typed into
// a TUI that may not take input yet. The delivery path (`promptOutbox.ts`) sets it
// just before it starts the console; the terminal takes it at spawn
// (`terminalPool`), so it goes to exactly one launch.

const prompts = new Map<string, string>();

/** The longest prompt that goes on the command line; a longer one is typed. Below
 *  the backend's own cap (`INITIAL_PROMPT_MAX`, in bytes) for any UTF-8 text. */
export const LAUNCH_PROMPT_MAX = 8_000;

export function setLaunchPrompt(instanceId: string, text: string): void {
  prompts.set(instanceId, text);
}

/** The prompt for this launch, once: taken, it's gone. */
export function takeLaunchPrompt(instanceId: string): string | null {
  const p = prompts.get(instanceId) ?? null;
  prompts.delete(instanceId);
  return p;
}

/** Drop a prompt no launch took (the console never spawned). */
export function clearLaunchPrompt(instanceId: string): void {
  prompts.delete(instanceId);
}
