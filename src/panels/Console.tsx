// Console panel (steps 0.2–0.3): a single xterm.js terminal bound to a backend
// PTY. Output streams in over a Tauri Channel; keystrokes and resize flow back
// through the IPC wrappers. Step 0.3 points it at the real interactive `claude`
// TUI (a minted `--session-id`) in a chosen working dir, proving the bridge
// renders plan mode, permission prompts, slash commands, and the status line
// before any real UI (rail, dock, registry) is built on top of it.

import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { mono, mutedDark } from "../theme/tokens";
import {
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyChunk,
  type SpawnKind,
  type SpawnResult,
} from "../ipc/pty";

/** Derive an xterm theme from the app theme tokens so the console matches the chrome. */
function xtermTheme(): ITheme {
  return {
    background: mutedDark.bg,
    foreground: mutedDark.text,
    cursor: mutedDark.accent,
    cursorAccent: mutedDark.bg,
    selectionBackground: mutedDark.sel,
    black: "#1b1e2b",
    red: mutedDark.needs,
    green: mutedDark.done,
    yellow: mutedDark.working,
    blue: "#6f8bff",
    magenta: mutedDark.accent,
    cyan: "#5bc8d6",
    white: mutedDark.text,
    brightBlack: mutedDark.textFaint,
    brightRed: mutedDark.needs,
    brightGreen: mutedDark.done,
    brightYellow: mutedDark.working,
    brightBlue: "#8ba3ff",
    brightMagenta: mutedDark.accent,
    brightCyan: "#7fdbe6",
    brightWhite: "#ffffff",
  };
}

interface ConsoleProps {
  /** What to run in this console. */
  kind: SpawnKind;
  /** Working directory to launch in. */
  cwd: string;
  /** Reports the backend's spawn result (incl. minted session id) to the parent. */
  onSpawned?: (result: SpawnResult) => void;
  /** Surfaces a spawn failure to the parent. */
  onError?: (message: string) => void;
}

function Console({ kind, cwd, onSpawned, onError }: ConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: mono,
      fontSize: 13,
      cursorBlink: true,
      theme: xtermTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Stream PTY output → terminal. Vec<u8> arrives as a JS number array.
    const output = new Channel<PtyChunk>();
    output.onmessage = (chunk) => term.write(new Uint8Array(chunk));

    // Keystrokes → PTY.
    const dataSub = term.onData((data) => {
      void ptyWrite(new TextEncoder().encode(data));
    });

    // Resize PTY whenever xterm's dimensions change.
    const resizeSub = term.onResize(({ cols, rows }) => {
      void ptyResize(cols, rows);
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
      ptySpawn(output, kind, cwd, term.cols, term.rows)
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
      void ptyKill();
      term.dispose();
    };
  }, [kind, cwd, onSpawned, onError]);

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
