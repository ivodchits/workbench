import { useEffect } from "react";
import { applyTheme, mutedDark } from "./theme/tokens";
import InstanceManager from "./panels/InstanceManager";
import ConsoleArea from "./panels/ConsoleArea";
import { useConsoles } from "./state/consoles";

// Step 1.5 turns the cockpit into its real shape: the Instance Manager rail on
// the left drives a center Console area, where clicking an instance launches (or
// focuses) its claude console and several run side by side. The Phase-0 manual
// launcher is gone — instances are the way you start agents now. The freely
// arrangeable dockview layout that replaces the interim console grid lands in 1.6.

function App() {
  const { open, activeId } = useConsoles();

  useEffect(() => {
    applyTheme(mutedDark);
  }, []);

  const active = open.find((c) => c.instanceId === activeId) ?? null;

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
      <TitleBar
        context={
          open.length === 0
            ? "no console"
            : `${open.length} console${open.length === 1 ? "" : "s"}`
        }
      />

      <div style={{ flex: 1, display: "flex", gap: 14, minHeight: 0, padding: "14px 14px 0" }}>
        <InstanceManager />
        <ConsoleArea />
      </div>

      <StatusBar
        openCount={open.length}
        sessionId={active?.sessionId ?? null}
      />
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
        phase 1 · console
      </span>
    </div>
  );
}

function StatusBar({ openCount, sessionId }: { openCount: number; sessionId: string | null }) {
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
      <span>
        {openCount} {openCount === 1 ? "console" : "consoles"}
      </span>
      {sessionId && (
        <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
          session {sessionId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

export default App;
