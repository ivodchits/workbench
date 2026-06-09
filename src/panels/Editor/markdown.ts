// Markdown → safe HTML (step 1.9). `marked` parses GitHub-flavored markdown to an
// HTML string; `DOMPurify` strips anything script-y before it reaches the DOM via
// `dangerouslySetInnerHTML`. The files we render are the user's own, but a preview
// pane is a webview surface, so sanitizing is cheap insurance against a stray
// `<script>`/`onerror` in a doc copied from elsewhere.
//
// Deliberately plain: GFM (tables, fenced code, task lists) but no mermaid, no
// syntax-highlighting plugins, no export — those are out of scope for 1.9. Code
// blocks render as monospace blocks styled by `markdown.css`.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: false,
});

/** Render a markdown source string to sanitized HTML ready for the preview pane. */
export function renderMarkdown(source: string): string {
  // No async marked extensions are configured, so `parse` returns a string here;
  // `{ async: false }` selects that overload for the type checker.
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html);
}
