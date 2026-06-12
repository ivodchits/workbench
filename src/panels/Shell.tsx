// Shell panel (step 1.7) — a Project Shell: a `portable-pty` child running the
// user's shell (`pwsh.exe` / `$SHELL`) in a project's root dir, for git, tests,
// and running the app (design §5 Project Shell, §4.2). It reuses the same PTY
// bridge + terminal pool as the Claude console; the only backend difference is
// `SpawnKind::Shell` (no minted session id).
//
// Structure mirrors `ConsolePanel`: a header (project · cwd · spawn state), a
// status-gated body (the pooled terminal when live, a dormant placeholder when
// restored from a saved layout, an error notice on failure), and a footer with
// git quick-buttons. The terminal lives in `terminalPool` keyed by `shellId`, so
// it survives tab-switch / panel moves like a console.
//
// Pre-seed: once the shell is running we type `git status -sb` into it after a
// short delay — early enough to feel instant, late enough that PSReadLine has
// taken over stdin (type-ahead into a just-launched pwsh is dropped).

import { useCallback, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH, Spinner } from "../theme";
import Console from "./Console";
import { focusTerminal } from "./terminalPool";
import { ptyWrite } from "../ipc/pty";
import {
  markShellError,
  markShellSpawned,
  relaunchShell,
  useShells,
  type ShellSession,
} from "../state/shells";

export interface ShellPanelParams {
  shellId: string;
}

/** Delay before the pre-seeded `git status` so PSReadLine has claimed stdin. */
const PRESEED_DELAY_MS = 600;

function ShellPanel(props: IDockviewPanelProps<ShellPanelParams>) {
  const { shellId } = props.params;
  const { open } = useShells();

  const session = open.find((s) => s.shellId === shellId) ?? null;

  // Keep the tab label in sync with the shell label.
  const title = session ? `shell · ${session.label}` : "shell";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) return <MissingShell />;

  const live = session.status === "spawning" || session.status === "running";
  const running = session.status === "running";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <HeaderStrip session={session} />
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {live ? (
          <LiveShell shellId={shellId} cwd={session.cwd} />
        ) : session.status === "error" ? (
          <ErrorBody message={session.error} />
        ) : (
          <Dormant session={session} />
        )}
      </div>
      <GitButtons shellId={shellId} enabled={running} />
    </div>
  );
}

function LiveShell({ shellId, cwd }: { shellId: string; cwd: string }) {
  // Pre-seed `git status -sb` once the spawn resolves; respawns (retarget) fire
  // `onSpawned` again, so the new dir gets a fresh status without extra tracking.
  const onSpawned = useCallback(() => {
    markShellSpawned(shellId);
    setTimeout(() => {
      void ptyWrite(shellId, encode("git status -sb\r"));
      focusTerminal(shellId);
    }, PRESEED_DELAY_MS);
  }, [shellId]);
  const onError = useCallback((message: string) => markShellError(shellId, message), [shellId]);
  // Shells render via the DOM renderer (`webgl: false`) so they don't compete for
  // the ~10 WebGL contexts the Claude consoles want (design §5 / decision 14).
  return (
    <Console
      instanceId={shellId}
      kind="shell"
      cwd={cwd}
      webgl={false}
      resumeSessionId={null}
      onSpawned={onSpawned}
      onError={onError}
    />
  );
}

/** project · cwd — the shell's context line. */
function HeaderStrip({ session }: { session: ShellSession }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 13px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--wb-text)", fontWeight: 600, flex: "0 0 auto" }}>
        {session.label || "shell"}
      </span>
      <span
        title={session.cwd}
        style={{ color: "var(--wb-textFaint)", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
      >
        {session.cwd || "—"}
      </span>
      {session.status === "spawning" && (
        <span style={{ marginLeft: "auto", color: "var(--wb-working)", flex: "0 0 auto" }}>
          <Spinner size={10} /> spawning
        </span>
      )}
    </div>
  );
}

/** status / diff / commit — convenience git ops typed into the live shell. The
 *  first two run immediately; `commit` is typed without a newline so you can add
 *  a message (or hit Enter to open your editor). */
function GitButtons({ shellId, enabled }: { shellId: string; enabled: boolean }) {
  const send = (text: string) => {
    void ptyWrite(shellId, encode(text));
    focusTerminal(shellId);
  };
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "10px var(--wb-mono)",
      }}
    >
      <span style={{ color: "var(--wb-textFaint)" }}>git</span>
      <GitButton enabled={enabled} onClick={() => send("git status -sb\r")}>
        status
      </GitButton>
      <GitButton enabled={enabled} onClick={() => send("git diff\r")}>
        diff
      </GitButton>
      <GitButton enabled={enabled} onClick={() => send("git commit ")}>
        commit
      </GitButton>
    </div>
  );
}

function GitButton({
  children,
  onClick,
  enabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  enabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      style={{
        background: "transparent",
        border: "1px solid var(--wb-border)",
        color: enabled ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
        font: "10px var(--wb-mono)",
        padding: "2px 9px",
        cursor: enabled ? "pointer" : "default",
      }}
    >
      {children}
    </button>
  );
}

/** A shell restored from a saved layout whose PTY isn't running. */
function Dormant({ session }: { session: ShellSession }) {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-textDim2)", font: "12.5px var(--wb-mono)" }}>
        <span style={{ color: "var(--wb-closed)" }}>○</span> shell — not running
      </div>
      <div
        style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}
        title={session.cwd}
      >
        {session.label || session.cwd || "restored from your saved layout"}
      </div>
      <button onClick={() => relaunchShell(session.shellId)} style={relaunchButton}>
        <span style={{ color: "var(--wb-accent)" }}>{GLYPH.run}</span> relaunch
      </button>
    </div>
  );
}

function ErrorBody({ message }: { message: string | null }) {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-needs)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} could not launch shell
      </div>
      <div style={{ color: "var(--wb-textDim2)", font: "11px var(--wb-mono)", maxWidth: 460, textAlign: "center" }}>
        {message ?? "unknown error"}
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
        close this panel and open a shell again to retry
      </div>
    </div>
  );
}

function MissingShell() {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} this shell is gone
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close this panel</div>
    </div>
  );
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const centeredBody: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: 24,
  background: "var(--wb-bg)",
};

const relaunchButton: React.CSSProperties = {
  marginTop: 4,
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 14px",
  font: "11.5px var(--wb-mono)",
  cursor: "pointer",
};

export default ShellPanel;
