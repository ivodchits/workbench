// Interactive one-shot remote command terminal (step 3.12). Hosts a small `xterm`
// running `ssh -tt <dest> -- <command>` via `remoteCmdSpawn`, so the user can type
// their SSH password (Windows OpenSSH can't multiplex the connection, so background
// ssh can't reuse the console's auth — it has to prompt). When the command exits the
// backend emits `remote-cmd-done`; we hand the captured output to `onDone`.
//
// Self-contained (its own xterm, not the console pool): it's transient modal UI, not
// a persisted console panel.

import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { deriveXtermTheme, mono } from "../../theme/tokens";
import {
  ptyKill,
  ptyResize,
  ptyWrite,
  remoteCmdSpawn,
  type PtyChunk,
  type RemoteCmdDone,
} from "../../ipc/pty";

interface RemoteCommandTerminalProps {
  /** SSH destination (alias or user@host). */
  dest: string;
  /** Remote command, pre-quoted for the remote shell (e.g. `bash -lc 'tmux ls'`). */
  command: string;
  /** Called once when the command exits, with everything it printed. */
  onDone: (output: string) => void;
  height?: number;
}

function RemoteCommandTerminal({ dest, command, onDone, height = 200 }: RemoteCommandTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest onDone without re-running the spawn effect.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const id = `remote-cmd:${crypto.randomUUID()}`;
    let disposed = false;

    const term = new Terminal({
      fontFamily: mono,
      fontSize: 12,
      cursorBlink: true,
      theme: deriveXtermTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const output = new Channel<PtyChunk>();
    output.onmessage = (chunk) => term.write(new Uint8Array(chunk));
    const dataSub = term.onData((d) => void ptyWrite(id, new TextEncoder().encode(d)));
    const resizeSub = term.onResize(({ cols, rows }) => void ptyResize(id, cols, rows));

    const unlistenP = listen<RemoteCmdDone>("remote-cmd-done", (e) => {
      if (disposed || e.payload.id !== id) return;
      onDoneRef.current(e.payload.output);
    });

    requestAnimationFrame(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // not measurable yet; spawn at whatever size xterm reports
      }
      void remoteCmdSpawn(id, dest, command, output, term.cols, term.rows).catch((e) => {
        // Surface the failure in the terminal rather than hanging silently — e.g. a
        // stale backend missing this command, or ssh not on PATH. \x1b[31m = red.
        term.write(`\r\n\x1b[31m[could not start ssh: ${String(e)}]\x1b[0m\r\n`);
      });
      term.focus();
    });

    return () => {
      disposed = true;
      void unlistenP.then((un) => un());
      dataSub.dispose();
      resizeSub.dispose();
      void ptyKill(id); // kills the local ssh child if still running
      term.dispose();
    };
    // dest/command are fixed for this terminal's life; the parent remounts (via key)
    // to run a different command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        height,
        width: "100%",
        background: "var(--wb-bg)",
        border: "1px solid var(--wb-border)",
        padding: 6,
        boxSizing: "border-box",
      }}
    >
      <div ref={hostRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}

export default RemoteCommandTerminal;
