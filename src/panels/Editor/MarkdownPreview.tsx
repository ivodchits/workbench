// Markdown preview pane (step 1.9). A scrollable, themed render of a markdown
// source string. Reused by both the in-Editor split toggle (index.tsx) and the
// standalone dockable Preview panel (../PreviewPanel.tsx), so the look and the
// sanitization live in one place. Pure view: the caller owns the source string and
// passes it on every change, so the preview updates live as the buffer is edited.

import { useMemo } from "react";

import { renderMarkdown } from "./markdown";
import "../../theme/markdown.css";

interface MarkdownPreviewProps {
  /** The markdown source to render (typically a live editor buffer). */
  source: string;
}

function MarkdownPreview({ source }: MarkdownPreviewProps) {
  // Re-parse only when the text actually changes (keystrokes re-render the parent
  // for other reasons too — cursor moves, sibling tabs).
  const html = useMemo(() => renderMarkdown(source), [source]);

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--wb-panel)", minHeight: 0 }}>
      <div className="wb-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export default MarkdownPreview;
