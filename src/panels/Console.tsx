// Console panel: one xterm.js terminal bound to a backend PTY. Output streams in
// over a Tauri Channel; keystrokes and resize flow back through the IPC wrappers,
// all keyed by `instanceId` (step 1.5) so many consoles coexist. The Phase-0
// spike proved the bridge renders the real interactive `claude` TUI — plan mode,
// permission prompts, slash commands, the status line.
//
// Renderer: when `webgl` is set, load the WebGL addon for GPU-accelerated drawing;
// otherwise fall back to xterm's DOM renderer. The caller enforces the ≤10 WebGL
// cap (design §5 / decision 14) — browsers cap live WebGL contexts, so excess
// consoles render via the DOM.

import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import { deriveXtermTheme, mono } from "../theme/tokens";
import {
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyChunk,
  type SpawnKind,
  type SpawnResult,
} from "../ipc/pty";

interface ConsoleProps {
  /** The instance this console is bound to — the key for every PTY command. */
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

    const term = new Terminal({
      fontFamily: mono,
      fontSize: 13,
      cursorBlink: true,
      theme: deriveXtermTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // WebGL must load *after* open (it needs the rendered canvas). If the context
    // can't be created or is later lost, dispose the addon so xterm reverts to the
    // DOM renderer rather than rendering nothing.
    if (webgl) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => addon.dispose());
        term.loadAddon(addon);
      } catch {
        // WebGL unavailable; xterm keeps its DOM renderer.
      }
    }

    // Stream PTY output → terminal. Vec<u8> arrives as a JS number array.
    const output = new Channel<PtyChunk>();
    output.onmessage = (chunk) => term.write(new Uint8Array(chunk));

    // Keystrokes → PTY.
    const dataSub = term.onData((data) => {
      void ptyWrite(instanceId, new TextEncoder().encode(data));
    });

    // Resize PTY whenever xterm's dimensions change.
    const resizeSub = term.onResize(({ cols, rows }) => {
      void ptyResize(instanceId, cols, rows);
    });

    // Initial fit, then spawn at the fitted size. Defer one frame so the
    // container has been laid out and `fit()` can measure it.
    let disposed = false;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // container not measurable yet; ignore
      }
    });
    requestAnimationFrame(() => {
      if (disposed) return;
      fit.fit();
      ptySpawn(instanceId, output, kind, cwd, term.cols, term.rows)
        .then((result) => {
          if (!disposed) onSpawned?.(result);
        })
        .catch((e: unknown) => {
          if (!disposed) onError?.(e instanceof Error ? e.message : String(e));
        });
      ro.observe(container);
      term.focus();
    });

    return () => {
      disposed = true;
      ro.disconnect();
      resizeSub.dispose();
      dataSub.dispose();
      void ptyKill(instanceId);
      term.dispose();
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
