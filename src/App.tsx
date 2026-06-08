import { useEffect } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import Console from "./panels/Console";

// Step 0.2: the PTY bridge spike. The window hosts a single Console panel wired
// to the backend shell PTY — proving output streaming, keystroke input, and
// resize reflow before any real UI is built. A thin terminal-style title bar
// frames it so the chrome reads as one surface with the embedded terminal.
function App() {
  useEffect(() => {
    applyTheme(mutedDark);
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
        <span style={{ color: "var(--wb-textDim2)" }}>console · shell</span>
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>spike · phase 0</span>
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        <Console />
      </div>
    </main>
  );
}

export default App;
