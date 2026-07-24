// Read-only unified-diff renderer for the Diff/Review panel (step 2.7). Renders
// git's unified-diff text (or the backend's synthesized all-added text for an
// untracked file) as colored monospace lines, classified by their leading char —
// `+` added, `-` removed, `@` hunk header, file-header lines dimmed. No CodeMirror
// here: a review diff is read-only, and a flat list of styled lines is cheaper and
// reads like terminal output (design §5.x). Editing happens in the panel's edit
// mode, which swaps in a real CodeMirror over the working-tree file.

// G5 added the optional hunk layer: pass `hunks` and every `@@` line becomes a
// selectable header with its own actions (stage / unstage / discard this hunk).
// Additive by design — the Diff/Review panel passes nothing and renders exactly
// what it always did.

import { useMemo, type CSSProperties } from "react";

import { parseDiff, hunkStat } from "./patch";

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

/** One inline action on a hunk header. */
export interface HunkAction {
  key: string;
  glyph: string;
  /** Hover text — also what the glyph means, so it's never a mystery symbol. */
  label: string;
  danger?: boolean;
  onRun: (index: number) => void;
}

/**
 * The optional hunk layer (G5). With it, `@@` lines render as a header row: a
 * checkbox that adds the hunk to `selected` (the caller turns that into a patch),
 * a `+n −m` count, and the inline actions.
 */
export interface HunkControls {
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  actions: HunkAction[];
  /** Grey the controls out while a git command is in flight. */
  busy?: boolean;
}

function UnifiedDiff({ text, hunks }: { text: string; hunks?: HunkControls }) {
  const { lines, truncated } = useMemo(() => {
    const all = text.replace(/\n$/, "").split("\n");
    return { lines: all.slice(0, MAX_LINES), truncated: all.length > MAX_LINES };
  }, [text]);

  // Line number → the hunk it starts, for the rows that are hunk headers. Built
  // from the same parser the patch builder uses, so the index the UI selects is
  // the index the patch is cut by.
  const hunkAt = useMemo(() => {
    if (!hunks) return null;
    const map = new Map<number, number>();
    for (const h of parseDiff(text).hunks) map.set(h.at, h.index);
    return map;
  }, [text, hunks]);

  const stats = useMemo(() => (hunks ? parseDiff(text).hunks.map(hunkStat) : null), [text, hunks]);

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
      {lines.map((line, i) => {
        const hunkIndex = hunkAt?.get(i);
        if (hunks && hunkIndex !== undefined) {
          return (
            <HunkHeader
              key={i}
              line={line}
              index={hunkIndex}
              stat={stats?.[hunkIndex] ?? { added: 0, removed: 0 }}
              controls={hunks}
            />
          );
        }
        return (
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
        );
      })}
      {truncated && (
        <div style={{ padding: "6px 12px", color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
          … diff truncated at {MAX_LINES} lines — open the file to see the rest
        </div>
      )}
    </div>
  );
}

/** A `@@` line with its selection checkbox and per-hunk actions (G5). Sticky, so
 *  the actions for the hunk you're reading stay reachable in a long file. */
function HunkHeader({
  line,
  index,
  stat,
  controls,
}: {
  line: string;
  index: number;
  stat: { added: number; removed: number };
  controls: HunkControls;
}) {
  const picked = controls.selected.has(index);
  return (
    <div
      style={{
        ...STYLE.hunk,
        position: "sticky",
        top: 0,
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "1px 12px",
        borderTop: "1px solid var(--wb-border)",
        borderLeft: `2px solid ${picked ? "var(--wb-selBar)" : "transparent"}`,
      }}
    >
      <button
        onClick={() => controls.onToggle(index)}
        role="checkbox"
        aria-checked={picked}
        aria-label={`hunk ${index + 1}`}
        title="pick this hunk — the bar above acts on everything picked"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          font: "11px var(--wb-mono)",
          color: picked ? "var(--wb-accent)" : "var(--wb-textDim2)",
        }}
      >
        {picked ? "▣" : "▢"}
      </button>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {line}
      </span>
      <span style={{ flex: "0 0 auto", color: "var(--wb-textFaint)", font: "10px var(--wb-mono)" }}>
        +{stat.added} −{stat.removed}
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 9 }}>
        {controls.actions.map((a) => (
          <button
            key={a.key}
            onClick={() => !controls.busy && a.onRun(index)}
            disabled={controls.busy}
            title={a.label}
            aria-label={a.label}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: controls.busy ? "default" : "pointer",
              font: "11px var(--wb-mono)",
              color: controls.busy
                ? "var(--wb-textFaint)"
                : a.danger
                  ? "var(--wb-needs)"
                  : "var(--wb-accent)",
            }}
          >
            {a.glyph}
          </button>
        ))}
      </span>
    </div>
  );
}

export default UnifiedDiff;
