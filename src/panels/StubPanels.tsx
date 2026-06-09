// Stub panels — the Editor is registered as a dockview panel type now so the
// dock knows how to render it (and can restore it from a saved layout), but its
// real content lands in 1.8 (CodeMirror Editor). Until then it shows a
// placeholder. (The Shell panel became real in 1.7 — see `Shell.tsx`.)

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

export function EditorPanel() {
  return <StubBody label="editor" step="step 1.8" />;
}
