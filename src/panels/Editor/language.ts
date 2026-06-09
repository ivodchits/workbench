// Language detection for the Editor (step 1.8). Maps a file's extension (or a few
// well-known basenames) to a CodeMirror language extension and a short label for
// the tab strip. Markdown is the priority (this app reads/writes a lot of it,
// design §1); the rest cover the "occasional small code edit" cases. Anything
// unrecognized opens as plain text — still fully editable, just unhighlighted.

import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";

export interface DetectedLanguage {
  /** The CodeMirror language extension, or null for plain text. */
  extension: Extension | null;
  /** Short label shown at the right edge of the tab strip. */
  label: string;
}

const PLAIN: DetectedLanguage = { extension: null, label: "text" };

/** Extension (lowercase, no dot) → language factory + label. */
const BY_EXT: Record<string, () => DetectedLanguage> = {
  md: () => ({ extension: markdown(), label: "markdown" }),
  markdown: () => ({ extension: markdown(), label: "markdown" }),
  mdx: () => ({ extension: markdown(), label: "markdown" }),

  js: () => ({ extension: javascript(), label: "javascript" }),
  cjs: () => ({ extension: javascript(), label: "javascript" }),
  mjs: () => ({ extension: javascript(), label: "javascript" }),
  jsx: () => ({ extension: javascript({ jsx: true }), label: "jsx" }),
  ts: () => ({ extension: javascript({ typescript: true }), label: "typescript" }),
  tsx: () => ({ extension: javascript({ typescript: true, jsx: true }), label: "tsx" }),

  json: () => ({ extension: json(), label: "json" }),
  jsonc: () => ({ extension: json(), label: "json" }),

  css: () => ({ extension: css(), label: "css" }),
  scss: () => ({ extension: css(), label: "css" }),
  html: () => ({ extension: html(), label: "html" }),
  htm: () => ({ extension: html(), label: "html" }),

  py: () => ({ extension: python(), label: "python" }),
  rs: () => ({ extension: rust(), label: "rust" }),

  yaml: () => ({ extension: yaml(), label: "yaml" }),
  yml: () => ({ extension: yaml(), label: "yaml" }),
};

/** Basenames with no useful extension that still warrant highlighting. */
const BY_NAME: Record<string, () => DetectedLanguage> = {
  dockerfile: () => PLAIN,
  ".gitignore": () => PLAIN,
};

/** Detect the language for a file name (any path tail works — only the base is used). */
export function detectLanguage(fileName: string): DetectedLanguage {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const lower = base.toLowerCase();

  const byName = BY_NAME[lower];
  if (byName) return byName();

  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return PLAIN; // no extension (or a dotfile like ".gitignore")
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext]?.() ?? PLAIN;
}
