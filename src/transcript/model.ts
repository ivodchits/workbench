// Transcript model (step T2): fold a session's JSONL lines into a conversation.
//
// The backend (`ipc/transcript`) hands over raw lines; this module is the one
// place that knows what they mean. It has no DOM and no framework in it, so the
// desktop view and the phone share it. The shapes are the ones captured in T0
// (`src-tauri/src/transcript/fixtures`, findings in the improvement plan).
//
// Three properties the callers rely on:
//
// - **Idempotent.** Every conversation line has a `uuid`; a line seen twice is
//   ignored, so a re-delivered `transcript-appended` event does no harm.
// - **Tolerant.** Half the file is bookkeeping (`attachment`, `mode`, …) and new
//   line types appear with every Claude Code release. Anything not understood is
//   skipped; nothing here throws on input.
// - **Order-independent across pages.** History is paged in from the end, so an
//   older page can arrive after the lines that follow it — a tool result before
//   its call. `prepend` re-folds everything from the kept lines, which is what
//   pairs them up again.

/** One of the questions an `AskUserQuestion` call asked, with what was answered. */
export interface AskedQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
  /** The answer as Claude Code recorded it; null until answered. */
  answer: string | null;
}

/** A hunk of a file change, in unified-diff form (`+` / `-` / ` ` line prefixes). */
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

export type ToolStatus = "running" | "ok" | "error" | "denied";

interface ItemBase {
  /** Stable across re-folds: the line's uuid, or the tool-use id for a tool. */
  id: string;
  /** Bumped each time the item changes after it was created (a result arrives). */
  rev: number;
  /** ISO timestamp of the line that created the item, when it had one. */
  timestamp: string | null;
}

/** Something the user typed. */
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  images: { mediaType: string; data: string }[];
}

/** A block of the assistant's answer, as markdown. */
export interface AssistantItem extends ItemBase {
  kind: "assistant";
  text: string;
  /** Claude Code's own error text (API failure), not the model speaking. */
  isError: boolean;
}

/** The assistant thought. The text is empty in current transcripts (T0). */
export interface ThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
}

/** A tool call, paired with its result once that arrives. */
export interface ToolItem extends ItemBase {
  kind: "tool";
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  /** The result as the model saw it. */
  resultText: string | null;
  /** Bash: what the command printed. */
  stdout: string | null;
  stderr: string | null;
  /** Edit / Write: the change that was made. Null until the result arrives. */
  diff: DiffHunk[] | null;
  /** AskUserQuestion: the questions, with answers once given. */
  questions: AskedQuestion[] | null;
  /** Agent: the subagent's run. Its own messages live in a separate file. */
  agent: {
    description: string;
    type: string;
    agentId: string | null;
    /** True while a background agent hasn't reported back. */
    running: boolean;
    /** The agent's final report (markdown). */
    result: string | null;
  } | null;
}

/** A slash command (or `!` shell line) run in the TUI, with what it printed. */
export interface CommandItem extends ItemBase {
  kind: "command";
  name: string;
  args: string;
  output: string | null;
}

/** The context was replaced: `/compact` (same file) or `/clear` (new file). */
export interface DividerItem extends ItemBase {
  kind: "divider";
  reason: "compact" | "clear";
  /** Compact only: context size before and after, when recorded. */
  preTokens: number | null;
  postTokens: number | null;
  /** Compact only: the summary that replaced the conversation. */
  summary: string | null;
}

/** The user pressed Esc: on a running turn, or on a permission prompt. */
export interface InterruptedItem extends ItemBase {
  kind: "interrupted";
  forToolUse: boolean;
}

/** A turn finished; how long it took. */
export interface TurnEndItem extends ItemBase {
  kind: "turn-end";
  durationMs: number;
}

/** A warning or error Claude Code wrote into the transcript, or a background
 *  task's report that has no tool call on screen to attach to. */
export interface NoticeItem extends ItemBase {
  kind: "notice";
  level: "info" | "warning" | "error";
  text: string;
}

export type Item =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | CommandItem
  | DividerItem
  | InterruptedItem
  | TurnEndItem
  | NoticeItem;

export interface TranscriptOptions {
  /** Fold a subagent's own transcript file (`isSidechain` lines) instead of a
   *  session's main thread. Default false. */
  sidechain?: boolean;
}

export interface Transcript {
  /** The conversation so far, oldest first. Replaced on `prepend` / `reset`,
   *  appended to in place otherwise. */
  readonly items: readonly Item[];
  /** Add lines that follow everything held. Returns whether anything changed. */
  append(lines: readonly string[]): boolean;
  /** Add an older page (in file order) that precedes everything held. */
  prepend(lines: readonly string[]): boolean;
  /** Drop everything — the instance moved to another transcript. */
  reset(): void;
}

// --- lines ------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The line types that carry conversation. Everything else is bookkeeping. */
const CONVERSATION_TYPES = new Set(["user", "assistant", "system"]);

/** Parse one raw line into a conversation entry, or null for anything else:
 *  bookkeeping, a line of the other thread, something that isn't JSON. */
function parseLine(raw: string, sidechain: boolean): Json | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  if (typeof v.type !== "string" || !CONVERSATION_TYPES.has(v.type)) return null;
  if (typeof v.uuid !== "string") return null;
  if ((v.isSidechain === true) !== sidechain) return null;
  // The whole pre-edit file rides along with every Edit result; the hunks are
  // all we show, and a long session would otherwise hold each file many times.
  if (isObject(v.toolUseResult)) delete v.toolUseResult.originalFile;
  return v;
}

// --- text helpers -----------------------------------------------------------

/** Text between `<tag>` and `</tag>`, or null when the tag isn't there. */
function tag(text: string, name: string): string | null {
  const open = `<${name}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(`</${name}>`, start + open.length);
  // Unclosed means the text was cut short (a clipped line); keep what there is.
  return text.slice(start + open.length, end < 0 ? undefined : end);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Command output is terminal text; drop the color codes. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;

/** A `tool_result` block's content as text (it is a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isObject(b) && b.type === "text" ? (str(b.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

// --- folding ----------------------------------------------------------------

interface State {
  items: Item[];
  tools: Map<string, ToolItem>;
  /** The command whose output hasn't arrived yet, if the last line was one. */
  openCommand: CommandItem | null;
  /** Set after `/compact`'s or `/clear`'s own command line: its output is noise. */
  dropOutput: boolean;
  lastCompact: DividerItem | null;
}

function emptyState(): State {
  return { items: [], tools: new Map(), openCommand: null, dropOutput: false, lastCompact: null };
}

function base(line: Json, suffix = ""): ItemBase {
  return { id: `${line.uuid as string}${suffix}`, rev: 0, timestamp: str(line.timestamp) };
}

function questionsOf(input: Json): AskedQuestion[] | null {
  if (!Array.isArray(input.questions)) return null;
  return input.questions.filter(isObject).map((q) => ({
    header: str(q.header) ?? "",
    question: str(q.question) ?? "",
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(isObject).map((o) => ({
      label: str(o.label) ?? "",
      description: str(o.description) ?? "",
    })),
    answer: null,
  }));
}

function toolUse(state: State, line: Json, block: Json): void {
  const id = str(block.id);
  if (!id || state.tools.has(id)) return;
  const name = str(block.name) ?? "tool";
  const input = isObject(block.input) ? block.input : {};
  const item: ToolItem = {
    kind: "tool",
    id,
    rev: 0,
    timestamp: str(line.timestamp),
    name,
    input,
    status: "running",
    resultText: null,
    stdout: null,
    stderr: null,
    diff: null,
    questions: name === "AskUserQuestion" ? questionsOf(input) : null,
    agent:
      name === "Agent" || name === "Task"
        ? {
            description: str(input.description) ?? "",
            type: str(input.subagent_type) ?? "",
            agentId: null,
            running: true,
            result: null,
          }
        : null,
  };
  state.tools.set(id, item);
  state.items.push(item);
}

function hunksOf(patch: unknown): DiffHunk[] | null {
  if (!Array.isArray(patch)) return null;
  return patch.filter(isObject).map((h) => ({
    oldStart: num(h.oldStart) ?? 1,
    newStart: num(h.newStart) ?? 1,
    lines: Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [],
  }));
}

function toolResult(state: State, line: Json, block: Json): void {
  const item = state.tools.get(str(block.tool_use_id) ?? "");
  // No call on screen: it is in an earlier page not loaded yet. `prepend` re-folds
  // with that page in place and the pair forms then.
  if (!item || item.status !== "running") return;
  item.rev++;
  item.resultText = resultText(block.content);
  item.status =
    line.toolDenialKind !== undefined ? "denied" : block.is_error === true ? "error" : "ok";

  const result = line.toolUseResult;
  if (!isObject(result)) {
    // A failed or refused call: `toolUseResult` is a plain string, nothing more.
    if (item.agent) item.agent.running = false;
    return;
  }
  if (typeof result.stdout === "string") {
    item.stdout = result.stdout;
    item.stderr = str(result.stderr);
  }
  const hunks = hunksOf(result.structuredPatch);
  if (hunks && hunks.length > 0) {
    item.diff = hunks;
  } else if (result.type === "create" && typeof result.content === "string") {
    // A new file has no patch; show it as all-added.
    const lines = result.content.replace(/\n$/, "").split("\n");
    item.diff = [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }];
  }
  if (item.questions && isObject(result.answers)) {
    for (const q of item.questions) {
      const a = result.answers[q.question];
      q.answer = typeof a === "string" ? a : Array.isArray(a) ? a.join(", ") : null;
    }
  }
  if (item.agent) {
    item.agent.agentId = str(result.agentId);
    if (result.isAsync === true || result.status === "async_launched") {
      // Launched in the background; the report comes later as a task notification.
      item.status = "running";
    } else {
      item.agent.running = false;
      item.agent.result = item.resultText;
    }
  }
}

/** A background task reported back. Attach it to its Agent call when that is on
 *  screen; otherwise say so in a line of its own. */
function taskNotification(state: State, line: Json, text: string): void {
  const status = tag(text, "status") ?? "completed";
  const result = tag(text, "result");
  const item = state.tools.get(tag(text, "tool-use-id") ?? "");
  if (item?.agent) {
    item.rev++;
    item.agent.running = false;
    item.agent.result = result ?? item.agent.result;
    item.status = status === "completed" ? "ok" : "error";
    return;
  }
  const summary = tag(text, "summary") ?? "Background task finished";
  state.items.push({
    ...base(line),
    kind: "notice",
    level: status === "completed" ? "info" : "warning",
    text: result ? `${summary}\n\n${result}` : summary,
  });
}

function command(state: State, line: Json, name: string, args: string): void {
  if (name === "/clear") {
    state.items.push({
      ...base(line),
      kind: "divider",
      reason: "clear",
      preTokens: null,
      postTokens: null,
      summary: null,
    });
    state.dropOutput = true;
    return;
  }
  if (name === "/compact" && state.lastCompact) {
    // The divider already says it; the command's output is hook chatter.
    state.dropOutput = true;
    return;
  }
  const item: CommandItem = { ...base(line), kind: "command", name, args, output: null };
  state.items.push(item);
  state.openCommand = item;
}

function commandOutput(state: State, line: Json, output: string): void {
  if (state.dropOutput) {
    state.dropOutput = false;
    return;
  }
  const text = stripAnsi(output).replace(/^\n+|\s+$/g, "");
  const open = state.openCommand;
  state.openCommand = null;
  if (open) {
    open.rev++;
    open.output = text;
  } else if (text) {
    state.items.push({ ...base(line), kind: "command", name: "", args: "", output: text });
  }
}

/** Text that the TUI wrote into the transcript in the user's or system's name:
 *  slash commands, their output, `!` shell lines, task reports. Returns whether
 *  the text was one of those (and so is not something the user typed). */
function wrapped(state: State, line: Json, text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("<")) return false;
  if (t.startsWith("<command-name>")) {
    command(state, line, (tag(t, "command-name") ?? "").trim(), (tag(t, "command-args") ?? "").trim());
    return true;
  }
  if (t.startsWith("<local-command-stdout>")) {
    commandOutput(state, line, tag(t, "local-command-stdout") ?? "");
    return true;
  }
  if (t.startsWith("<local-command-stderr>")) {
    commandOutput(state, line, tag(t, "local-command-stderr") ?? "");
    return true;
  }
  if (t.startsWith("<bash-input>")) {
    command(state, line, "!", (tag(t, "bash-input") ?? "").trim());
    return true;
  }
  if (t.startsWith("<bash-stdout>") || t.startsWith("<bash-stderr>")) {
    const out = [tag(t, "bash-stdout"), tag(t, "bash-stderr")].filter(Boolean).join("\n");
    commandOutput(state, line, out);
    return true;
  }
  if (t.startsWith("<task-notification>")) {
    taskNotification(state, line, t);
    return true;
  }
  // Context for the model about a command the user ran; nothing to show.
  return t.startsWith("<local-command-caveat>");
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** The TUI marks pasted text for the model with `<pasted_content id="…">` (the
 *  closing tag carries the id too); the user only typed what is inside. */
const PASTED = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>\n?/g;

function userLine(state: State, line: Json): void {
  // Notes for the model (the caveat before a command, the path of a pasted image).
  if (line.isMeta === true) return;
  const message = isObject(line.message) ? line.message : {};
  const content = message.content;

  if (line.isCompactSummary === true) {
    const summary = typeof content === "string" ? content : resultText(content);
    if (state.lastCompact) {
      state.lastCompact.rev++;
      state.lastCompact.summary = summary;
    }
    return;
  }

  const texts: string[] = [];
  const images: UserItem["images"] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_result") {
        toolResult(state, line, block);
      } else if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "image" && isObject(block.source)) {
        const mediaType = str(block.source.media_type) ?? "";
        const data = str(block.source.data);
        if (block.source.type === "base64" && data && IMAGE_TYPES.test(mediaType)) {
          images.push({ mediaType, data });
        }
      }
    }
  }

  const text = texts.join("\n").replace(PASTED, "").trim();
  if (!text && images.length === 0) return;
  const interrupted = INTERRUPTED.exec(text);
  if (interrupted) {
    state.items.push({ ...base(line), kind: "interrupted", forToolUse: Boolean(interrupted[1]) });
    return;
  }
  if (images.length === 0 && wrapped(state, line, text)) return;
  state.openCommand = null;
  state.items.push({ ...base(line), kind: "user", text, images });
}

function assistantLine(state: State, line: Json): void {
  const message = isObject(line.message) ? line.message : {};
  if (!Array.isArray(message.content)) return;
  state.openCommand = null;
  message.content.forEach((block, i) => {
    if (!isObject(block)) return;
    // One block per line in practice; the index keeps ids unique if that changes.
    const suffix = i === 0 ? "" : `:${i}`;
    if (block.type === "text" && typeof block.text === "string") {
      if (!block.text.trim()) return;
      state.items.push({
        ...base(line, suffix),
        kind: "assistant",
        text: block.text,
        isError: line.isApiErrorMessage === true,
      });
    } else if (block.type === "thinking") {
      state.items.push({ ...base(line, suffix), kind: "thinking", text: str(block.thinking) ?? "" });
    } else if (block.type === "tool_use") {
      toolUse(state, line, block);
    }
  });
}

function systemLine(state: State, line: Json): void {
  const content = str(line.content);
  switch (line.subtype) {
    case "compact_boundary": {
      // `/compact` typed by hand is recorded as a prompt just before the boundary.
      const prev = state.items[state.items.length - 1];
      if (prev?.kind === "user" && prev.text.startsWith("/compact")) state.items.pop();
      const meta = isObject(line.compactMetadata) ? line.compactMetadata : {};
      const divider: DividerItem = {
        ...base(line),
        kind: "divider",
        reason: "compact",
        preTokens: num(meta.preTokens),
        postTokens: num(meta.postTokens),
        summary: null,
      };
      state.items.push(divider);
      state.lastCompact = divider;
      return;
    }
    case "turn_duration": {
      const durationMs = num(line.durationMs);
      if (durationMs !== null) state.items.push({ ...base(line), kind: "turn-end", durationMs });
      return;
    }
    case "local_command":
      if (content) wrapped(state, line, content);
      return;
    default:
      // Anything else is shown only if Claude Code marked it as a problem.
      if (content && (line.level === "warning" || line.level === "error")) {
        state.items.push({ ...base(line), kind: "notice", level: line.level, text: content });
      }
  }
}

function fold(state: State, line: Json): void {
  try {
    if (line.type === "user") userLine(state, line);
    else if (line.type === "assistant") assistantLine(state, line);
    else systemLine(state, line);
  } catch {
    // A shape nobody has seen yet. Skip the line; the rest still renders.
  }
}

// --- public API -------------------------------------------------------------

export function createTranscript(options: TranscriptOptions = {}): Transcript {
  const sidechain = options.sidechain === true;
  /** Every conversation line held, in file order — what `prepend` re-folds. */
  let lines: Json[] = [];
  const seen = new Set<string>();
  let state = emptyState();

  /** Parse, and keep only conversation lines not already held. */
  function fresh(raw: readonly string[]): Json[] {
    const out: Json[] = [];
    for (const r of raw) {
      const line = parseLine(r, sidechain);
      if (!line || seen.has(line.uuid as string)) continue;
      seen.add(line.uuid as string);
      out.push(line);
    }
    return out;
  }

  return {
    get items() {
      return state.items;
    },
    append(raw) {
      const added = fresh(raw);
      for (const line of added) {
        lines.push(line);
        fold(state, line);
      }
      return added.length > 0;
    },
    prepend(raw) {
      const added = fresh(raw);
      if (added.length === 0) return false;
      lines = added.concat(lines);
      state = emptyState();
      // Lines are re-folded from parsed objects the previous fold may have read
      // but never changed, so folding them again gives the same items.
      for (const line of lines) fold(state, line);
      return true;
    },
    reset() {
      lines = [];
      seen.clear();
      state = emptyState();
    },
  };
}
