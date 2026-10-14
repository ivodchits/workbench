# Workbench — Improvement Plan (post-1.1)

A step-by-step plan for the next round of work: a **transcript view** for consoles (with
in-view answering of "needs you" prompts), **console fixes**, **drag-to-reference**, a
better **diff/review** loop, **project notes**, and a **remote** that is pleasant on a phone
and reachable without toggling Tailscale.

Companion to `claude-code-workbench-design.md` and
`claude-code-workbench-development-plan.md`. Same working rules as the Git panel plan:
**one step per session**, respect **Depends on**, honor the Definition of Done, and append
an **As built** note to a step when it lands.

Origin: a comparison against JetBrains Air (2026-10-12) plus four items from daily use.
Air's strengths were its review loop and context attachment; its structured chat depends on
ACP, which this plan deliberately does not adopt (see Guardrails).

---

## Scope statement

**In scope**

| Track | What |
|---|---|
| **C — Console** | Shift+Enter newline, scrollback limit, garbled/blank rendering with several consoles, overwritten output |
| **T — Transcript view** | A second rendering of a Claude console, built from the session transcript, toggled from the console tab at any moment; prompt composer; choice cards for "needs you" |
| **D — Drag to reference** | Drag a file onto a console to insert an `@path` reference |
| **V — Diff / review** | Better diff rendering, navigation, inline comments sent to the agent, "add to prompt" |
| **N — Notes** | A project notes panel, markdown, edited like any file; also readable and writable from the phone (R8) |
| **R — Remote** | Transcript view + choice cards + prompt-first input on the phone; creating a session from the phone; project notes on the phone; Tailscale Funnel so the remote is ready whenever the app runs; push notifications |
| **P — Plans** | An on-demand "open plan" button (never automatic) |
| **A — Agent review** | "Review with a fresh agent" |
| **M — Mods** | Run summary on done, as a Claude Code mod |

**Out of scope (decided 2026-10-12):** before-request snapshots (git covers it),
a permission-mode switch, auto-opening plans, web preview device toolbar, editor blame,
Docker run environments, voice dictation, ACP / multi-vendor agents.

---

## Current state (audit, 2026-10-12)

**Console** — `src/panels/terminalPool.ts`, `src/panels/Console.tsx`,
`src/panels/ConsolePanel.tsx`, `src-tauri/src/pty/mod.rs`.

| Where | Finding |
|---|---|
| `terminalPool.ts:285-296` | `new Terminal({...})` sets no `scrollback`, so consoles keep xterm's default 1,000 lines. |
| `terminalPool.ts:301-308` | The custom key handler only handles Ctrl+Shift+C. Shift+Enter reaches the TUI as a plain Enter and submits. |
| `terminalPool.ts:302-305`, `:611` | Copy is `term.getSelection()`. Claude's TUI hard-wraps its own output, so copied text always carries those line breaks. Not fixable in the terminal; the transcript view is the fix. |
| `terminalPool.ts:74-85`, `:477-494` | `resyncViewport` rebuilds the WebGL glyph atlas and refreshes. It runs on focus, re-parent and tab-switch visibility — which matches the "garbled until I focus the panel" symptom. A console that is visible but never focused (side-by-side) gets no rebuild. **Hypothesis, not reproduced.** |
| `state/consoles.ts:27` | `WEBGL_CAP = 10`; shells use the DOM renderer. |
| `terminalPool.ts:314-322` | On WebGL context loss the addon is disposed; nothing re-renders or re-creates it. |
| `pty/mod.rs:34`, `:126-134` | 1 MiB raw-byte ring, replayed verbatim on attach. Eviction cuts at an arbitrary byte, so a replay can start mid-escape-sequence or mid-redraw. |
| `pty/mod.rs:142-149` | PTY is sized to the minimum across subscribers; every resize makes the TUI redraw in place. Suspected cause of "output rendered again on top of the previous output with an offset". **Hypothesis, not reproduced.** |
| `package-lock.json` | `@xterm/xterm` 5.5.0, `@xterm/addon-webgl` 0.18.0. |

**Transcript** — `src-tauri/src/transcript/mod.rs` already tails each live session's JSONL
incrementally (byte offset per session, 2 s poll) but extracts only `usage` and resume
summaries. `notify` is already a dependency (git watcher).

**Hooks** — `src-tauri/src/hooks/`. `PreToolUse`, `PostToolUse`, `PermissionRequest`,
`Notification`, `Stop` and friends are installed (`install.rs:39-56`). `HookEvent`
flattens every unknown field into `rest` (`events.rs:38-41`), so `tool_input` and
`transcript_path` **already reach the frontend** in the `hook-event` envelope; the status
engine just doesn't use them. The hook server answers immediately and never returns a
decision.

**Needs-you actions** — `src/state/remoteActions.ts`: approve = Enter, deny = Esc,
interrupt = Esc, written to the PTY. One place, by design (§11 caveat). No notion of
*which* options a prompt offers.

**Drag and drop** — `tauri.conf.json:21` has `dragDropEnabled: false`, so HTML5 drag and
drop works inside the webview (dockview depends on it) but an OS file drop carries no
filesystem path. There is no `draggable` / `dataTransfer` use anywhere in `src/`.

**Diff / review** — `src/panels/Diff/`.

| Where | Finding |
|---|---|
| `UnifiedDiff.tsx` | Flat list of coloured lines: no line numbers, no syntax highlighting, no intra-line changes, no side-by-side. Capped at 4,000 lines. |
| `Diff/index.tsx:39-56`, `:183-201` | "diff" and "edit" are separate modes; entering edit loses the diff. |
| `Diff/index.tsx:245-261` | Refresh is a manual button; `git/watch.rs` exists but the panel doesn't subscribe. |
| `Diff/index.tsx:281-339` | One file at a time, no next/previous-hunk keys, no "viewed" state. |
| `UnifiedDiff.tsx:82-93` | Hunk controls (stage / unstage / discard) exist but only the Git panel passes them. |

**Remote** — `src-tauri/src/remote/`, `src-tauri/src/remote/pwa/index.html`.

| Where | Finding |
|---|---|
| `remote/mod.rs:146-190` | Binds only to the Tailscale address (100.64.0.0/10). Both devices must have Tailscale up. |
| `pwa/index.html:551-565` | Mobile console renders at the desktop's cols and zooms down to fit — tiny text. |
| `pwa/index.html:484-488`, `:577-582` | Raw keyboard sends each keystroke over the socket, no local echo. |
| `pwa/index.html:303-314` | Approve / deny only. No option list, no question text. |
| `pwa/sw.js` | No push handling. Plain HTTP on a tailnet IP is not a secure context, so service worker registration and install likely don't work today. **Not verified.** |
| `remote/server.rs:238-249`, `:312-321` | Bearer token travels in the WebSocket URL query. `/pair` has no rate limit. Acceptable on a tailnet, not on the public internet. |
| `pwa/` | A single hand-written HTML file, `include_str!`'d. No build step, so nothing is shared with the React frontend. |

---

## Guardrails (settled — don't violate)

- **The PTY stays the only way Claude is driven.** No Agent SDK, no `claude -p`, no ACP
  (design §4.3: subscription-friendly, full fidelity). The transcript view is a second
  *rendering* of the same interactive session, never a second way to run it.
- **The terminal is the source of truth for interaction.** Every action taken from the
  transcript view or the phone is a keystroke or paste into the live TUI. If the transcript
  view cannot represent something, it says so and offers the terminal — it never guesses.
- **The toggle is always available** and never restarts, resizes or otherwise disturbs the
  session. The xterm instance keeps running in the pool while the transcript view is shown.
- **Status comes from hooks, content from the transcript.** Whether an instance is waiting
  on you is decided by the existing status engine (`state/status.ts`), not by the
  transcript view. One narrow, deliberate exception is proposed in T0 (reading option
  labels off the terminal buffer); it must be approved there, not assumed.
- **Keystroke mappings live in one module.** Extend `state/remoteActions.ts` (or a module
  it delegates to); desktop transcript view and phone both go through it.
- **Session ids rotate.** `/clear` mints a new session id and a new transcript file
  (`/compact` does not — it continues in the same file; verified in T0). Anything keyed by
  session must follow the instance, using the `transcript_path` that every hook event
  carries.
- **Transcript content is untrusted HTML input.** Render markdown through `marked` +
  `DOMPurify` (already used by the markdown preview); never `innerHTML` raw tool output.
- **Remote: nothing public without the hardening step.** R3 (Funnel) depends on R2
  (hardening). Funnel stays opt-in and off by default.
- **Windows first.** Paths with backslashes and spaces, `CREATE_NO_WINDOW` on any child
  process, no shell interpolation of user strings.

---

## Steps

### Track C — Console fixes

#### Step C1 — Shift+Enter newline + scrollback limit

- **Goal:** Shift+Enter inserts a line break in a Claude console; scrollback is long enough
  to read back a long turn.
- **Depends on:** nothing.
- **Build:**
  - In the existing `attachCustomKeyEventHandler` (`terminalPool.ts:301`), for `kind ===
    "claude"` only: on Shift+Enter keydown write the newline sequence to the PTY and return
    `false`; also swallow the matching `keypress` so xterm doesn't additionally send `\r`.
  - Sequence: start with `ESC` + `CR` (`\x1b\r`, what Alt+Enter sends). **Verify against
    the installed Claude Code**; if it doesn't insert a newline, fall back to backslash +
    Enter. Keep the bytes as a named constant next to `ENTER_KEY` in `src/ipc/pty.ts`.
  - Shells keep default behaviour.
  - Set `scrollback` on desktop terminals (start at 10,000; the mirror already uses 5,000).
    Put the number in one constant.
- **Key files:** `src/panels/terminalPool.ts`, `src/ipc/pty.ts`.
- **Done when:** Shift+Enter adds a line in the prompt without submitting, Enter still
  submits, shells are unaffected, and a turn longer than 1,000 lines can be scrolled back.
- **Out of scope:** making the key configurable in the keymap editor.
- **As built (2026-10-13):** `NEWLINE_KEY` (`\x1b\r`) in `src/ipc/pty.ts`; the key handler
  in `terminalPool.ts` writes it on unmodified Shift+Enter keydown for `kind === "claude"`
  and returns `false` for keydown, keypress and keyup so xterm sends no `\r`. The write
  goes straight to `ptyWrite`, not through `onData`, so the lone-Esc interrupt check does
  not see it. `SCROLLBACK_LINES = 10_000` in `terminalPool.ts`; the one-shot
  `RemoteCommandTerminal` keeps xterm's default. Typecheck and lint pass. Sequence
  verified against Claude Code 2.1.296 by driving the TUI in a scratch PTY: `AAA1`,
  `\x1b\r`, `BBB2` leaves two prompt lines and submits nothing, so the backslash + Enter
  fallback was not needed (open question 4). Checked in a debug build by sending key
  events over the WebView2 debugging port and reading each `pty_write`: in a Claude
  console Shift+Enter writes exactly `[27,13]` (no stray `\r`) and Enter writes `[13]`;
  in a shell Shift+Enter still writes `[13]`. A shell printing 3,000 lines kept ~3,016
  buffer rows. Not done by hand: scrolling a real long Claude turn with the mouse.

#### Step C2 — Blank / garbled consoles with several sessions open

- **Goal:** A visible console always shows correct text without needing focus.
- **Depends on:** nothing.
- **Build:**
  - **Reproduce first.** Open 3+ consoles side by side with agents working; note whether
    it happens under the WebGL cap, after a tear-off, after sleep/resume, after a theme or
    font-scale change. Record the repro in the As-built note.
  - Candidate fixes, in order of cost:
    1. On WebGL context loss, re-create the addon (or at least `refresh`) instead of only
       disposing it.
    2. Rebuild the atlas for **every** pooled terminal when any one of them rebuilds
       (suspected shared-atlas invalidation), and on `visibilitychange` / window focus.
    3. A per-app setting to force the DOM renderer for consoles.
    4. Upgrade `@xterm/xterm` + addons to the current major and re-test.
  - Keep whichever is the smallest change that survives the repro.
- **Key files:** `src/panels/terminalPool.ts`, `src/state/consoles.ts`,
  `src/panels/AppearanceMenu.tsx` (if a setting is added).
- **Done when:** the recorded repro no longer produces blank or garbled output over a
  30-minute multi-agent session.
- **As built (2026-10-13):** one change in `src/panels/terminalPool.ts` (candidate fix 2);
  no setting added, no upgrade.
  - **Cause:** xterm's WebGL renderer keeps one glyph atlas for all terminals with the
    same font and colours (confirmed: three consoles, one atlas object).
    `term.clearTextureAtlas()` wipes that shared atlas but only the terminal it is
    called on forgets where its glyphs were. The others keep their old positions, and
    the next time one of them repaints even a single row it draws from a texture that
    has been wiped and refilled in another order: wrong glyphs, or nothing where the
    old position is now empty. It stays that way until that terminal redraws in full —
    which focusing it does, hence "needs focus".
  - **What triggered it:** the pool cleared the atlas for one terminal on every panel
    focus change (`focusTerminal`), every tab switch and re-parent (`resyncViewport`),
    and when a new console's fonts finished loading. So with consoles side by side,
    clicking into one damaged the others as soon as their agents printed anything.
  - **Repro (debug app, WebView2 debugging port, xterm 5.5.0 / addon-webgl 0.18.0,
    three Claude consoles side by side, all on WebGL, well under the cap):**
    - *Blank:* opening the three at once left the first with its text in the buffer and
      nothing painted until it was focused (seen once, on a fresh launch).
    - *Garbled:* clear one terminal's atlas, then repaint one row in the others (what a
      spinner does). A neighbour's status lines came out garbled in 3–5 of 9 tries.
  - **Fix:** `rebuildAtlas()` calls `clearTextureAtlas()` on every pooled terminal, and
    every place that cleared one terminal's atlas now calls it (focus / tab switch /
    re-parent, font load, font scale, theme). The first call wipes the atlas, the rest
    find it empty and only drop their own stale positions.
  - **Verified:** the same test through the real focus path, rotating focus between the
    three consoles: 0 changes in 60 focus changes, and still 0 after cycling font scale
    and theme and back. Three consoles opened together twice more all painted.
    Typecheck, lint and the 112 unit tests pass.
  - **Not done:** the 30-minute session with agents really working — the check above is
    a few minutes on idle sessions with forced repaints, so it needs confirming in
    daily use. Not tried: more than 10 consoles (the WebGL cap), WebGL context loss
    (candidate 1; a lost context still falls back to the DOM renderer), sleep / resume,
    a torn-off window (its own webview, so its own atlas; same code).
  - **Seen on the way, not fixed:** one console showed a stray `^[[O` at the top left —
    a focus-out report sent before the TUI had started and echoed by the PTY.
  - **Possible follow-up:** the focus path may not need to clear the atlas at all, which
    would save re-drawing every glyph on each click; left as is to keep the change
    small.

#### Step C3 — Overwritten / doubled output

- **Goal:** A turn's output is never painted over an earlier copy of itself.
- **Depends on:** C2 (same file; avoid overlapping edits).
- **Build:**
  - **Reproduce first.** Suspects: (a) a resize arriving mid-turn — splitter drag, a second
    subscriber attaching (tear-off, phone mirror) changing the min-size arbitration;
    (b) ring replay starting mid-sequence on attach.
  - Candidate fixes:
    1. Debounce `fit()` → `ptyResize` so a splitter drag sends one resize, not dozens.
    2. After attach/replay, force one clean TUI redraw (resize nudge: cols−1 then back),
       so the screen ends on a known-good frame.
    3. Make the ring safe to replay: prefix the replay with a terminal reset, and trim the
       ring's start forward to a line boundary outside an escape sequence.
  - Note in As-built which suspect it actually was.
- **Key files:** `src/panels/terminalPool.ts`, `src-tauri/src/pty/mod.rs`,
  `src-tauri/src/remote/server.rs` (mirror attach).
- **Done when:** dragging a splitter during a long streamed answer, and attaching the phone
  mirror mid-turn, both leave a clean screen.
- **As built (2026-10-13):** it was suspect (a), the resize. Candidate 1 fixes it; a form
  of 2 and of 3 went in for the attach paths.
  - **Repro (debug app, two Claude consoles side by side, Claude Code 2.1.296):** one
    splitter drag sent about 50 `pty_resize` calls per console. The TUI redraws on each,
    and each redraw left a stale copy of the screen in the scrollback: an idle 10-line
    screen became 88 lines of repeated banners after one drag. Two drags during a
    streamed answer (184 resizes) left 32 extra banners and 5 extra prompt boxes.
  - **Fix 1 — one resize per drag:** the console's ResizeObserver calls `refitSoon`
    (`terminalPool.ts`), which fits 120 ms after the box stops changing. The terminal
    waits too, not just the PTY; until the drag pauses it keeps its old size. Same test
    after: three drags during a streamed answer, 2 resizes, 1 banner, no repeated items.
  - **Suspect (b), replay starting mid-sequence:** not seen — the ring (1 MiB) had not
    overflowed in any test, and a second subscriber attached mid-turn ended on the same
    screen as the live terminal. It can still happen in a long session, so a ring that
    has dropped bytes is now replayed from after its first line break
    (`OutputHub::replay`, unit-tested). The phone already resets its terminal before a
    replay and a desktop attach starts from a new one, so no reset prefix was added.
  - **Attach at the PTY's size:** `pty_subscribe` now returns
    `{ subId, cols, rows, replayLen }`. A terminal attaching to a live PTY (tear-off,
    dock back) takes the PTY's size, writes the replay, and only then fits to its panel.
    Before, the replay went into whatever size the panel measured; into a narrower one
    it wrapped and redraws landed on the wrong rows (the same ring replayed 13 columns
    narrower than the PTY gave two banners, against one this way). Tear-off and dock
    back both checked in the app.
  - **Phone mirror:** it was told the PTY's size once, on attach, so any later desktop
    resize left it painting new-width output at the old width. The hub now sends remote
    subscribers the size whenever it changes (`RemoteMsg::Size`, forwarded as the
    existing `size` frame, which the PWA already handles at any time). Unit-tested at
    the hub. **Not run against a phone or the PWA:** there is no Tailscale interface on
    the dev machine, so the remote server would not start.
  - **What is left, not fixed:**
    - A width change still repeats up to a screenful at the join: the TUI redraws its
      last screen at the new width under the old-width lines already in the scrollback.
      My reading is that this is Claude Code's own redraw and not ours; not compared
      against another terminal.
    - Overlapping and swallowed output also happens with no resize at all, and in a
      regular console outside Workbench (seen by the user, 2026-10-13). That is Claude
      Code's own rendering; nothing in this step touches it. The transcript view is the
      reliable way to read a turn when it happens.
  - **Follow-up, same day — resizes replayed in place:** a replay written at one size
    garbled the scrollback from before each earlier resize. After five resizes during
    two streamed answers, 812 of 1,166 lines differed from the live terminal's buffer.
    The hub now records where in the output each resize fell (`OutputHub::resizes`,
    trimmed with the ring). `pty_subscribe` returns them as
    `resizes: [{ at, cols, rows }]`, with `cols`/`rows` now the size the replay
    *starts* at, and the attaching terminal resizes at each byte offset (`writeOut` in
    `terminalPool.ts`). Same case after: 0 of 1,166 lines differ. Tear-off and dock
    back re-checked in the app. A remote subscriber gets the same thing as `size`
    frames between the replayed bytes, and the PWA now applies a `size` from xterm's
    write queue so it lands in order — like the rest of the phone path, unit-tested at
    the hub only, not run against a phone.
  - Typecheck, lint, 112 frontend tests and 116 Rust tests pass.

---

### Track T — Transcript view

#### Step T0 — Spike: what the transcript and hooks actually give us

- **Goal:** Replace assumptions with fixtures before building. No UI.
- **Depends on:** nothing.
- **Build:**
  - Capture real JSONL samples from the installed Claude Code into
    `src-tauri/src/transcript/fixtures/` covering: plain text turn, thinking, Bash, Edit,
    Write, Read, a failed tool, a subagent (where do sidechain messages live — same file or
    a separate one?), an image paste, `/compact`, `/clear`, an interrupted turn, a slash
    command, `AskUserQuestion`, `ExitPlanMode`.
  - Log raw hook payloads for the "needs you" cases and record, for each, **exactly** what
    is present: `PermissionRequest` (tool name, `tool_input`, any suggested rules),
    `PreToolUse` for `AskUserQuestion` (questions, options, `multiSelect`) and for
    `ExitPlanMode` (plan text), `Notification` types. Also: which event marks the prompt
    as *resolved* (`PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`).
  - Determine the answer keys by hand in the TUI: do number keys select an option
    directly? What do multi-question and multi-select prompts need? What does "Other /
    type something" need?
  - Measure transcript write latency: how long after text appears in the TUI does the line
    land in the file?
  - **Decide the option-label source** for permission prompts (the hook does not carry the
    literal option list). Options:
    1. *Hook-only:* show generic **Allow / Deny**, plus whatever the payload offers.
    2. *Read the terminal buffer:* parse the numbered option lines from the bottom of the
       live xterm buffer, so the buttons match the TUI exactly and the number-key mapping
       is correct by construction. Hooks still decide *whether* a prompt is pending. This
       is the narrow exception to "never parse terminal output"; it degrades to (1) when
       parsing fails.
    3. *Answer through the hook response* (hold the HTTP hook, return allow/deny).
       Structured, but the TUI never shows the prompt, which breaks the "terminal is the
       source of truth" guardrail. Evaluate only; default is to reject.
  - Write the findings into this document under T0 **As built**, including the decision.
- **Done when:** fixtures are committed, the payload table is filled in, and the
  option-label source is chosen.
- **As built (2026-10-13):** captured from Claude Code 2.1.296 (Sonnet 5.5) by driving one
  TUI session in a scratch PTY with `--permission-mode default` and an extra HTTP hook
  that logged every payload. Fixtures and their sanitizing rules:
  `src-tauri/src/transcript/fixtures/` (`README.md` there).

  **Transcript**

  | Topic | Finding |
  |---|---|
  | Line types | Conversation lines are `user`, `assistant`, `system`. Everything else is bookkeeping to skip: `attachment` (about half of all lines — one `hook_success` per hook per event), `mode`, `permission-mode`, `atis-latch`, `ai-title`, `agent-name`, `last-prompt`, `file-history-snapshot`, `file-history-delta`, `queue-operation`, `cost-state`. |
  | Assistant lines | One line per content block (`text`, `thinking`, `tool_use`); blocks of one API message share `message.id`. |
  | Thinking | The `thinking` block is present but its text is **empty** (signature only). There is nothing to show — render a "thought" marker at most. |
  | Tool results | A `user` line with a `tool_result` block, paired by `tool_use_id`. The line also carries a structured `toolUseResult` (Bash: `stdout` / `stderr` / `interrupted`; Edit: `structuredPatch`, `originalFile`; AskUserQuestion: `answers`) and, when a prompt was answered, `permissionDecision`. |
  | Failed tool | `is_error: true`; `toolUseResult` is a plain string `"Error: …"`. |
  | Denied tool | `is_error: true`, `toolUseResult: "User rejected tool use"`, `toolDenialKind: "user-rejected"`. |
  | Interrupted | The partial answer **is** saved as a normal `assistant` text line, followed by a `user` line whose text is `[Request interrupted by user]` (or `… for tool use]` when Esc cancelled a permission prompt). |
  | Subagent (question 3) | A **separate file**: `<session-id>/subagents/agent-<agentId>.jsonl` plus `.meta.json` (`agentType`, `description`, `toolUseId`), lines marked `isSidechain: true`. The main file only has the `Agent` tool call, its immediate "launched" result, and later a `user` line holding a `<task-notification>` with the result. `SubagentStop` gives the path as `agent_transcript_path`. |
  | Image paste | `user` content is `[text, image]` (base64 PNG inline), then an `isMeta` user line naming the cached image file. |
  | Slash command | `system` / `local_command` lines (`<command-name>`, `<local-command-stdout>`) plus `isMeta` user lines. A typed `/context` never reaches the model. |
  | `/compact` | **Same file, same session id.** Adds `system` / `compact_boundary` (with token counts) and a `user` line flagged `isCompactSummary`. The "session ids rotate" guardrail is corrected accordingly. |
  | `/clear` | New session id and a new file. `SessionEnd` (`reason: "clear"`) fires on the old id; the first event on the new id is the next `UserPromptSubmit`. |
  | Write latency | A line lands only when its **whole block** is finished. A 5-second answer was on screen from 0.9 s and in the file at 5.65 s — about 0.1 s after its last word, 4.7 s after its first. User prompt: 0.3 s after Enter. Tool call: about 0.15 s **after** `PreToolUse`. Tool result: about 0.15 s after `PostToolUse`. The final text line landed 0.1 s **after** `Stop`, so `Stop` does not mean the file is complete. |

  **Hook payloads** — every event has `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `prompt_id`.

  | Event | What it carries |
  |---|---|
  | `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`. Bash: `command`, `description`. Edit: `file_path`, `old_string`, `new_string`, `replace_all`. |
  | `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions` (rule or mode changes such as `addRules`, `addDirectories`, `setMode`). **No `tool_use_id`** — take it from the `PreToolUse` just before it. The suggestions are **not** the TUI's option list (see below). |
  | `PreToolUse` / `PermissionRequest` for `AskUserQuestion` | The full `questions` array: `question`, `header`, `options[{label, description}]`, `multiSelect`. |
  | `PreToolUse` / `PermissionRequest` for `ExitPlanMode` | `plan` (full markdown) and `planFilePath`. |
  | `Notification` | Only `permission_prompt` was seen, 6 s after each `PermissionRequest`; `message` is "Claude needs your permission" or "Claude Code needs your approval for the plan". |
  | `PostToolUse` | `tool_response` (structured), `duration_ms`. For `AskUserQuestion` it includes `answers`. |
  | `PostToolUseFailure` | `error`, `is_interrupt`. Fires for a tool that ran and failed, **not** for a denial. |
  | `Stop` | `last_assistant_message`, `background_tasks`. |
  | `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`; stop adds `agent_transcript_path`. Tool events from inside a subagent carry `agent_id`. |
  | `PreCompact` / `PostCompact` | `trigger`; post adds `compact_summary`. |
  | `SessionStart` | **Never arrived** over the HTTP hook, at startup or after `/clear`. |
  | `PermissionDenied`, `StopFailure` | Not seen. |

  **What resolves a pending prompt**

  | You do | Hook | Transcript |
  |---|---|---|
  | Approve | `PostToolUse` (or `PostToolUseFailure`) then `PostToolBatch`, about 0.15 s later | `tool_result` line |
  | Choose "No" | **none** | `tool_result` with `toolDenialKind: "user-rejected"`, 0.16 s later |
  | Press Esc on the prompt | **none** | `user` text `[Request interrupted by user for tool use]` |
  | Interrupt a turn | **none** | `user` text `[Request interrupted by user]` |

  So T5 cannot clear a card from hooks alone: it must also watch the transcript for the
  matching `tool_use_id` result and the interruption line. Two tool calls issued in
  parallel still prompt one at a time (the second `PreToolUse` fires only after the first
  is answered), so one pending prompt per instance is the right model.

  **Answer keys (question 2)** — all verified by hand in the TUI:

  | Prompt | Keys |
  |---|---|
  | Permission | A digit selects that option **immediately**, no Enter. Enter takes the highlighted one (option 1). Esc cancels and ends the turn. |
  | Single question | Digit *n* answers immediately. |
  | Free text ("Type something") | Its digit (options + 1) moves the cursor there without submitting; then type, then Enter. |
  | Several questions | A digit answers the current question and advances to the next tab; the last tab is a review screen where `1` submits and `2` cancels. |
  | Multi-select | A digit toggles that option and stays; Tab moves on to the review screen. |
  | Plan approval | `1` "Yes, and use auto mode", `2` "Yes, manually approve edits", `3` "Tell Claude what to change" (free text). No "No" option; Esc cancels. |

  The TUI appends rows the hook does not list: "Type something" and "Chat about this" on
  questions. All of T5's "explicit fallbacks" therefore have a safe mapping.

  **Option-label source (question 1) — approved 2026-10-13, built in T5:**

  - **Questions:** hook-only. Labels come from the payload and the digit is the option's
    position, by construction.
  - **Permission and plan prompts:** read the terminal buffer (option 2), falling back to
    generic **Allow** = `1` / **Deny** = Esc (option 1) when parsing fails. Reason: the
    hook's `permission_suggestions` do not match what the TUI offers. A `mkdir` prompt
    showed four options (Yes / always allow this directory / switch to auto mode / No)
    while the hook listed two suggestions (`addDirectories`, `setMode: acceptEdits`); the
    option count, the wording and the position of "No" all vary (three options for edits,
    four for Bash), and the plan prompt's options depend on the user's default mode.
    The option rows are regular enough to parse: `❯ 1. Yes`, `  2. …` with indented
    continuation lines, at the bottom of the buffer.
  - **Answering through the hook response (option 3):** rejected, as planned.

  **Things found on the way** (not fixed here):

  - `approve` = Enter on a plan prompt selects "Yes, and **use auto mode**" on this
    machine (`defaultMode: auto`). The phone's Approve button does that today.
  - Choosing "No" on a permission prompt fires no hook, and the status reducer only
    leaves `needs_you` on `PostToolBatch` / `UserPromptSubmit` / `Stop`, so the card
    likely stays on "needs you" until the next prompt. Inferred from the reducer, not
    reproduced in the app.
  - After every `Stop`, a prompt-suggestion subagent runs: `SubagentStop` with
    `agent_type: ""` and sometimes a `PreToolUse` carrying `agent_id`, with **no**
    matching `SubagentStart`. The subagent counter is clamped at zero so it does not go
    negative, but it can undercount when a real subagent is running.
  - `~/.claude/settings.json` still has the debug build's hook entry (port 49010). With
    no debug build running, every Claude session prints "hook error … ECONNREFUSED
    127.0.0.1:49010" under each prompt and tool call.
  - R7 planned to wait for `SessionStart` before sending the first prompt; that event
    does not arrive, so R7 needs a different readiness signal.

#### Step T1 — Backend: transcript stream

- **Goal:** The frontend can read a session's transcript and follow it live.
- **Depends on:** T0.
- **Build:**
  - Extend `transcript/mod.rs` (reuse the `Tail` offset logic) with:
    - `transcript_read(instanceId, fromOffset, maxBytes)` → complete JSONL lines + the next
      offset. Paged, so a long session doesn't load in one call.
    - a per-instance follow: a `notify` watcher on the active transcript file (2 s poll as
      fallback) emitting `transcript-appended { instanceId, lines, offset }`.
  - Follow rotation: when a hook event reports a new `transcript_path` for an instance,
    switch the follow and emit `transcript-rotated { instanceId, reason }`.
  - Lines pass through as raw JSON; parsing into a view model happens once, in TS (T2), so
    desktop and phone share it.
  - Only follow transcripts that have a consumer (a transcript view open, or a remote
    client subscribed); the usage tailer is unchanged.
- **Key files:** `src-tauri/src/transcript/mod.rs`, `src-tauri/src/hooks/server.rs`
  (path hand-off), `src-tauri/src/lib.rs`, `src/ipc/transcript.ts`.
- **Done when:** a throwaway debug listener prints new lines within about a second of the
  file changing, across a `/clear`, with tests over the T0 fixtures.
- **As built (2026-10-13):** new module `src-tauri/src/transcript/stream.rs`; bindings in
  `src/ipc/transcript.ts`. The usage tailer is untouched.
  - **Commands:** `transcript_follow(instanceId)` → `{ sessionId, offset }` and
    `transcript_unfollow(instanceId)` (reference-counted, one thread per followed
    instance); `transcript_read(instanceId, fromOffset, maxBytes?)`; and, added to the
    plan, `transcript_read_back(instanceId, beforeOffset?, maxBytes?)` — T3's "render the
    last N turns, load earlier" needs to page from the end, which a forward-only read
    cannot do. Pages are `{ sessionId, lines, offset, nextOffset, end }`.
  - **Events:** `transcript-appended { instanceId, sessionId, lines, offset, nextOffset }`
    and `transcript-rotated { instanceId, sessionId, offset, reason }`, reason `clear` /
    `session` / `truncated`.
  - **Offsets** are byte offsets on line boundaries; nothing is read past the last
    newline, so a half-written line is never delivered. `transcript_follow` returns the
    offset the live stream continues from; everything before it is history for
    `transcript_read_back`. That is the whole contract for joining history to live lines.
  - **Which file:** the session id the PTY manager maps to the instance, plus the
    `transcript_path` its hook events report (hand-off in `hooks/server.rs`); with no hook
    yet (a resumed session) the file is found by session id. A hook-reported path is only
    accepted if it is a `.jsonl` under `~/.claude/projects` — the hook port is local HTTP,
    and without the check a forged event could aim the stream at any file.
  - **`/clear`, measured in the app:** `transcript-rotated` (`sessionId: null`) 0.1 s
    after the command, on `SessionEnd`; nothing more until the next prompt, because the
    new session reports no hook before then; then a second
    `transcript-rotated` with the new id and the new file streamed from its top, including
    the `/clear` lines. Consumers reset on each. A console respawned on another session
    rotates with reason `session`; onto a transcript larger than 256 KiB the stream starts
    at its end (`offset` > 0) and history is paged.
  - **Latency, measured in the app:** lines reached a webview listener 0.15–0.25 s after
    the timestamp inside them, using the `notify` watcher on the transcript's directory.
    The 2 s poll is the fallback and also what notices a session change no hook announced.
  - **Tests:** 8 in `stream.rs`, over the T0 fixtures — forward and backward paging
    reproduce the session line for line, appending it in arbitrary pieces delivers each
    line once, the `/clear` hand-over, truncation, and the path check.
  - **For T2 and R4:** a trivial one-word turn appends about 270 KB, almost all of it
    `attachment` lines (`prompt_snapshot` alone is 160 KB per prompt). They pass through
    raw as planned and T2 skips them, which is fine on the desktop. Before the phone
    follows a transcript (R4), drop `attachment` lines in the backend.
  - **Not covered:** a dormant console (no live PTY, no follow) has no transcript to
    read — reads resolve through the live session. T3 excludes dormant consoles anyway.

#### Step T2 — Transcript model + renderer (framework-free)

- **Goal:** One module turns JSONL lines into a conversation and renders it; usable from
  both the React app and the phone.
- **Depends on:** T1.
- **Build:**
  - `src/transcript/model.ts`: fold lines into ordered **items** — user prompt, assistant
    text, thinking, tool call (paired with its result by tool-use id), subagent group,
    compaction/clear divider, interruption marker. Idempotent on re-delivery; tolerant of
    unknown line types (render nothing, never throw).
  - `src/transcript/render.ts`: plain DOM rendering, no React, so the PWA can import the
    same code (R1). Markdown via `marked` + `DOMPurify`, styles from `theme/markdown.css`.
  - Tool cards, collapsed by default, one-line summary: `Bash` (command, exit state,
    output on expand), `Edit` / `Write` (path + a small diff on expand), `Read` / `Grep` /
    `Glob` (target only), subagent (description + final result), anything else (name +
    JSON on expand).
  - Thinking collapsed. Long outputs truncated with "show all".
  - Unit tests over the T0 fixtures.
- **Key files:** new `src/transcript/`.
- **Done when:** every T0 fixture renders without error and tool calls are paired with
  their results.
- **Out of scope:** the panel chrome, input, choice cards.
- **As built (2026-10-13):** `src/transcript/model.ts`, `src/transcript/render.ts`,
  `src/theme/transcript.css`. Checked by eye in the app webview against the fixtures.
  - **Model:** `createTranscript()` → `{ items, append(lines), prepend(lines), reset() }`.
    Items: `user`, `assistant`, `thinking`, `tool`, `command` (slash command with its
    output), `divider` (`compact` / `clear`), `interrupted`, `turn-end` (the turn's
    duration) and `notice`. Each has a stable `id` and a `rev` that goes up when it
    changes, which is what the renderer keys on.
  - **`prepend` was added to the plan's shape.** History is paged in from the end (T1's
    `transcript_read_back`), so an older page arrives after the lines that follow it — a
    tool result before its call. The model keeps the parsed conversation lines and
    re-folds them all on `prepend`; a result whose call is not loaded yet is held back
    rather than shown bare.
  - **Idempotent by `uuid`:** a line seen twice is ignored. Bookkeeping lines are dropped
    at parse, and `originalFile` is stripped from Edit results so a long session does not
    hold each edited file many times.
  - **Subagent group** is the `Agent` tool card: description, type, and the final report
    taken from the later `<task-notification>` line (matched by tool-use id), which is
    not shown as a user prompt. The subagent's own messages are in a separate file that
    T1 does not stream; `createTranscript({ sidechain: true })` folds such a file, for
    whoever adds that view.
  - **`/compact`** becomes one divider with the token counts and the carried summary
    (collapsed); the typed `/compact` prompt and the command's hook chatter are folded
    into it. **`/clear`** is a divider at the top of the new file.
  - **Renderer:** `renderItem(item)` and `createRenderer(container).update(items)`, plain
    DOM. `update` reuses every element whose item did not change and keeps a card open
    when its item updates (a running tool getting its result). Card bodies are built on
    first open. Output longer than 40 lines or 4000 characters is cut with "show all".
  - **Cards beyond the plan's list:** `AskUserQuestion` (options, the picked one marked)
    and `ExitPlanMode` (the plan as markdown). An `Edit` / `Write` still waiting for its
    result shows the change from its input, which T5 can use for the permission card.
  - **Untrusted content:** text goes in through `textContent`; markdown through `marked`
    + `DOMPurify` with `img`, `style` and `form` removed, so a rendered answer cannot
    fetch a remote image. Links get `target="_blank" rel="noopener noreferrer"`; **T3 must
    route link clicks to the OS opener**, the renderer does not handle clicks.
  - **Tests:** the frontend had no test runner. Added `vitest` + `jsdom` (dev
    dependencies) and `npm test`; 68 tests in `model.test.ts` and `render.test.ts` over
    the T0 fixtures, including page boundaries at arbitrary points and HTML injection.
  - **Not done:** syntax highlighting in code blocks; `!` shell lines are parsed from
    their documented tags but there is no fixture for them.

#### Step T3 — The view and the toggle

- **Goal:** Switch any Claude console between terminal and transcript at any moment.
- **Depends on:** T2.
- **Build:**
  - `TranscriptView.tsx` hosting the T2 renderer, mounted by `ConsolePanel` in place of
    `<Console>` when the instance's view mode is `"transcript"`. The pooled xterm is
    detached, not released (`detach`, never `release`), so the session and its scrollback
    are untouched.
  - Toggle: a button in the console `HeaderStrip` and a `toggleTranscriptView` command
    (keymap + command palette). Mode is per instance, persisted (prefs), and honoured in
    torn-off windows.
  - Shell consoles and dormant/error consoles have no toggle.
  - Behaviour: stick to bottom while at bottom; "jump to latest" when scrolled up; a
    working indicator driven by the live status; a divider on `/clear` / `/compact`.
  - Performance: render the last N turns, "load earlier" pages back through
    `transcript_read`. Do not render a 5 MB transcript in one pass.
  - Copy: a copy button per assistant message (raw markdown) and per code block; normal
    text selection copies clean, unwrapped text. Command: **copy last response**, which
    also works from the terminal view.
  - Find in view (Ctrl+F).
- **Key files:** `src/panels/ConsolePanel.tsx`, new `src/panels/TranscriptView.tsx`,
  `src/state/consoles.ts`, `src/keyboard/commands.ts`, `src/keyboard/keymap.ts`,
  `src/torn/TornWindow.tsx`.
- **Done when:** toggling mid-turn loses nothing in either direction; a copied multi-
  paragraph answer pastes without stray line breaks; a resumed session shows its history.
- **As built (2026-10-13):** `src/panels/TranscriptView.tsx`, `src/transcript/feed.ts`,
  `src/state/viewMode.ts`; checked in the debug app with a live session.
  - **Toggle:** a `transcript` / `terminal` button in the console header (labelled with
    the view it switches to) and the command `toggleTranscriptView`, **Ctrl+Shift+H**,
    remappable and in the palette. It acts on the console you last focused. Showing the
    transcript unmounts `<Console>`, which only detaches the pooled terminal.
  - **Mode** is per instance in `state/viewMode.ts` (not `consoles.ts`: torn-off windows
    have no consoles store), saved under the `transcriptView` pref, and broadcast as a
    `console-view-mode` event so the main window and a torn-off one stay in step.
  - **Who gets a toggle:** a running, local Claude console (`canShowTranscript`). Not
    dormant or failed consoles, not shells, and not remote (SSH) instances — their
    transcript is on the other machine. A console that is still spawning shows its
    terminal even in transcript mode, because mounting the terminal is what launches
    claude; it flips once the session is up.
  - **Feed** (`transcript/feed.ts`, framework-free, transport injected so R4 can reuse
    it): listens, takes the follow, then pages history backwards until about 60 items
    are loaded. "Load earlier" pages further (up to 24 pages a click, since one prompt
    writes a page of bookkeeping lines that show nothing). A rotation resets it; a page
    that arrives for the previous transcript is dropped.
  - **Scrolling:** follows the end only if you were at it when new lines arrived;
    otherwise "↓ latest" appears. Loading earlier keeps your place. The position is
    restored when a hidden dockview tab is shown again.
  - **Status line** under the last message: working (with the subagent count),
    compacting, or "needs you" with a button back to the terminal — answering there is
    still the only way until T5.
  - **`/clear`:** the view empties, then shows the "context cleared" divider and the new
    session from its first prompt. The old conversation is not kept on screen; it is a
    different file. `/compact` is a divider in place.
  - **Copy:** buttons live in the shared renderer (`render.ts`), so the phone gets them:
    one per assistant message (its markdown source) and one per code block. They carry
    no text of their own, so a selection never picks them up. **Copy last response** is
    `copyLastResponse`, **Ctrl+Shift+Y**; it reads the transcript directly, so it works
    from the terminal view, and confirms with a short notice (`util/flash.ts`).
  - **Find:** Ctrl+F while the view has focus. Matches are painted with the CSS Custom
    Highlight API, so the DOM is untouched. Limits: only text that is on screen (a
    collapsed card is not searched, and its body is not built until opened), only what
    is loaded, and no match across an inline-formatting boundary.
  - **Links** go through a new backend command `open_url`, which only accepts `http`,
    `https` and `mailto`. Anything else in rendered text does nothing.
  - **Torn-off windows** honour the mode and have the toggle and both chords. Their
    working indicator only reflects hook events that arrive after the window opened.
  - **Verified live:** toggled mid-turn both ways with the real chord (the answer
    arrived in the view; the terminal had the full turn on return); sent a prompt and
    `/clear` while the terminal was detached; a three-paragraph answer selected in the
    view copies as paragraphs with no line breaks inside them; resuming an 815 KB
    session showed its last 61 items with "load earlier" for the rest.
  - **Tests:** 12 more (`feed.test.ts`, copy buttons in `render.test.ts`), 80 in all;
    one Rust test for the link check.
  - **Known gaps:** a window closed or reloaded without unmounting leaves its follow
    reference behind (a thread polling every 2 s until the app exits). The saved mode of
    a deleted instance is never pruned from prefs. No right-click copy — the app blocks
    the context menu everywhere.

#### Step T4 — Prompt composer

- **Goal:** Send prompts from the transcript view without flipping to the terminal.
- **Depends on:** T3.
- **Build:**
  - A multi-line input docked at the bottom: Enter sends, Shift+Enter newline (the same
    behaviour C1 gives the terminal), draft kept per instance.
  - Send = `submitToTerminal` (bracketed paste + CR), the path the queue and templates
    already use. While the agent is working, sending goes to the existing prompt queue.
  - Interrupt button (existing `INTERRUPT_KEY` + `markInterrupted`).
  - Template insert from the existing library.
  - Slash commands: pass through as typed text. **Verify** that a pasted `/clear` or
    `/compact` behaves the same as a typed one; if a command needs the TUI's menu, show
    "open terminal" instead.
  - The composer is a drop target for D1.
- **Key files:** `src/panels/TranscriptView.tsx`, `src/state/queue.ts`,
  `src/panels/terminalPool.ts`.
- **Done when:** a full prompt → answer → follow-up loop works without leaving the view.
- **As built (2026-10-13):** `src/panels/PromptComposer.tsx`, `src/state/composer.ts`,
  `src/panels/promptDelivery.ts`; checked in the debug app with a live session.
  - **Composer:** a field under the transcript that grows with its text (to about nine
    lines, then scrolls). Enter sends, Shift+Enter is a line break. It has the keyboard
    whenever the view is shown or its panel is focused, and typing while the transcript
    text has focus (after selecting something) moves to it.
  - **Draft:** per instance in `state/composer.ts`, kept in `localStorage`, so it
    survives the toggle, a tab switch, tearing the console off, and a restart. Cleared
    on send.
  - **Sending** goes through one function, `sendOrQueue` (`promptDelivery.ts`), which
    the queue dialog now uses too: at rest it pastes and submits; while the agent is
    working, compacting or waiting on you it parks the prompt in the existing queue.
    The queued prompt shows above the field with **edit** (take it back) and
    **cancel**; the send button reads **queue**, or **replace queued** when one is
    already waiting (the queue still holds one prompt per instance).
  - **No terminal needed:** `submitPrompt` (`terminalPool.ts`) uses the pooled terminal
    when this window has one and otherwise writes the same bracketed-paste bytes to
    the PTY. Without this, a console docked back from its own window while showing the
    transcript, and a torn-off window opened straight into the transcript, had no
    terminal to paste into and the prompt was dropped. The queue's own delivery uses
    it as well. Escape characters are stripped from the text so it cannot end the
    paste early.
  - **Stop:** a button while the agent is working — `INTERRUPT_KEY` and
    `markInterrupted`, as on the rail card.
  - **Templates:** a **templates** button lists the library's templates (project
    first, then global); picking one inserts its body at the caret and selects the
    first `{0}` placeholder to type over. Creating and editing stay in the library.
    The library itself (Ctrl+Shift+P) now inserts into the composer, not the hidden
    terminal, when its target console is showing the transcript.
  - **Slash commands** pass through as typed. Verified: `/clear` and `/compact` sent
    from the composer behave as typed ones. Bare built-ins that answer inside the TUI
    (`/model`, `/resume`, `/config`, `/permissions`, `/mcp`, `/context`, … — the list
    is `TERMINAL_COMMANDS` in `state/composer.ts`) are sent and the console switches
    to the terminal with a short notice, instead of leaving a menu open where it
    can't be seen. With an argument (`/model opus`) they are sent as-is. The list is
    hand-kept: a new built-in with a menu has to be added to it.
  - **Drop target (D1):** the field carries `data-wb-composer="<instanceId>"`, and
    `insertIntoDraft(instanceId, text)` adds text from outside the component.
  - **Torn-off windows** have the composer. They run their own queue delivery and
    load the global templates (no active project there).
  - **Verified live:** prompt → answer → follow-up without leaving the view; a
    multi-line prompt; a follow-up queued mid-turn and sent when the turn ended; stop;
    `/compact`, `/clear` and a prompt after it; `/model` opening the terminal on its
    menu; a template inserted; a prompt sent from a torn-off window with no terminal,
    and again from the main window after docking back.
  - **Tests:** 15 more (`state/composer.test.ts`, `panels/promptDelivery.test.ts`), 95
    in all.
  - **Known gaps:** pressing stop does not send or drop a queued prompt — it stays
    until the next turn ends or you cancel it. A torn-off window only knows the agent
    is working from hook events that arrive after it opened, so a prompt sent there
    right after tearing off goes straight to Claude (which queues it itself). No
    recall of earlier prompts with the arrow keys. `!` shell mode and `#` memory
    prefixes were not tried from the composer. Drafts of deleted instances are never
    pruned from `localStorage`.

#### Step T5 — Choice cards for "needs you" (desktop)

- **Goal:** When the agent is waiting on you, the transcript view shows what it is asking
  and lets you pick an option there.
- **Depends on:** T0 (decision), T3.
- **Build:**
  - `src/state/pendingChoice.ts`: per instance, the current pending prompt, built from the
    hook stream — kind (`permission` / `question` / `plan`), tool name, `tool_input`,
    and the option list from the source chosen in T0. Cleared by the resolution events T0
    identified, and whenever the status engine leaves `needs_you`. Answering in the
    terminal must clear the card too.
  - Card content:
    - **Permission:** tool and a readable rendering of its input — the command for Bash,
      a diff for Edit/Write (reuse the T2 tool card), the URL for a fetch.
    - **Question (`AskUserQuestion`):** question text, each option's label and
      description.
    - **Plan (`ExitPlanMode`):** the plan rendered as markdown, plus the P1 "open plan"
      button.
  - Buttons: one per option, numbered. Choosing sends the mapped keystroke through the
    single mapping module. Number keys 1–9 work while the card has focus; Esc = deny.
  - **Fallbacks are explicit:** multi-question, multi-select, and free-text ("Other")
    prompts show the content plus an **Answer in terminal** button that flips the toggle,
    until T0's findings show a safe mapping. Unknown prompt kinds do the same.
  - After sending, the card shows "sent" and waits for the resolution event; if none
    arrives in a few seconds it offers the terminal instead of re-sending.
- **Key files:** new `src/state/pendingChoice.ts`, `src/state/remoteActions.ts` (mapping),
  `src/state/status.ts` (read only), `src/panels/TranscriptView.tsx`.
- **Done when:** a Bash permission, an edit permission, a single-select question and a
  plan approval can each be answered from the card, and answering any of them in the
  terminal clears the card.
- **Out of scope:** the phone (R5).
- **As built (2026-10-13):** `src/state/pendingChoice.ts`, `src/panels/ChoiceCard.tsx`;
  checked in the debug app against a live session in default permission mode.
  - **Store:** `state/pendingChoice.ts` follows the hook stream on its own
    subscription. `PermissionRequest` opens a prompt (it fires for tool permissions,
    `AskUserQuestion` and `ExitPlanMode` alike) with the kind, tool name, `tool_input`
    and the `tool_use_id` of the `PreToolUse` just before it. One prompt per instance.
  - **What closes it:** `PostToolUse` / `PostToolUseFailure` for that tool,
    `PostToolBatch`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`,
    `PermissionDenied`; the status engine leaving needs-you for any reason; and the
    transcript — the view hands the store the conversation it shows, and a result for
    the tool, or an interruption line newer than the prompt, closes it. That last one
    is the only signal for "No" and Esc, which fire no hook.
  - **Stuck "needs you" after a refusal (found in T0):** when the transcript shows the
    prompt was refused or dismissed, the store also moves the status to done
    (`markInterrupted`). This runs while the transcript view is on screen, or the next
    time it is shown; a console that stays on the terminal still holds "needs you"
    after "No" until the next prompt, as before.
  - **Option labels, as decided in T0:**
    - *Question:* from the hook payload; the digit is the option's position.
    - *Permission and plan:* read from the terminal screen. `readScreen`
      (`terminalPool.ts`) returns the visible rows and `parseOptionRows` takes the
      numbered rows of the prompt at the bottom. It is strict because the digit is what
      gets sent: rows must count up from 1 with no gap, one must carry the `❯` marker,
      and only a few hint lines may follow. A label the TUI wrapped is joined back.
      The card reads the screen a few times over 3.5 s, since the hook fires before
      the prompt is drawn.
    - *When the screen can't be read* (no terminal in this window, or no match): a
      permission prompt offers **Allow** = `1`; a plan shows its text and sends you to
      the terminal, because option 1 can mean "yes, and use auto mode".
  - **Keys** go through `answerChoice` in `state/remoteActions.ts`: a digit for an
    option, Esc to dismiss (which also marks the turn interrupted). R5 can call the
    same function.
  - **Card:** sits between the transcript and the composer, up to 60% of the view; a
    long plan scrolls inside it. Content is drawn by the transcript renderer
    (`renderPendingTool` in `transcript/render.ts`): the command and its description
    for Bash, the change for Edit / Write, the plan as markdown, the arguments for
    anything else — so tool input goes through the same sanitizing path. One numbered
    button per option, plus **answer in terminal** and **deny** / **cancel** (Esc).
  - **Keyboard:** 1–9 and Esc work while the card has focus. It takes focus when a
    prompt arrives only if focus was already in that console's view and the composer
    is empty; a half-written prompt keeps the keyboard. Other typing on the card goes
    to the composer. When the card closes, focus returns to the composer.
  - **Explicit fallbacks:** several questions, multi-select, and a question with no
    options show the question text and options and an **answer in terminal** button.
    T0 found key sequences for these, but they need several keys kept in step with
    the TUI; not built. An option that opens a text field ("Tell Claude what to
    change") sends its digit and switches to the terminal to type. "Type something" /
    "Chat about this" on a question are reached through **answer in terminal**.
  - **After sending:** the card shows "sent: <label>" with the buttons gone, and after
    4 s without the prompt closing offers **check the terminal**. It never re-sends.
  - **Scrolling fix in `TranscriptView`:** the card taking space from the list could
    knock a reader off the end of the conversation (a scroll event measured between
    the resize and its handler). The view now trusts the last known position across
    a resize.
  - **Torn-off windows** start the store too, but only see prompts that open after
    the window did; before that the status line's "answer in the terminal" link is
    what shows.
  - **Verified live:** a Bash permission answered with the `1` key; an edit refused
    with the **No** button (card closed, status went to done); an edit approved by
    click; an edit refused in the terminal while the terminal was shown, then the
    transcript shown again (no card, status done); a single-select question answered
    with the `2` key; a plan approved with "Yes, manually approve edits"; the edit
    prompt after it dismissed with Esc; a two-question prompt shown as a fallback,
    opened in the terminal and dismissed there; a card arriving while a draft was
    being typed (focus stayed in the composer); the view staying at the end when a
    card appears.
  - **Tests:** 17 more (`state/pendingChoice.test.ts`), 112 in all.
  - **Known gaps:** no **open plan** button (P1 is not built). The card was not run
    in a torn-off window or in a window with no terminal (the Allow-only fallback is
    covered by unit tests only). A prompt for a tool inside a subagent was not tried.
    An option's hint line is joined onto its label ("Tell Claude what to change
    shift+tab to approve with this feedback"). The phone's Approve button still sends
    Enter, which on a plan picks option 1 — left for R5.

---

### Track D — Drag to reference

#### Step D1 — Drag files from inside the app onto a console

- **Goal:** Drag a file onto a console to reference it for Claude.
- **Depends on:** nothing (T4 adds a second drop target later).
- **Build:**
  - Make rows draggable in the editor file tree, editor tabs, the Diff file list and the
    Git status list, with a custom MIME type (e.g. `application/x-workbench-path`)
    carrying absolute paths; multi-select drags carry several.
  - Drop targets: the terminal host and the transcript composer. Insert `@<path> ` per
    file — relative to the instance's working dir when inside it, absolute otherwise — via
    `pasteIntoTerminal` (no submit) or at the composer's caret.
  - **Verify** how Claude Code wants a path with spaces after `@` and encode accordingly.
  - dockview uses HTML5 drag and drop for panels: make sure the custom type doesn't
    trigger its dock overlays, and that panel drags don't trigger the file drop.
  - A drop highlight on the console while a file drag is over it.
- **Key files:** `src/panels/Editor/FileTree.tsx`, `src/panels/Editor/index.tsx`,
  `src/panels/Diff/index.tsx`, `src/panels/Git/rows.tsx`, `src/panels/terminalPool.ts`,
  `src/panels/Workspace.tsx`.
- **Done when:** dragging a file from the tree onto a console inserts a working reference
  and panel drag-to-dock still works.
- **As built (2026-10-13):**
  - `src/state/fileDrag.ts` holds the drag type (`application/x-workbench-path`, a JSON
    array of absolute paths) and the path rules; `src/panels/FileDropZone.tsx` is the
    drop target, wrapped around the body of a running console in `ConsolePanel.tsx`.
    The whole body is the target, not only the terminal host or the composer field: in
    the terminal view a drop is pasted into the TUI (not submitted), in the transcript
    view it goes to the composer's caret wherever on the view it was dropped.
  - **Sources:** file and folder rows of the editor tree, editor tabs, the Diff file
    list, Git status rows. Only the Git status list has a multi-selection: dragging a
    selected row carries the whole selection, dragging an unselected one carries that
    row. A deleted file is not draggable (Diff list) or is left out of the drag (Git).
  - **Path form, verified against Claude Code 2.1.296:** a path with a space has to be
    written `@"my notes/a b.md"`; relative paths with forward slashes and absolute
    Windows paths with backslashes both attach, quoted or not. Checked by submitting
    prompts with each form and seeing Claude read the files without a tool call.
  - **dockview:** a file drag raises no dock overlay over any panel, and a panel tab
    dragged over a console shows dockview's overlay and not the file highlight;
    docking a panel into the console's group still works. Nothing had to be configured
    — dockview only answers its own drags.
  - **Not accepted:** a console that is not running, and a remote (SSH) console — the
    paths are this machine's.
  - **Torn-off window:** the console there is a drop target too, writing absolute
    paths (that window does not know the working dir). Its drop handling was exercised
    with a scripted drop; a real drag carried from the main window to the torn-off one
    was **not** tried, so whether the custom type survives between windows is unknown.
  - Run in the app with real drags driven through the debugger: tree file, tree
    folder, editor tab, Diff row, Git row and Git selection, onto the terminal and
    onto the transcript view. Typecheck, lint and 123 frontend tests pass.

#### Step D2 — Drag files from the OS (spike, may be dropped)

- **Goal:** Decide whether Explorer → console drops are worth their cost.
- **Depends on:** D1.
- **Build:** with `dragDropEnabled: false` the webview gets no file paths; turning it on
  gives paths through Tauri's drag-drop event but disables HTML5 drag and drop on Windows,
  which dockview needs. Spike whether a second mechanism can supply paths without flipping
  that flag. If not, close this step as "won't do" and record why.
- **Done when:** either OS drops work with panel docking intact, or the step is closed.

---

### Track V — Diff / review

#### Step V1 — Diff rendering

- **Goal:** A diff that is comfortable to read.
- **Depends on:** nothing.
- **Build:**
  - Evaluate `@codemirror/merge` for the review panel: syntax highlighting, intra-line
    changes, collapsed unchanged regions, unified and side-by-side from one component, and
    an editable "after" side — which would fold today's separate edit mode into the diff.
    Needs a backend read of the base version (`git show <base>:<path>`), batched per file.
  - If it fits: unified / side-by-side toggle (persisted), line numbers, edit-in-place
    with Ctrl+S, and the "edit" mode goes away. If it doesn't, extend `UnifiedDiff` with
    line numbers + intra-line highlighting and keep the modes.
  - `UnifiedDiff` stays as is for the Git panel's hunk staging.
  - Remove the 4,000-line cap where the new view makes it unnecessary; keep a guard for
    pathological files.
- **Key files:** `src/panels/Diff/`, `src-tauri/src/git/mod.rs`, `src/ipc/git.ts`,
  `src/theme/codemirror.ts`.
- **Done when:** a TypeScript and a Rust file both show highlighted, intra-line diffs in
  both layouts, and a small edit can be saved without leaving the diff.

#### Step V2 — Navigation and freshness

- **Goal:** Move through a change set quickly and trust that it is current.
- **Depends on:** V1.
- **Build:** next/previous hunk and next/previous file keys (keymap + palette); a "viewed"
  check per file, reset when that file changes; auto-refresh from the existing git watcher
  (`git/watch.rs`), keeping selection and scroll; a `+N −M` total that updates live.
- **Done when:** the panel updates as the agent edits, without the refresh button, and the
  whole change set can be walked from the keyboard.

#### Step V3 — Inline comments sent to the agent

- **Goal:** Comment on lines in the diff and send the batch as the next prompt.
- **Depends on:** V1.
- **Build:**
  - Select a line or range → add comment. Pending comments are listed in the panel and
    marked in the gutter; editable and removable; kept per instance until sent.
  - **Send comments** builds one prompt — each comment as `path:line` (or range), a short
    quote of the code, and the note — and delivers it with `submitToTerminal` (queued if
    the agent is working).
  - **Add to prompt** from an editor or diff selection: inserts an `@path` reference with
    the line range into the console without sending.
  - Per-hunk **revert** in the review panel, reusing the Git panel's hunk patch machinery,
    behind the existing confirm.
- **Key files:** `src/panels/Diff/`, `src/panels/Editor/CodeMirrorView.tsx`,
  `src/panels/terminalPool.ts`, new `src/state/reviewComments.ts`.
- **Done when:** three comments across two files arrive as one readable prompt and the
  agent acts on the right lines.

---

### Track N — Notes

#### Step N1 — Project notes panel

- **Goal:** A notes tab per project: a list of notes, each edited like a file, shown as
  markdown.
- **Depends on:** nothing.
- **Decision to confirm at the start of the step — where notes live:**
  - *Recommended:* plain `.md` files in the app data dir, `notes/<projectId>/`. Private,
    survive branch switches and worktrees, never show up in `git status`. It is also the
    simpler choice for the phone (R8): one folder per project on this machine, the same
    for local and remote (SSH) projects.
  - *Alternative:* `<repo>/.workbench/notes/`. Travels with the repo and is directly
    readable by agents, but appears in git unless ignored and differs per worktree.
- **Build:**
  - New dockview panel type `notes`, bound to a project: note list on the left (create,
    rename, delete with confirm, filter), editor on the right.
  - Editing reuses `CodeMirrorView` with the markdown language, Ctrl+S and the dirty
    indicator; view modes reuse the editor's existing preview pane (edit / preview / split).
  - Notes are files, but they go through a small **notes module** in the backend
    (list, read, write, create, rename, delete), not the generic `fs` commands. The phone
    (R8) uses the same module from the remote server, so both sides share one set of
    rules: a note is named by project id and note id, never by a path.
  - Every read returns the note's revision (modified time and size, or a content hash),
    and every write says which revision it was based on. A write based on a stale
    revision is refused, so the desktop and the phone cannot silently overwrite each
    other. The backend emits `notes-changed { projectId }` after any change; the panel
    refreshes its list and reloads an open note that has no unsaved edits.
  - Open from the rail's project row, the command palette, and a keybinding. Layout
    presets must round-trip the new panel type.
  - **Send to agent:** insert the note's text (or an `@path`) into a chosen console.
- **Key files:** new `src/panels/Notes/`, new `src-tauri/src/notes/`, new
  `src/ipc/notes.ts`, `src/panels/Workspace.tsx` (`COMPONENTS`), `src/state/layout.ts`,
  `src/keyboard/commands.ts`.
- **Done when:** notes persist across restarts, render as markdown, and survive a layout
  preset switch.

#### Step N2 — Rendered-while-editing markdown (optional)

- **Goal:** Notes read as formatted text while you type, with markup shown only on the
  line being edited.
- **Depends on:** N1.
- **Build:** CodeMirror decorations for headings, emphasis, links, lists and code spans.
  Applies to notes first; offer it for `.md` files in the editor if it holds up.
- **Done when:** a note with headings, lists and code reads cleanly without a preview pane.

---

### Track R — Remote

#### Step R1 — Give the PWA a build

- **Goal:** The phone client can share code with the desktop frontend.
- **Depends on:** T2.
- **Build:**
  - Move the PWA to a second Vite entry (plain TS, no React) that imports
    `src/transcript/` and the choice-card rendering; output a single self-contained bundle
    the Rust server embeds.
  - Decide how the bundle reaches `include_str!` on a fresh clone (committed artifact vs
    a `build.rs` check with a clear error). Record the decision.
  - Behaviour parity with today's `index.html`: pairing, dashboard, usage meter, mirror.
  - Bump the service worker cache version on every build.
- **Key files:** `src-tauri/src/remote/pwa/`, `vite.config.ts`, `package.json`,
  `src-tauri/src/remote/server.rs`, `src-tauri/build.rs`.
- **Done when:** the phone works exactly as before, from the built bundle.
- **As built (2026-10-13):**
  - **Source** is `src/pwa/` — plain TypeScript and DOM, no React: `index.html`,
    `style.css`, `main.ts` (pairing, wiring), `net.ts` (token, sockets, actions),
    `dashboard.ts` (banner, usage meter, cards), `mirror.ts` (console mirror),
    `format.ts` (wording and ordering, unit-tested), `sw.js` (worker template).
    xterm now comes from `node_modules` (the same 5.5.0 that was vendored); the
    vendored copy and its two routes are gone.
  - **Build:** `npm run build:pwa` (`vite.pwa.config.js`, a second Vite config with
    no React plugin) writes `src-tauri/src/remote/pwa/dist/index.html` — script,
    styles and xterm inlined, ~308 kB / 79 kB gzip — and `dist/sw.js`. The manifest
    and icons stay where they were and are embedded as before.
  - **Decision (open question 8): the bundle is not committed.** `npm run dev` and
    `npm run build` build it first, and Tauri waits for those before compiling, so
    `tauri dev` / `tauri build` need nothing extra (checked: `tauri:dev` on a tree
    with no `dist/` built it and compiled). A bare `cargo build` / `cargo test` on a
    fresh clone is stopped by `build.rs` with "run `npm run build:pwa`". Chosen over
    a committed artifact because that would go stale silently and add ~300 kB to
    history on every change to shared code. Cost: editing `src/pwa/` while
    `tauri dev` runs needs `npm run build:pwa` and an app restart (the output is
    git-ignored, so Tauri's watcher does not see it).
  - **Service worker cache** is named after a hash of the shell (the page, manifest
    and icons) rather than a counter, so it changes on every build that changes
    anything and on no other — a deviation from "bump on every build", which would
    make every phone re-download an identical shell.
  - **Shared code:** the wire shapes now live in `src/remote/protocol.ts`
    (`RemoteSnapshot`, `RemoteInstance`, `RemoteAction`, `TermControl`), used by
    `RemoteMirror` (which builds the snapshot) and by the PWA (which reads it).
    `src/transcript/` is **not** in the bundle yet — nothing uses it until R4 — but a
    trial build importing `render.ts` and `model.ts` worked (+96 kB, no React or
    Tauri code pulled in). The choice cards are a React component
    (`panels/ChoiceCard.tsx`); R5 will need a framework-free renderer for them.
  - **Parity:** the old page and the built one were driven through one scripted
    scenario in a headless browser at phone size with a stubbed server (pairing
    refused / unreachable / accepted, two snapshots with a draft kept across a
    reorder, every action, the filter, the mirror with resize, keyboard, reconnect
    and not-running, offline, HTTP fallback, unpair). Layout, colours, text and
    every message sent were identical; the only difference is the worker's cache
    name and its shell list (no xterm files).
  - **Against the real server** (dev app, bound to loopback for the test only, since
    this machine has no Tailscale): paired with a real code, dashboard and usage
    meter live, mirror showed a running session and took keystrokes, a prompt sent
    from a card ran (working → done), the worker cached the shell and the page
    reloaded offline. Not tried on an actual phone.
  - Typecheck, lint, 131 frontend tests and 116 Rust tests pass.

#### Step R2 — Harden pairing and auth

- **Goal:** Safe enough to expose beyond the tailnet. Prerequisite for R3.
- **Depends on:** nothing.
- **Build:**
  - `/pair`: global attempt rate limit with lockout; longer codes; a code exists only
    after the user asks for one in the desktop UI.
  - **Desktop approval:** a new device must be confirmed in a desktop dialog before its
    token becomes valid.
  - Move the token out of WebSocket URLs (subprotocol header or first-message auth).
    Constant-time comparison. Check `Origin` on WebSocket upgrades.
  - Device list shows last seen + address; revoke stays one click. Optional token expiry
    after N days unused.
  - Log auth failures where the Remote Access menu can show them.
- **Key files:** `src-tauri/src/remote/mod.rs`, `src-tauri/src/remote/server.rs`,
  `src/panels/RemoteAccessMenu.tsx`, PWA client.
- **Done when:** a brute-force loop against `/pair` is locked out, no token appears in a
  URL, and an unapproved device gets nothing.

#### Step R3 — Tailscale Funnel: remote ready whenever the app runs

- **Goal:** Open a fixed HTTPS address on the phone, with no Tailscale on the phone.
- **Depends on:** R2.
- **Build:**
  - Listen on `127.0.0.1` as well as the tailnet address (Funnel proxies to localhost).
  - A **public access** switch in the Remote Access menu, off by default, with a plain
    statement of what it exposes. When on, Workbench runs `tailscale funnel` for the port
    on startup and reports the `https://<machine>.<tailnet>.ts.net` address (with a QR
    code); when off, it removes the funnel.
  - Detect and explain the one-time prerequisites instead of failing silently: Tailscale
    installed and logged in, HTTPS certificates and the Funnel attribute enabled for the
    tailnet. Funnel only serves a few public ports — pick one and say which.
  - Handle the tailscale CLI being absent, the funnel already existing, and a second
    Workbench build (dev vs release ports).
  - Tailnet-only mode keeps working unchanged.
- **Key files:** `src-tauri/src/remote/mod.rs`, `src/panels/RemoteAccessMenu.tsx`,
  `src/state/remoteServer.ts`.
- **Done when:** with the phone on mobile data and Tailscale off, the dashboard loads over
  HTTPS after a desktop restart with no manual step.

#### Step R4 — Phone: transcript view and prompt-first input

- **Goal:** Reading and writing on the phone feels like a chat, not a shrunken terminal.
- **Depends on:** R1, T1.
- **Build:**
  - Server: a transcript endpoint (WebSocket: history page on connect, then appended
    lines, plus rotation notices), fed by T1.
  - Phone console view defaults to **transcript**, with the same toggle to the mirrored
    terminal.
  - A sticky composer: multi-line, send button, dictation via the phone keyboard. Sends
    the existing `prompt` action.
  - In the mirror view, a quick-key row (Esc, ↑, ↓, Tab, Shift+Tab, Enter, 1–4) so raw
    keyboard mode is rarely needed.
  - Reconnect resumes from the last offset instead of reloading the history.
- **Key files:** `src-tauri/src/remote/server.rs`, PWA sources, `src/transcript/`.
- **Done when:** a full prompt → read answer → follow-up loop is comfortable one-handed.

#### Step R5 — Phone: choice cards

- **Goal:** Answer "needs you" prompts on the phone with the real options.
- **Depends on:** T5, R4.
- **Build:**
  - Include the pending choice (kind, content, options) in the snapshot the webview
    already pushes (`RemoteMirror.tsx`), so the phone needs no logic of its own.
  - A new remote action `choose { instanceId, option }`, handled in
    `state/remoteActions.ts` by the same mapping T5 uses. Approve / deny remain as the
    fallback.
  - Card on the dashboard (compact) and in the transcript view (full), same fallbacks as
    T5 ("answer in terminal" opens the mirror).
  - Guard against stale taps: the action carries the prompt's id and is ignored if that
    prompt is no longer pending.
- **Key files:** `src/panels/RemoteMirror.tsx`, `src/state/remoteActions.ts`,
  `src/ipc/remote.ts`, PWA sources.
- **Done when:** a multi-option question can be answered from the phone and a tap on an
  already-resolved prompt does nothing.

#### Step R6 — Push notifications

- **Goal:** The phone is told when an agent needs you, with the page closed.
- **Depends on:** R3 (web push needs HTTPS).
- **Build:** VAPID keys generated and stored on the desktop; subscribe from the PWA after
  pairing; the desktop sends a push on the transitions that already raise an OS toast
  (needs-you, escalation); tapping opens that instance. Per-device mute. Note the platform
  limits found (e.g. install-to-home-screen requirements) in As built.
- **Key files:** `src-tauri/src/remote/`, `src-tauri/src/attention.rs`, PWA service worker.
- **Done when:** a needs-you transition reaches a locked phone.

#### Step R7 — Phone: create a session

- **Goal:** Start a new Claude session from the phone, in an existing project, optionally
  with its first prompt. Today the phone can only start, stop and prompt instances that
  already exist (`remoteActions.ts`: `start` resolves an instance from the registry).
- **Depends on:** R1 (so the form is written once, in the built PWA, not in the
  hand-written `index.html` that R1 replaces).
- **Build:**
  - **Snapshot:** add the project list (id, name, group, remote flag) to the snapshot
    `RemoteMirror.tsx` already pushes — it currently carries only each instance's
    `projectId` / `projectName`.
  - **Action:** a new remote action `create { requestId, projectId, title?, text? }`,
    handled in `state/remoteActions.ts`: `addInstance` (`state/registry.ts`) →
    `openConsole` → if `text` is present, submit it once the TUI is ready. "Ready" must
    be an explicit signal, not a timer; `submitToTerminal` returning `false` is not
    enough, since the terminal exists before the prompt box does. T0 found that the
    `SessionStart` hook never arrives, so the signal has to be something else — pick it
    when building this step (candidates: the transcript file appearing, or the prompt box
    showing in the terminal buffer). If the signal doesn't arrive, the prompt is kept as the
    instance's queued prompt rather than dropped.
  - **Idempotent:** the desktop remembers recent `requestId`s, so a retried tap or a
    reconnect replay never creates a second instance. The created instance's id is
    reported back against the `requestId` in the next snapshot, so the phone can open it.
  - **Phone UI:** a **new session** button on the dashboard and on each project group →
    project picker (skipped when started from a project) → optional title and first
    prompt → the phone opens the new instance as soon as it appears. The created console
    opens on the desktop exactly as a rail-launched one does.
  - **Title:** when omitted, use the same default the desktop launcher uses.
  - **Worktree (optional):** an "isolate in a worktree" switch reusing
    `provisionWorktree` (`state/worktree.ts`); report a provisioning failure on the phone
    instead of leaving a half-created instance.
  - Remote (SSH) projects go through the same path as on the desktop; if one needs an
    interactive password, say so on the phone and point at the mirror.
- **Key files:** `src/state/remoteActions.ts`, `src/ipc/remote.ts`,
  `src/panels/RemoteMirror.tsx`, `src/state/registry.ts`, PWA sources,
  `src-tauri/src/remote/server.rs` (only if the action allow-list lives there).
- **Done when:** from the phone, a new session in a chosen project starts, receives its
  first prompt, and shows up on both phone and desktop; a double tap creates one session.
- **Out of scope:** creating projects, or sessions at an arbitrary path — the phone only
  ever names an existing project id, never a filesystem path. Resuming a past session
  from the phone.

#### Step R8 — Phone: project notes

- **Goal:** Read and write a project's notes from the phone, wherever you are, as long as
  the desktop app is running. A thought about a project can be written down without a
  session and without being at the desk.
- **Depends on:** N1 (the notes module and its revision rule), R1 (the built PWA). Uses
  the project list R7 adds to the snapshot; if R7 has not landed, add it here.
- **Build:**
  - **Server:** authenticated endpoints in `remote/server.rs` that call the N1 notes
    module directly in Rust — list a project's notes, read one, create, save, rename,
    delete. They do not round-trip through the desktop webview, so they work while the
    window is minimised or showing another project.
  - **Naming:** the phone sends a project id and a note id only. The server checks the
    project exists and that the note id is a plain file name (no separators, no `..`)
    before touching the disk. A size cap per note keeps a bad client from filling it.
  - **Conflicts:** saves carry the revision they were based on (N1). When the note
    changed in the meantime, the phone keeps the typed text, shows both versions, and
    offers "keep mine as a new note" — nothing is overwritten without being seen.
  - **Live updates:** note changes are pushed over the existing WebSocket, so a note
    edited on the desktop updates on the phone, and the desktop panel picks up phone
    edits through `notes-changed`.
  - **Phone UI:** a **notes** entry on each project in the dashboard (with a count) →
    the note list (newest first, filter, **new note**) → the note. A note opens rendered
    as markdown, through the shared sanitised renderer; **edit** switches to a plain
    multi-line field that suits the phone keyboard and dictation. Saves on an explicit
    button and when leaving the note; an unsent edit is kept on the device and offered
    again after a reconnect.
  - **Quick capture:** "new note" needs only text; the title defaults to the first line.
  - **Send to agent (optional):** from a note, "send to…" an instance of that project,
    using the existing `prompt` action.
- **Guardrail:** notes are private text. They are served only to a paired client, and
  over Funnel only once R2 has landed — the same rule as every other remote feature.
- **Key files:** `src-tauri/src/remote/server.rs`, `src-tauri/src/notes/`, PWA sources,
  `src/panels/RemoteMirror.tsx` (project list, note counts).
- **Done when:** a note written on the phone appears in the desktop panel without a
  restart and the other way round; editing the same note on both sides loses neither
  version; a request for a note outside the project's notes folder is refused.
- **Out of scope:** offline editing while the desktop app is not running; attachments
  and images; notes that are not tied to a project.

---

### Track P — Plans

#### Step P1 — Open plan on demand

- **Goal:** Read a plan as a proper document when you want to — never automatically.
- **Depends on:** T2 (plan detection in the transcript model).
- **Build:** when the session's transcript contains a plan (`ExitPlanMode` input, per the
  T0 fixtures), show an **open plan** button in the console header and on the plan's card
  in the transcript view and choice card. It opens the plan in a markdown preview tab
  (read-only; "save as note" once N1 exists). Latest plan by default, earlier ones from a
  small menu.
- **Done when:** a plan can be opened beside the console from either view, and nothing
  opens on its own.

---

### Track A — Agent review

#### Step A1 — Review with a fresh agent

- **Goal:** One action gets an independent review of an instance's changes.
- **Depends on:** V3.
- **Build:** from the Diff panel, start a second instance in the same working dir with an
  editable review prompt scoped to the diff vs base; its findings come back as a list you
  tick, and the ticked ones are sent to the implementing instance through the V3 comment
  path. The review prompt is stored per project.
- **Done when:** a review round trip works end to end without copy-paste.

---

### Track M — Mods

#### Step M1 — Run summary on done (exploratory)

- **Goal:** See what a turn changed (`+N −M`, files) the moment it finishes.
- **Depends on:** nothing.
- **Build:** try it as a Claude Code mod (a Stop hook or status-line segment). Workbench
  already installs a managed status line for the usage meter (`src-tauri/src/statusline/`),
  so the two must be chained, not replaced. Note which other items from this plan would
  fit the same route.
- **Done when:** the summary shows after a turn, and the usage meter still works.

---

## Sequencing

```
C1 ─ C2 ─ C3
T0 ─ T1 ─ T2 ─ T3 ─ T4
               └─ T5 ──────────┐
D1 (─ D2)                      │
V1 ─ V2                        │
   └ V3 ─ A1                   │
N1 (─ N2)                      │
N1 ─ R8 (also needs R1)        │
R2 ─ R3 ─ R6                   │
T2 ─ R1 ─ R4 ─────────────── R5
     └ R7
T2 ─ P1
M1
```

Suggested order: **C1 → T0 → T1 → T2 → T3 → T4 → T5 → C2 → C3 → D1 → R1 → R7 → R2 → R3 → R4 →
R5 → V1 → V2 → V3 → N1 → R8 → P1 → R6 → A1**, with M1, N2 and D2 whenever convenient.

C2/C3 sit after the transcript view on purpose: once T3 exists there is a clean way to read
any session, which lowers the urgency and makes the terminal bugs easier to compare against.

---

## Open questions

| # | Question | Resolved in |
|---|---|---|
| 1 | Option-label source for permission prompts — **recommended:** hook-only for questions, terminal buffer for permission and plan prompts; awaiting approval | T0 |
| 2 | Exact answer keys for each prompt kind — **digits select directly**; table in T0 As built | T0 |
| 3 | Where subagent messages live — **a separate file**, `<session-id>/subagents/agent-<id>.jsonl` | T0 |
| 4 | Shift+Enter byte sequence — **`\x1b\r`** (verified on 2.1.296) | C1 |
| 5 | Path-with-spaces syntax after `@` | D1 |
| 6 | `@codemirror/merge` vs extending `UnifiedDiff` | V1 |
| 7 | Notes storage location (the phone, R8, reads the same store) | N1 |
| 8 | How the PWA bundle is embedded on a fresh clone — **built, not committed**; `build.rs` says what to run | R1 |

---

## Progress tracker

| Step | Title | Status |
|---|---|---|
| C1 | Shift+Enter + scrollback | ☑ |
| C2 | Blank / garbled consoles | ☑ |
| C3 | Overwritten output | ☑ |
| T0 | Spike: transcript + hook payloads | ☑ (label-source decision awaiting approval) |
| T1 | Backend transcript stream | ☑ |
| T2 | Transcript model + renderer | ☑ |
| T3 | View + toggle | ☑ |
| T4 | Prompt composer | ☑ |
| T5 | Choice cards (desktop) | ☑ |
| D1 | Drag files from inside the app | ☑ |
| D2 | Drag files from the OS (spike) | ☐ |
| V1 | Diff rendering | ☐ |
| V2 | Diff navigation + freshness | ☐ |
| V3 | Inline comments to the agent | ☐ |
| N1 | Project notes panel | ☐ |
| N2 | Rendered-while-editing markdown | ☐ |
| R1 | PWA build | ☑ |
| R2 | Pairing / auth hardening | ☐ |
| R3 | Tailscale Funnel | ☐ |
| R4 | Phone transcript + composer | ☐ |
| R5 | Phone choice cards | ☐ |
| R6 | Push notifications | ☐ |
| R7 | Phone: create a session | ☐ |
| R8 | Phone: project notes | ☐ |
| P1 | Open plan on demand | ☐ |
| A1 | Review with a fresh agent | ☐ |
| M1 | Run summary on done (mod) | ☐ |
