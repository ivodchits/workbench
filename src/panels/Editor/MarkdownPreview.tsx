// Markdown preview pane (step 1.9). A scrollable, themed render of a markdown
// source string. Reused by both the in-Editor split toggle (index.tsx) and the
// standalone dockable Preview panel (../PreviewPanel.tsx), so the look and the
// sanitization live in one place. Pure view: the caller owns the source string and
// passes it on every change, so the preview updates live as the buffer is edited.

import { useLayoutEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "./markdown";
import { loadScroll, saveScroll } from "./markdownScroll";
import "../../theme/markdown.css";

interface MarkdownPreviewProps {
  /** The markdown source to render (typically a live editor buffer). */
  source: string;
  /**
   * Stable identity for this preview. When set, the scroll offset is remembered
   * under this key so the same section is shown after the panel is hidden and
   * re-shown (a tab switch unmounts it). Omit to opt out of persistence.
   */
  scrollKey?: string;
}

function MarkdownPreview({ source, scrollKey }: MarkdownPreviewProps) {
  // Re-parse only when the text actually changes (keystrokes re-render the parent
  // for other reasons too — cursor moves, sibling tabs).
  const html = useMemo(() => renderMarkdown(source), [source]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the saved offset after the rendered HTML lands in the DOM but before
  // paint, so a remount jumps straight to where we left off without flashing the
  // top first. Re-runs when `scrollKey` changes (e.g. the in-editor split preview
  // following a switch to another file).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollKey === undefined) return;
    el.scrollTop = loadScroll(scrollKey);
  }, [scrollKey]);

  return (
    <div
      ref={scrollRef}
      onScroll={
        scrollKey === undefined
          ? undefined
          : (e) => saveScroll(scrollKey, e.currentTarget.scrollTop)
      }
      style={{ height: "100%", overflow: "auto", background: "var(--wb-panel)", minHeight: 0 }}
    >
      <div className="wb-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export default MarkdownPreview;
