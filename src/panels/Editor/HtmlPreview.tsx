// Live HTML preview pane (step 1.9, HTML kind). Renders an HTML buffer in a
// sandboxed `<iframe srcDoc>` so the page paints with its own styles and runs its
// own inline scripts in an isolated document, rather than leaking into (or
// inheriting from) the app's DOM the way `dangerouslySetInnerHTML` would. The
// app's `tauri.conf.json` sets `csp: null`, so inline `<style>`/`<script>` and
// absolute `https://` resources load without a CSP fight.
//
// `sandbox="allow-scripts"` lets the page's JS run, but the absence of
// `allow-same-origin` keeps it on an opaque origin — it can't reach the app's
// storage or parent window.
//
// Unlike the markdown pane (a cheap, stateless re-parse per keystroke), reloading
// `srcDoc` re-executes the whole document — so we debounce the buffer→iframe feed:
// per-keystroke reloads would flicker, reset timers, and lose scroll. The result
// is "near-live" rather than instant, which is the right trade for executable HTML.
//
// Known limitation: relative resources (`./style.css`, `<img src="logo.png">`)
// don't resolve under `srcDoc` (no document URL). The realistic files here are
// self-contained or use absolute URLs; a `<base>` injection could cover relative
// assets later if needed (see step 1.9 notes).

import { useEffect, useState } from "react";

interface HtmlPreviewProps {
  /** The HTML source to render (typically a live editor buffer). */
  source: string;
}

/** Debounce window for buffer edits before reloading the iframe. */
const RELOAD_DEBOUNCE_MS = 350;

function HtmlPreview({ source }: HtmlPreviewProps) {
  // Seed immediately so the first paint isn't blank, then debounce later edits.
  const [doc, setDoc] = useState(source);
  useEffect(() => {
    const t = setTimeout(() => setDoc(source), RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [source]);

  return (
    <iframe
      title="html preview"
      srcDoc={doc}
      sandbox="allow-scripts"
      style={{ height: "100%", width: "100%", border: "none", background: "#ffffff" }}
    />
  );
}

export default HtmlPreview;
