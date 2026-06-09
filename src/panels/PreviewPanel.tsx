// Markdown Preview panel (step 1.9) — the standalone, dockable counterpart to the
// in-Editor preview toggle. Bound to a single markdown file (an owning editor + a
// path) so it can sit side-by-side with anything: the editor that spawned it, a
// console, a shell (design §5, "Markdown Preview · bound to a file").
//
// It tracks the file's *live* buffer: it reads the owning editor's open tab from
// the editors store, so edits in the editor update this panel as you type. If that
// tab isn't open (the file was closed, or we're mid-restore before the editor has
// re-read its tabs), it falls back to the on-disk copy and notes that it's static.
//
// Unlike Console/Shell/Editor panels, this one owns no backing store entry and no
// PTY — everything it needs is in its params + the editors store — so it persists
// purely as part of the dockview tree and the reconcilers in `Workspace` ignore it
// (its params use `ownerEditorId`, not `editorId`, so the editor reconciler's probe
// returns null for it).

import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../theme";
import { readFile } from "../ipc/fs";
import { useEditors } from "../state/editors";
import MarkdownPreview from "./Editor/MarkdownPreview";

export interface PreviewPanelParams {
  /** The editor whose buffer this preview mirrors. */
  ownerEditorId: string;
  /** Absolute path of the previewed file. */
  path: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function PreviewPanel(props: IDockviewPanelProps<PreviewPanelParams>) {
  const { ownerEditorId, path } = props.params;
  const { open } = useEditors();

  const name = basename(path);
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(`preview · ${name}`), [setTitle, name]);

  // Live buffer from the owning editor, if that tab is currently open.
  const editor = open.find((e) => e.editorId === ownerEditorId) ?? null;
  const liveContent = editor?.files.find((f) => f.path === path)?.content;
  const isLive = liveContent !== undefined;

  // Disk fallback when the tab isn't open. Re-read when the path changes or when we
  // transition from live → not-live (the editor tab was closed).
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [diskError, setDiskError] = useState<string | null>(null);
  useEffect(() => {
    if (isLive) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await readFile(path);
        if (!cancelled) {
          setDiskContent(text);
          setDiskError(null);
        }
      } catch (err) {
        if (!cancelled) setDiskError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, isLive]);

  if (!isLive && diskError) {
    return (
      <div style={centered}>
        <div style={{ color: "var(--wb-needs)", font: "12px var(--wb-mono)" }}>
          {GLYPH.warn} can't read {name}
        </div>
        <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>{diskError}</div>
      </div>
    );
  }

  const source = isLive ? liveContent : (diskContent ?? "");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {!isLive && (
        <div
          style={{
            flex: "0 0 auto",
            padding: "4px 12px",
            borderBottom: "1px solid var(--wb-border)",
            background: "var(--wb-titlebar)",
            color: "var(--wb-textFaint)",
            font: "10px var(--wb-mono)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title="this file isn't open in its editor — showing the saved copy on disk"
        >
          ○ saved copy · open {name} in the editor for a live preview
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <MarkdownPreview source={source} />
      </div>
    </div>
  );
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  padding: 24,
  background: "var(--wb-panel)",
};

export default PreviewPanel;
