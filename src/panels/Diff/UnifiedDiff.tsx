// Read-only unified-diff renderer for the Diff/Review panel (step 2.7). Renders
// git's unified-diff text (or the backend's synthesized all-added text for an
// untracked file) as colored monospace lines, classified by their leading char —
// `+` added, `-` removed, `@` hunk header, file-header lines dimmed. No CodeMirror
// here: a review diff is read-only, and a flat list of styled lines is cheaper and
// reads like terminal output (design §5.x). Editing happens in the panel's edit
// mode, which swaps in a real CodeMirror over the working-tree file.

import { useMemo, type CSSProperties } from "react";

/** Hard cap on rendered lines — a pathological diff shouldn't freeze the webview. */
const MAX_LINES = 4000;

type LineKind = "add" | "del" | "hunk" | "meta" | "context";

function classify(line: string): LineKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const STYLE: Record<LineKind, CSSProperties> = {
  add: { color: "var(--wb-done)", background: "color-mix(in srgb, var(--wb-done) 12%, transparent)" },
  del: { color: "var(--wb-needs)", background: "color-mix(in srgb, var(--wb-needs) 12%, transparent)" },
  hunk: { color: "var(--wb-accent)", background: "var(--wb-titlebar)" },
  meta: { color: "var(--wb-textFaint)" },
  context: { color: "var(--wb-textDim2)" },
};

function UnifiedDiff({ text }: { text: string }) {
  const { lines, truncated } = useMemo(() => {
    const all = text.replace(/\n$/, "").split("\n");
    return { lines: all.slice(0, MAX_LINES), truncated: all.length > MAX_LINES };
  }, [text]);

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: "var(--wb-bg)",
        font: "11.5px/1.5 var(--wb-mono)",
        padding: "4px 0",
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            ...STYLE[classify(line)],
            padding: "0 12px",
            whiteSpace: "pre",
            minWidth: "max-content",
          }}
        >
          {line === "" ? " " : line}
        </div>
      ))}
      {truncated && (
        <div style={{ padding: "6px 12px", color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
          … diff truncated at {MAX_LINES} lines — open the file to see the rest
        </div>
      )}
    </div>
  );
}

export default UnifiedDiff;
