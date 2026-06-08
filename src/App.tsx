import { useEffect } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";

// Step 0.1 scaffold: a blank themed window. No real UI yet — the rail, consoles,
// dock layout, etc. arrive in later steps. This just proves the Tauri + React +
// Vite shell boots and renders the muted-dark terminal surface.
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
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        fontFamily: "var(--wb-mono)",
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.08em", color: "var(--wb-accent)" }}>
        ▞▚ Workbench
      </div>
      <div style={{ fontSize: 12, color: "var(--wb-textDim2)" }}>
        cockpit for supervising Claude Code agents
      </div>
      <div style={{ fontSize: 10.5, color: "var(--wb-textFaint)", letterSpacing: "0.1em" }}>
        scaffold · phase 0
      </div>
    </main>
  );
}

export default App;
