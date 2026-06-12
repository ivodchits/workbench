// Permission-mode quick switch (step 3.10) — flip a live `claude` console between
// **default** (ask before each tool), **accept edits**, and **plan** mode from the
// UI instead of typing it, per session (design §7 "permission-mode quick switch").
//
// Mechanism & its one honest limitation. Claude Code's TUI cycles permission modes
// on **Shift+Tab** (default → accept-edits → plan → default); there is no key to jump
// to a named mode and — per the guardrails — we must never scrape the TUI to read the
// current one. So we keep an **assumed** mode per instance and, to reach a target,
// send the right number of Shift+Tab sequences (`\x1b[Z`, the terminal "back-tab")
// to the PTY. A fresh launch *and* `claude --resume` both start in `default`, so the
// panel resets the assumption on spawn (`resetMode`) and it stays accurate — unless
// you press Shift+Tab directly in the terminal, which we can't observe; the assumption
// can then drift until you pick a mode again (which re-pins it from wherever you ask).
//
// Keeping the cycle order + escape sequence here in one place mirrors the design's
// note (§11) that TUI keystroke mappings should live in a single spot so a Claude
// Code TUI change is a one-line fix.

import { useSyncExternalStore } from "react";
import { ptyWrite } from "../ipc/pty";
import { getActiveConsoleId, getOpenConsoles } from "./consoles";

export type PermissionMode = "default" | "acceptEdits" | "plan";

/** Shift+Tab cycle order — the sequence Claude Code's TUI steps through. */
export const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan"];

/** Short labels for the segmented control / palette. */
export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default",
  acceptEdits: "accept edits",
  plan: "plan",
};

/** The terminal "back-tab" sequence = one Shift+Tab press. */
const SHIFT_TAB = new Uint8Array([0x1b, 0x5b, 0x5a]); // ESC [ Z

const modes = new Map<string, PermissionMode>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Assumed mode for `instanceId` (defaults to `default` when untracked). */
export function getMode(instanceId: string): PermissionMode {
  return modes.get(instanceId) ?? "default";
}

/** Reset the assumption to `default` — called on (re)spawn, since both a fresh
 *  launch and `claude --resume` begin in default. */
export function resetMode(instanceId: string): void {
  if (!modes.has(instanceId)) return;
  modes.delete(instanceId);
  emit();
}

function setLocal(instanceId: string, mode: PermissionMode): void {
  if (getMode(instanceId) === mode) return;
  modes.set(instanceId, mode);
  emit();
}

/** Whether `instanceId` is a live, claude console we can drive Shift+Tab into. */
function isLiveClaude(instanceId: string): boolean {
  const c = getOpenConsoles().find((s) => s.instanceId === instanceId);
  return !!c && c.status === "running" && c.kind === "claude";
}

/**
 * Switch `instanceId`'s permission mode to `target` by sending the minimal number
 * of forward Shift+Tabs from the assumed current mode. No-op when it's not a live
 * claude console, or already there. Returns whether anything was sent.
 */
export function setMode(instanceId: string, target: PermissionMode): boolean {
  if (!isLiveClaude(instanceId)) return false;
  const from = MODE_CYCLE.indexOf(getMode(instanceId));
  const to = MODE_CYCLE.indexOf(target);
  const steps = (to - from + MODE_CYCLE.length) % MODE_CYCLE.length;
  for (let i = 0; i < steps; i++) void ptyWrite(instanceId, SHIFT_TAB);
  setLocal(instanceId, target);
  return steps > 0;
}

/** Advance one step in the cycle (one Shift+Tab) — the robust "I don't trust the
 *  assumption" path: it only ever moves by what you see happen in the TUI. */
export function cycleMode(instanceId: string): boolean {
  if (!isLiveClaude(instanceId)) return false;
  const next = MODE_CYCLE[(MODE_CYCLE.indexOf(getMode(instanceId)) + 1) % MODE_CYCLE.length];
  void ptyWrite(instanceId, SHIFT_TAB);
  setLocal(instanceId, next);
  return true;
}

/** The instance whose console is focused, if it's a live claude console. */
export function activeClaudeInstance(): string | null {
  const id = getActiveConsoleId();
  return id && isLiveClaude(id) ? id : null;
}

/** Apply `target` to the focused console (palette / global-command entry point). */
export function setModeOnActive(target: PermissionMode): void {
  const id = activeClaudeInstance();
  if (id) setMode(id, target);
}

/** Cycle the focused console's mode (palette / global-command entry point). */
export function cycleModeOnActive(): void {
  const id = activeClaudeInstance();
  if (id) cycleMode(id);
}

// --- React binding ----------------------------------------------------------

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Subscribe a component to one instance's assumed permission mode. */
export function usePermissionMode(instanceId: string): PermissionMode {
  return useSyncExternalStore(subscribe, () => getMode(instanceId));
}
