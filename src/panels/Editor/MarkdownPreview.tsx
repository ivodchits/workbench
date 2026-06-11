// Markdown preview pane (step 1.9). A scrollable, themed render of a markdown
// source string. Reused by both the in-Editor split toggle (index.tsx) and the
// standalone dockable Preview panel (../PreviewPanel.tsx), so the look and the
// sanitization live in one place. Pure view: the caller owns the source string and
// passes it on every change, so the preview updates live as the buffer is edited.

import { useEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "./markdown";
import { persistScroll } from "./scrollMemory";
import "../../theme/markdown.css";

interface MarkdownPreviewProps {
  /** The markdown source to render (typically a live editor buffer). */
  source: string;
  /**
   * Stable identity for this preview. When set, the scroll offset is remembered
   * under this key so the same section is shown after the panel is hidden and
   * re-shown (a tab switch detaches its DOM). Omit to opt out of persistence.
   */
  scrollKey?: string;
}

function MarkdownPreview({ source, scrollKey }: MarkdownPreviewProps) {
  // Re-parse only when the text actually changes (keystrokes re-render the parent
  // for other reasons too — cursor moves, sibling tabs).
  const html = useMemo(() => renderMarkdown(source), [source]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Remember the scroll offset across tab switches (dockview detaches/re-attaches
  // the panel DOM, resetting scrollTop with no event or lifecycle — see
  // `persistScroll`). Re-wires when the key changes (e.g. the split preview
  // following a switch to another file).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollKey === undefined) return;
    return persistScroll(el, scrollKey);
  }, [scrollKey]);

  return (
    <div
      ref={scrollRef}
      style={{ height: "100%", overflow: "auto", background: "var(--wb-panel)", minHeight: 0 }}
    >
      <div className="wb-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export default MarkdownPreview;
