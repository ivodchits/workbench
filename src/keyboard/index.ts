// Public surface of the keyboard layer (step 1.10): the binding registry, the
// command bus, and the global-key hook. The rail wires its own scope via
// `matchCommand(e, "rail")` + the action helpers it owns.

export * from "./keymap";
export { registerCommand, runCommand } from "./bus";
export { runAction } from "./commands";
export { useGlobalKeys } from "./useGlobalKeys";
