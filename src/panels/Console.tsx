// Console panel body: a mount point that parents one instance's pooled terminal
// (see `terminalPool`) into the DOM. The Terminal and its PTY live in the pool,
// not here, so dockview can unmount this on tab-switch/move (its default renderer)
// without killing the `claude` session — on remount we just re-attach the same
// terminal, preserving the live session and scrollback. The Phase-0 spike proved
// the bridge renders the real interactive TUI; this keeps it alive across layout.

import { useEffect, useRef } from "react";
import { acquire, detach, refit } from "./terminalPool";
import type { SpawnKind, SpawnResult } from "../ipc/pty";

interface ConsoleProps {
  /** The instance this console is bound to — the key for the pooled terminal. */
  instanceId: string;
  /** What to run in this console. */
  kind: SpawnKind;
  /** Working directory to launch in. */
  cwd: string;
  /** Use the GPU (WebGL) renderer; false falls back to the DOM renderer. */
  webgl: boolean;
  /** Reports the backend's spawn result (incl. minted session id) to the parent. */
  onSpawned?: (result: SpawnResult) => void;
  /** Surfaces a spawn failure to the parent. */
  onError?: (message: string) => void;
}

function Console({ instanceId, kind, cwd, webgl, onSpawned, onError }: ConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Parent the pooled terminal here (creating + spawning it on first acquire).
    acquire(container, {
      instanceId,
      kind,
      cwd,
      webgl,
      onSpawned: (r) => onSpawned?.(r),
      onError: (m) => onError?.(m),
    });

    const ro = new ResizeObserver(() => refit(instanceId));
    ro.observe(container);

    return () => {
      ro.disconnect();
      // Detach (not dispose): the PTY keeps running in the pool. Permanent
      // teardown happens via the pool's `release`, called when the console closes.
      detach(container, instanceId);
    };
  }, [instanceId, kind, cwd, webgl, onSpawned, onError]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        background: "var(--wb-bg)",
        boxSizing: "border-box",
        padding: 6,
      }}
    >
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}

export default Console;
