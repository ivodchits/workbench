import { useCallback, useEffect, useState } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import { GLYPH, Spinner } from "./theme";
import Panel from "./theme/Panel";
import Console from "./panels/Console";
import { defaultWorkingDir, type SpawnKind, type SpawnResult } from "./ipc/pty";

// Step 1.1: the retro chrome wrapping the Phase-0 PTY spike. The title bar,
// box-drawing `Panel`, status glyphs, and status bar all read from the same
// theme tokens that derive the xterm.js theme, so the chrome and the embedded
// terminal are one continuous surface. The launcher/console logic is unchanged
// from 0.3 — the real cockpit (rail, dock, registry) arrives in later steps.

interface Running {
  kind: SpawnKind;
  cwd: string;
}

function App() {
  const [cwd, setCwd] = useState("");
  const [kind, setKind] = useState<SpawnKind>("claude");
  const [running, setRunning] = useState<Running | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(mutedDark);
    void defaultWorkingDir().then((dir) => {
      if (dir) setCwd((prev) => prev || dir);
    });
  }, []);

  const launch = useCallback(() => {
    if (!cwd.trim()) {
      setError("Enter a working directory.");
      return;
    }
    setError(null);
    setSessionId(null);
    setRunning({ kind, cwd: cwd.trim() });
  }, [cwd, kind]);

  const stop = useCallback(() => {
    setRunning(null);
    setSessionId(null);
  }, []);

  const onSpawned = useCallback((result: SpawnResult) => {
    setSessionId(result.sessionId);
  }, []);

  const onError = useCallback((message: string) => {
    setError(message);
    setRunning(null);
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        font: "12.5px var(--wb-mono)",
        overflow: "hidden",
      }}
    >
      <TitleBar context={running ? `${running.kind} · ${running.cwd}` : "launcher"} />

      <div style={{ flex: 1, display: "flex", minHeight: 0, padding: "14px 14px 0" }}>
        {running ? (
          <Panel
            title={`console · ${running.kind}`}
            accent
            right={
              sessionId ? (
                <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textDim2)" }}>
                  session {sessionId.slice(0, 8)}
                </span>
              ) : (
                <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-working)" }}>
                  <Spinner size={10} /> spawning
                </span>
              )
            }
            style={{ flex: 1 }}
            bodyStyle={{ padding: 0, paddingTop: 9 }}
          >
            <div
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px",
                borderBottom: "1px solid var(--wb-border)",
                font: "11px var(--wb-mono)",
              }}
            >
              <button onClick={stop} style={buttonStyle}>
                {GLYPH.fail} stop
              </button>
              <span style={{ color: "var(--wb-textDim2)" }}>
                {running.kind === "claude"
                  ? "interactive claude — try plan mode, a slash command, approve a permission prompt"
                  : "shell"}
              </span>
            </div>
            <div style={{ flex: "1 1 auto", minHeight: 0 }}>
              <Console
                key={`${running.kind}:${running.cwd}`}
                kind={running.kind}
                cwd={running.cwd}
                onSpawned={onSpawned}
                onError={onError}
              />
            </div>
          </Panel>
        ) : (
          <Panel title="launcher" style={{ flex: 1 }} bodyStyle={{ padding: "20px 22px" }}>
            <Launcher
              cwd={cwd}
              kind={kind}
              error={error}
              onCwd={setCwd}
              onKind={setKind}
              onLaunch={launch}
            />
          </Panel>
        )}
      </div>

      <StatusBar sessionId={sessionId} />
    </div>
  );
}

function TitleBar({ context }: { context: string }) {
  return (
    <div
      style={{
        height: 36,
        flex: "0 0 36px",
        background: "var(--wb-titlebar)",
        borderBottom: "1px solid var(--wb-border)",
        display: "flex",
        alignItems: "center",
        font: "12px var(--wb-mono)",
        color: "var(--wb-text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 14px" }}>
        <span
          style={{ color: "var(--wb-accent)", fontWeight: 700, fontSize: 14, letterSpacing: "-0.5px" }}
        >
          ▞▚
        </span>
        <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>Workbench</span>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span style={{ color: "var(--wb-textFaint)", fontSize: 11 }}>╶</span>
        <span style={{ color: "var(--wb-textDim2)", fontSize: 11.5 }}>{context}</span>
      </div>
      <span style={{ color: "var(--wb-textFaint)", fontSize: 11, padding: "0 14px" }}>
        phase 1 · theme
      </span>
    </div>
  );
}

function StatusBar({ sessionId }: { sessionId: string | null }) {
  const hints: [string, string][] = [
    ["↵", "launch"],
    ["✗", "stop"],
  ];
  return (
    <div
      style={{
        height: 28,
        flex: "0 0 28px",
        background: "var(--wb-titlebar)",
        borderTop: "1px solid var(--wb-border)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 14px",
        font: "10.5px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-accent)" }}>muted dark</span>
      <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
        {hints.map(([k, v]) => (
          <span key={k}>
            <span style={{ color: "var(--wb-accent)" }}>{k}</span> {v}
          </span>
        ))}
      </div>
      {sessionId && (
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
          session {sessionId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

interface LauncherProps {
  cwd: string;
  kind: SpawnKind;
  error: string | null;
  onCwd: (v: string) => void;
  onKind: (k: SpawnKind) => void;
  onLaunch: () => void;
}

function Launcher({ cwd, kind, error, onCwd, onKind, onLaunch }: LauncherProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
      <div style={{ color: "var(--wb-textDim2)", fontSize: 13 }}>
        Launch a PTY to exercise the themed console.
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
        <span style={{ color: "var(--wb-textDim2)" }}>working directory</span>
        <input
          value={cwd}
          onChange={(e) => onCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onLaunch();
          }}
          placeholder="C:\\path\\to\\a\\repo"
          spellCheck={false}
          style={{
            background: "var(--wb-bg)",
            color: "var(--wb-text)",
            border: "1px solid var(--wb-border)",
            padding: "6px 8px",
            fontFamily: "var(--wb-mono)",
            fontSize: 12.5,
          }}
        />
      </label>

      <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
        {(["claude", "shell"] as const).map((k) => (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" name="kind" checked={kind === k} onChange={() => onKind(k)} />
            <span>{k}</span>
          </label>
        ))}
      </div>

      <div>
        <button onClick={onLaunch} style={{ ...buttonStyle, padding: "6px 14px" }}>
          {GLYPH.run} launch
        </button>
      </div>

      {error && <div style={{ color: "var(--wb-needs)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "3px 10px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default App;
