// Transcript renderer (step T2): draw the model's items as plain DOM.
//
// No React here on purpose — the phone's PWA is to import this same file (R1/R4),
// so it only needs a `document`. The view around it (scrolling, the toggle, copy
// buttons, paging) is T3's; this module turns items into elements and keeps a
// container in step with a changing item list.
//
// **Everything in a transcript is untrusted.** Tool output, file contents and
// model text all end up here. Two rules cover it: text goes in through
// `textContent`, and the only HTML ever parsed is markdown that went through
// `marked` and then `DOMPurify` (with images, forms and styles removed, so a
// rendered answer can't phone home or restyle the app).

import { marked } from "marked";
import DOMPurify from "dompurify";

import "../theme/markdown.css";
import "../theme/transcript.css";

import type {
  AskedQuestion,
  CommandItem,
  DiffHunk,
  DividerItem,
  Item,
  ToolItem,
  ToolStatus,
  UserItem,
} from "./model";
import { inputStr, toolTarget, toolTitle } from "./summary";

/** Output longer than this is cut, with a "show all" button. */
const CLIP_LINES = 40;
const CLIP_CHARS = 4000;

// --- small DOM helpers ------------------------------------------------------

type Child = Node | string | null | false | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/** A button that copies `text` (read when clicked). It has no text of its own —
 *  its label is drawn by CSS — so it never ends up in a selection or in
 *  `textContent`. */
function copyButton(label: string, text: () => string): HTMLButtonElement {
  const button = el("button", "wb-tx-copy");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard?.writeText(text()).then(() => {
      button.classList.add("wb-tx-copied");
      setTimeout(() => button.classList.remove("wb-tx-copied"), 1200);
    });
  });
  return button;
}

/** Sanitized markdown, as a `.wb-md` block. */
function markdown(source: string, className = ""): HTMLElement {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }), {
    FORBID_TAGS: ["img", "picture", "source", "style", "form", "video", "audio"],
  });
  const node = el("div", `wb-md wb-tx-md ${className}`.trim());
  node.innerHTML = html;
  // A link must never navigate the app's own webview; the view decides what a
  // click does (T3 routes it to the OS opener).
  for (const a of node.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  // Each code block gets a copy button, in a wrapper so it stays put while the
  // block scrolls sideways.
  for (const pre of node.querySelectorAll("pre")) {
    const wrap = el("div", "wb-tx-code");
    pre.replaceWith(wrap);
    wrap.append(pre, copyButton("copy code", () => (pre.textContent ?? "").replace(/\n$/, "")));
  }
  return node;
}

/** A block of preformatted text, cut when long, with a button to show the rest. */
function output(text: string, className = ""): HTMLElement {
  const wrap = el("div", `wb-tx-output ${className}`.trim());
  const pre = el("pre", "wb-tx-pre");
  const lines = text.split("\n");
  let shown = text;
  if (lines.length > CLIP_LINES) shown = lines.slice(0, CLIP_LINES).join("\n");
  if (shown.length > CLIP_CHARS) shown = shown.slice(0, CLIP_CHARS);
  pre.textContent = shown;
  wrap.append(pre);
  if (shown.length < text.length) {
    const more = el("button", "wb-tx-more", `show all (${lines.length} lines)`);
    more.type = "button";
    more.addEventListener("click", () => {
      pre.textContent = text;
      more.remove();
    });
    wrap.append(more);
  }
  return wrap;
}

function labelled(label: string, body: Node): HTMLElement {
  return el("div", "wb-tx-section", el("div", "wb-tx-label", label), body);
}


function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// --- collapsible cards ------------------------------------------------------

/** How to fill a card's body. Bodies are built on first open: a long session has
 *  hundreds of collapsed cards, and most are never looked at. */
const builders = new WeakMap<HTMLDetailsElement, () => void>();

function card(className: string, summary: Child[], build: () => Child[]): HTMLDetailsElement {
  const details = el("details", `wb-tx-card ${className}`.trim(), el("summary", "wb-tx-summary", ...summary));
  let built = false;
  const fill = () => {
    if (built) return;
    built = true;
    details.append(el("div", "wb-tx-body", ...build()));
  };
  builders.set(details, fill);
  details.addEventListener("toggle", () => {
    if (details.open) fill();
  });
  return details;
}

/** Open a card now, body included (used to carry "open" across a re-render). */
function openCard(details: HTMLDetailsElement): void {
  builders.get(details)?.();
  details.open = true;
}

// --- tools ------------------------------------------------------------------

const STATUS_GLYPH: Record<ToolStatus, string> = {
  running: "◐",
  ok: "✓",
  error: "✗",
  denied: "⊘",
};

const STATUS_WORD: Record<ToolStatus, string> = {
  running: "running",
  ok: "done",
  error: "failed",
  denied: "denied",
};

/** The change a file tool makes: the recorded patch, or — while the call is still
 *  waiting (a permission prompt) — what its input says it will do. */
function diffOf(item: ToolItem): DiffHunk[] | null {
  if (item.diff) return item.diff;
  const prefixed = (text: string, sign: string) =>
    text.replace(/\n$/, "").split("\n").map((l) => `${sign}${l}`);
  if (item.name === "Edit") {
    const before = inputStr(item, "old_string");
    const after = inputStr(item, "new_string");
    if (!before && !after) return null;
    return [{ oldStart: 0, newStart: 0, lines: [...prefixed(before, "-"), ...prefixed(after, "+")] }];
  }
  if (item.name === "Write") {
    const content = inputStr(item, "content");
    return content ? [{ oldStart: 0, newStart: 1, lines: prefixed(content, "+") }] : null;
  }
  return null;
}

function diffCounts(hunks: DiffHunk[]): string {
  let add = 0;
  let del = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
  }
  return `+${add} −${del}`;
}

function diffBlock(hunks: DiffHunk[]): HTMLElement {
  const block = el("div", "wb-tx-diff");
  let shown = 0;
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const rest: HTMLElement[] = [];
  const put = (row: HTMLElement) => {
    if (shown < CLIP_LINES) block.append(row);
    else rest.push(row);
  };
  hunks.forEach((h, i) => {
    if (i > 0) put(el("div", "wb-tx-diff-gap", "⋯"));
    for (const l of h.lines) {
      const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
      const row = el("div", `wb-tx-diff-line wb-tx-diff-${kind}`);
      row.textContent = l || " ";
      put(row);
      shown++;
    }
  });
  if (rest.length > 0) {
    const more = el("button", "wb-tx-more", `show all (${total} lines)`);
    more.type = "button";
    more.addEventListener("click", () => more.replaceWith(...rest));
    block.append(more);
  }
  return block;
}

function questionBlock(q: AskedQuestion): HTMLElement {
  const chosen = new Set((q.answer ?? "").split(", "));
  const options = el("ul", "wb-tx-options");
  for (const o of q.options) {
    const picked = chosen.has(o.label);
    options.append(
      el(
        "li",
        picked ? "wb-tx-option wb-tx-option-picked" : "wb-tx-option",
        el("span", "wb-tx-option-label", `${picked ? "●" : "○"} ${o.label}`),
        o.description && el("span", "wb-tx-option-desc", ` — ${o.description}`),
      ),
    );
  }
  const custom = q.answer !== null && !q.options.some((o) => chosen.has(o.label));
  return el(
    "div",
    "wb-tx-question",
    el("div", "wb-tx-question-text", q.question),
    options,
    custom && el("div", "wb-tx-answer", `answered: ${q.answer}`),
  );
}

/** "open plan" on a plan's card (step P1). It only carries a class: the desktop's
 *  transcript view catches the click (it knows the session and the dock); the
 *  phone, which has no dock, hides it. */
function planButton(): HTMLButtonElement {
  const button = el("button", "wb-tx-open-plan", "open plan");
  button.type = "button";
  button.title = "open the plan in a tab beside the console";
  return button;
}

function toolBody(item: ToolItem): Child[] {
  const failed = item.status === "error" || item.status === "denied";
  const result = item.resultText ? output(item.resultText, failed ? "wb-tx-err" : "") : null;

  if (item.questions) {
    return [...item.questions.map(questionBlock), failed && result];
  }
  if (item.name === "ExitPlanMode") {
    return [markdown(inputStr(item, "plan")), planButton(), result];
  }
  if (item.agent) {
    const prompt = inputStr(item, "prompt");
    return [
      prompt && labelled("prompt", output(prompt)),
      item.agent.result
        ? labelled("result", markdown(item.agent.result))
        : failed
          ? result
          : el("div", "wb-tx-dim", item.agent.running ? "still running…" : "no result recorded"),
    ];
  }
  if (item.name === "Bash") {
    const out: Child[] = [output(inputStr(item, "command"), "wb-tx-command")];
    if (item.stdout === null) return [...out, result];
    if (item.stdout) out.push(output(item.stdout));
    if (item.stderr) out.push(output(item.stderr, "wb-tx-err"));
    if (!item.stdout && !item.stderr) out.push(el("div", "wb-tx-dim", "no output"));
    return out;
  }
  const hunks = diffOf(item);
  if (hunks) {
    return [el("div", "wb-tx-path", inputStr(item, "file_path")), diffBlock(hunks), failed && result];
  }
  if (item.name === "Read" || item.name === "Grep" || item.name === "Glob") {
    return [result ?? el("div", "wb-tx-dim", "no result yet")];
  }
  return [labelled("input", output(JSON.stringify(item.input, null, 2))), result && labelled("result", result)];
}

function toolCard(item: ToolItem): HTMLElement {
  const hunks = item.name === "Edit" || item.name === "Write" ? diffOf(item) : null;
  const glyph = el("span", "wb-tx-status", STATUS_GLYPH[item.status]);
  glyph.title = STATUS_WORD[item.status];
  return card(
    `wb-tx-tool wb-tx-tool-${item.status}`,
    [
      glyph,
      el("span", "wb-tx-tool-name", toolTitle(item)),
      el("span", "wb-tx-tool-target", toolTarget(item)),
      hunks && el("span", "wb-tx-tool-meta", diffCounts(hunks)),
      item.status === "denied" && el("span", "wb-tx-tool-meta", "denied"),
    ],
    () => toolBody(item),
  );
}

/**
 * What a tool call that is waiting for permission would do, drawn the way its
 * card's body is: the command for Bash, the change for Edit / Write, the plan for
 * ExitPlanMode, the arguments otherwise. For the choice card (step T5), which has
 * the call's name and input from the hook before the transcript has the line.
 */
export function renderPendingTool(name: string, input: Record<string, unknown>): HTMLElement {
  const item: ToolItem = {
    kind: "tool",
    id: "",
    rev: 0,
    timestamp: null,
    name,
    input,
    status: "running",
    resultText: null,
    stdout: null,
    stderr: null,
    diff: null,
    questions: null,
    agent: null,
  };
  const description = name === "Bash" && inputStr(item, "description");
  // A read-only tool's card shows its result; before it runs there are only the
  // arguments.
  const lookup = name === "Read" || name === "Grep" || name === "Glob";
  return el(
    "div",
    "wb-tx wb-tx-pending",
    description && el("div", "wb-tx-dim", description),
    ...(lookup ? [output(JSON.stringify(input, null, 2))] : toolBody(item)),
  );
}

// --- the other items --------------------------------------------------------

function userBlock(item: UserItem): HTMLElement {
  const text = el("div", "wb-tx-user-text");
  text.textContent = item.text;
  const node = el("div", "wb-tx-user", el("span", "wb-tx-prompt", "❯"), text);
  for (const image of item.images) {
    const img = el("img", "wb-tx-image");
    // The media type was checked against an allow-list by the model.
    img.src = `data:${image.mediaType};base64,${image.data}`;
    img.alt = "pasted image";
    text.append(img);
  }
  return node;
}

function commandBlock(item: CommandItem): HTMLElement {
  const title = [item.name, item.args].filter(Boolean).join(" ") || "command output";
  const head = [el("span", "wb-tx-command-name", title)];
  if (!item.output) return el("div", "wb-tx-command-line", ...head);
  return card("wb-tx-command-card", head, () => [output(item.output ?? "")]);
}

function dividerBlock(item: DividerItem): HTMLElement {
  let label = "context cleared";
  if (item.reason === "compact") {
    label =
      item.preTokens !== null && item.postTokens !== null
        ? `compacted · ${tokens(item.preTokens)} → ${tokens(item.postTokens)} tokens`
        : "compacted";
  }
  const rule = el("div", "wb-tx-divider", el("span", "wb-tx-divider-label", label));
  if (!item.summary) return rule;
  const summary = item.summary;
  return el(
    "div",
    "wb-tx-divider-wrap",
    rule,
    card("wb-tx-summary-card", ["summary carried forward"], () => [markdown(summary)]),
  );
}

/** Build the element for one item. */
export function renderItem(item: Item): HTMLElement {
  let node: HTMLElement;
  switch (item.kind) {
    case "user":
      node = userBlock(item);
      break;
    case "assistant":
      node = el(
        "div",
        "wb-tx-message",
        markdown(item.text, item.isError ? "wb-tx-assistant wb-tx-err" : "wb-tx-assistant"),
        // The message as Claude wrote it: its markdown source.
        copyButton("copy message", () => item.text),
      );
      break;
    case "thinking":
      node = item.text.trim()
        ? card("wb-tx-thinking", ["thought"], () => [markdown(item.text)])
        : el("div", "wb-tx-thinking wb-tx-marker", "thought");
      break;
    case "tool":
      node = toolCard(item);
      break;
    case "command":
      node = commandBlock(item);
      break;
    case "divider":
      node = dividerBlock(item);
      break;
    case "interrupted":
      node = el(
        "div",
        "wb-tx-interrupted wb-tx-marker",
        item.forToolUse ? "interrupted — tool use declined" : "interrupted",
      );
      break;
    case "turn-end":
      node = el("div", "wb-tx-turn-end wb-tx-marker", duration(item.durationMs));
      break;
    case "notice":
      node = el("div", `wb-tx-notice wb-tx-notice-${item.level}`, markdown(item.text));
      break;
  }
  node.dataset.itemId = item.id;
  node.dataset.itemKind = item.kind;
  return node;
}

// --- keeping a container in step --------------------------------------------

export interface TranscriptRenderer {
  /** Make the container show exactly `items`, reusing every element whose item
   *  hasn't changed. Cards the user opened stay open when their item updates. */
  update(items: readonly Item[]): void;
  /** Remove everything this renderer put in the container. */
  clear(): void;
}

/** Which cards inside `node` (itself included) are open, by position. */
function openCards(node: HTMLElement): number[] {
  const all = [node, ...node.querySelectorAll("details")];
  return all.flatMap((d, i) => (d instanceof HTMLDetailsElement && d.open ? [i] : []));
}

function reopen(node: HTMLElement, open: number[]): void {
  // Bodies are built on open, so a nested card only exists once its parent is
  // open: look the list up again for each index, outermost first.
  for (const i of open) {
    const d = [node, ...node.querySelectorAll("details")][i];
    if (d instanceof HTMLDetailsElement) openCard(d);
  }
}

export function createRenderer(container: HTMLElement): TranscriptRenderer {
  container.classList.add("wb-tx");
  const shown = new Map<string, { rev: number; node: HTMLElement }>();

  return {
    update(items) {
      const wanted = new Set(items.map((i) => i.id));
      for (const [id, rec] of shown) {
        if (!wanted.has(id)) {
          rec.node.remove();
          shown.delete(id);
        }
      }
      let cursor = container.firstElementChild;
      for (const item of items) {
        let rec = shown.get(item.id);
        if (!rec || rec.rev !== item.rev) {
          const node = renderItem(item);
          if (rec) {
            reopen(node, openCards(rec.node));
            if (cursor === rec.node) cursor = rec.node.nextElementSibling;
            rec.node.remove();
          }
          rec = { rev: item.rev, node };
          shown.set(item.id, rec);
        }
        if (rec.node === cursor) cursor = cursor.nextElementSibling;
        else container.insertBefore(rec.node, cursor);
      }
    },
    clear() {
      for (const rec of shown.values()) rec.node.remove();
      shown.clear();
    },
  };
}
