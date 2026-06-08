// Stub panels (step 1.6) — Shell and Editor are registered as dockview panel
// types now so the dock knows how to render them (and can restore them from a
// saved layout), but their real content lands in 1.7 (Project Shell) and 1.8
// (CodeMirror Editor). Until then they show a placeholder.

function StubBody({ label, step }: { label: string; step: string }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "var(--wb-bg)",
        color: "var(--wb-textDim2)",
        font: "12px var(--wb-mono)",
        textAlign: "center",
        padding: 24,
      }}
    >
      <div style={{ color: "var(--wb-text)" }}>{label}</div>
      <div style={{ color: "var(--wb-textFaint)", fontSize: 11 }}>arrives in {step}</div>
    </div>
  );
}

export function ShellPanel() {
  return <StubBody label="project shell" step="step 1.7" />;
}

export function EditorPanel() {
  return <StubBody label="editor" step="step 1.8" />;
}
