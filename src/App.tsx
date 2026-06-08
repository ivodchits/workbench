import { useCallback, useEffect, useState } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import Console from "./panels/Console";
import { defaultWorkingDir, type SpawnKind, type SpawnResult } from "./ipc/pty";

// Step 0.3: prove the PTY↔webview bridge carries the real interactive `claude`
// TUI. A tiny launcher (kind + working dir) spawns `claude --session-id <uuid>`
// — the UUID is minted in Rust and shown in the header so PTY↔session
// correlation is visible. No registry, no cards yet (that's 1.5); this just
// proves fidelity: plan mode, permission prompts, slash commands, status line.

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
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        fontFamily: "var(--wb-mono)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          background: "var(--wb-titlebar)",
          borderBottom: "1px solid var(--wb-border)",
          fontSize: 11.5,
          letterSpacing: "0.05em",
        }}
      >
        <span style={{ color: "var(--wb-accent)", fontWeight: 700 }}>▞▚ Workbench</span>
        <span style={{ color: "var(--wb-textFaint)" }}>╶</span>
        <span style={{ color: "var(--wb-textDim2)" }}>
          {running ? `${running.kind} · ${running.cwd}` : "launcher"}
        </span>
        {sessionId && (
          <span style={{ color: "var(--wb-textFaint)" }}>
            · session {sessionId.slice(0, 8)}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>spike · phase 0</span>
      </div>

      {running ? (
        <>
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "4px 10px",
              borderBottom: "1px solid var(--wb-border)",
              fontSize: 11.5,
            }}
          >
            <button onClick={stop} style={buttonStyle}>
              ✗ stop
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
        </>
      ) : (
        <Launcher
          cwd={cwd}
          kind={kind}
          error={error}
          onCwd={setCwd}
          onKind={setKind}
          onLaunch={launch}
        />
      )}
    </main>
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
    <div
      style={{
        flex: "1 1 auto",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 24,
        maxWidth: 640,
      }}
    >
      <div style={{ color: "var(--wb-textDim2)", fontSize: 13 }}>
        Launch a PTY to de-risk the bridge.
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
            <input
              type="radio"
              name="kind"
              checked={kind === k}
              onChange={() => onKind(k)}
            />
            <span>{k}</span>
          </label>
        ))}
      </div>

      <div>
        <button onClick={onLaunch} style={{ ...buttonStyle, padding: "6px 14px" }}>
          ▸ launch
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
