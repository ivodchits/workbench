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
  // True while we're re-applying the saved offset on mount; suppresses the scroll
  // handler so a transient clamped scroll event (fired while the element still has
  // no layout) can't overwrite the saved offset with 0.
  const restoringRef = useRef(false);

  // Restore the saved offset after the rendered HTML lands in the DOM but before
  // paint, so a remount jumps straight to where we left off without flashing the
  // top first. Re-runs when `scrollKey` changes (e.g. the in-editor split preview
  // following a switch to another file).
  //
  // Dockview unmounts hidden panels (onlyWhenVisible) and remounts them when you
  // tab back; at that point the scroll container can still be zero-height (it gets
  // sized a frame later), and setting scrollTop on a zero-height element is a
  // no-op — which left the preview pinned to the top. So if the element has no
  // layout yet, wait for a ResizeObserver to report its real size, then apply.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollKey === undefined) return;
    const target = loadScroll(scrollKey);
    if (target === 0) return;

    restoringRef.current = true;
    const apply = (): boolean => {
      if (!el.clientHeight) return false; // no layout yet — try again on resize
      el.scrollTop = target;
      restoringRef.current = false;
      return true;
    };
    if (apply()) return;

    const ro = new ResizeObserver(() => {
      if (apply()) ro.disconnect();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      restoringRef.current = false;
    };
  }, [scrollKey]);

  return (
    <div
      ref={scrollRef}
      onScroll={
        scrollKey === undefined
          ? undefined
          : (e) => {
              if (restoringRef.current) return;
              saveScroll(scrollKey, e.currentTarget.scrollTop);
            }
      }
      style={{ height: "100%", overflow: "auto", background: "var(--wb-panel)", minHeight: 0 }}
    >
      <div className="wb-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export default MarkdownPreview;
