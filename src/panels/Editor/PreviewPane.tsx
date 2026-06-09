// Preview dispatcher (step 1.9). Picks the renderer for a previewable buffer by
// kind, so both the in-Editor split toggle (index.tsx) and the standalone Preview
// panel (../PreviewPanel.tsx) share one branch: markdown → sanitized HTML render,
// html → live sandboxed iframe.

import type { PreviewKind } from "./language";
import MarkdownPreview from "./MarkdownPreview";
import HtmlPreview from "./HtmlPreview";

interface PreviewPaneProps {
  kind: PreviewKind;
  /** The buffer to render (typically a live editor buffer). */
  source: string;
}

function PreviewPane({ kind, source }: PreviewPaneProps) {
  return kind === "html" ? <HtmlPreview source={source} /> : <MarkdownPreview source={source} />;
}

export default PreviewPane;
