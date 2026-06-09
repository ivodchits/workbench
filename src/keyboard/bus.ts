// Command bus (step 1.10) — the indirection between "a key was pressed" and "the
// component that owns the action runs it". `useGlobalKeys` translates a key event
// into a `CommandId` (via the keymap) and calls `runCommand`; feature components
// register a handler for the commands they own (e.g. the Instance Manager owns
// `newInstance` / `killInstance`, App owns `focusRail`). Pure-dock commands skip
// the bus and call `state/dock` directly, since no component owns them.
//
// One handler per command — the owning component registers in an effect and the
// returned disposer clears it on unmount, so the most recent mount wins. Calling a
// command with no handler is a harmless no-op (that's how `jumpNeedsYou` stays a
// "registered" stub until Phase 2 wires it).

import type { CommandId } from "./keymap";

type Handler = (arg?: number) => void;

const handlers = new Map<CommandId, Handler>();

/** Register the handler for `id`; returns a disposer that removes exactly it. */
export function registerCommand(id: CommandId, handler: Handler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

/** Run the handler bound to `id`, if any (no-op when unregistered). */
export function runCommand(id: CommandId, arg?: number): void {
  handlers.get(id)?.(arg);
}
