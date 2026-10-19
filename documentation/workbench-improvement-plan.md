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
- **As built (2026-10-14):** OS drops work on Windows; `dragDropEnabled` stays off.
  - **Route:** WebView2's `chrome.webview.postMessageWithAdditionalObjects`.
    - The console's drop zone posts the dropped `File` objects with a token.
    - The host gets each as an `ICoreWebView2File` and reads its `Path`.
    - It emits `file-drop-paths` `{ token, paths }`, and the zone writes the usual
      references (`src-tauri/src/filedrop.rs`, `src/ipc/osDrop.ts`).
  - **The message must be a string.** wry's IPC handler is registered first and
    fails on any other message. A failing handler stops WebView2 from calling the
    handlers after it, so a message sent as an object never arrived (found live).
    Tauri's IPC also reads the string, finds no command and logs one console
    error per drop.
  - **Installed by a small plugin** (`on_webview_ready`), so torn-off console
    windows get it too. Those windows now also open with `dragDropEnabled: false`.
  - **Files outside the working directory** keep their full path, quoted when it
    has spaces, the same as D1. Folders come through too.
  - **A file dropped outside a console** is swallowed (`blockStrayDrops` in
    `main.tsx`), so the webview can't open it in place of the app.
  - **Linux / macOS:** no equivalent route, so an OS drop does nothing there.
  - **Checked live** (dev app, a scratch project):
    - One file, then two files and a folder at once (names with spaces, outside
      the session's directory), dragged from Explorer onto a running console.
    - Claude Code resolved all three references: it read both files and listed
      the folder.
    - A stray drop on the rail left the app as it was.
    - A torn-off window wasn't tried.

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
- **As built (2026-10-14):** `@codemirror/merge` 6.12.2 fits, so the review panel uses
  it and the edit mode is gone (open question 6). New `src/panels/Diff/MergeDiff.tsx`
  and `src/state/diffLayout.ts`. Checked in headless Edge with real file versions, and
  in the dev app on this repo's own uncommitted changes.
  - **Backend:** `instance_file_versions(workingDir, base, path, untracked)` in
    `git/mod.rs` returns both sides of one file in one call: `original` from
    `git show <base>:<path>` (null when the file isn't in the base) and `current` from
    disk (null when deleted). It also reports `binary` (a NUL byte or non-UTF-8 on
    either side), `tooLarge` (either side over 2 MiB) and `crlf`. Binary detection
    needed git's raw bytes, so `run::Output` gained `raw`. Tested by extending the
    end-to-end diff test.
  - **View:** `MergeDiff` builds `unifiedMergeView` (unified) or `MergeView` (side by
    side, base read-only on the left). Both have line numbers, the file's syntax
    highlighting (including deleted lines), changed words marked inside changed lines,
    a change gutter, and unchanged runs collapsed to 3 lines of context (click to
    expand). Colours come from the theme tokens via a new `diffTheme()` in
    `theme/codemirror.ts`: removed in `needs`, added in `done`, as in the Git panel.
    Theme switches reconfigure the views in place.
  - **Layout toggle:** *unified* / *side by side* in the file bar, persisted as the
    `diffLayout` pref and shared by every review panel. Switching keeps unsaved edits
    (the view is rebuilt from the buffer) but not undo history.
  - **Edit in place:** the working-tree side is the editor. Ctrl+S or *save* writes
    the file, keeping CRLF line ends when the file had them (CodeMirror works in
    `\n`), then refreshes the file list's counts. The file isn't re-read after a save,
    so the cursor and scroll stay put. The bar shows "● unsaved" while dirty. A
    deleted file is read-only. *Refresh* re-reads the selected file only when it has
    no unsaved edits.
  - **Guards:** files over 2 MiB fall back to `UnifiedDiff` with git's diff, which
    keeps its 4,000-line cap. The merge view itself has no line cap: it renders only
    what is on screen, and its diff gives up refining after 1.5 s
    (`diffConfig.timeout`). A file whose versions differ only in line ends or mode
    says so instead of showing an empty diff.
  - `UnifiedDiff` is unchanged for the Git panel's hunk staging and history.
  - **Checked live:**
    - A TS file (`remoteActions.ts` between R4 and R5; this step's `Diff/index.tsx`)
      and a Rust file (`git/mod.rs`, 3,700 lines) in both layouts. Highlighting, word
      marks, collapsed runs and line numbers were all present; each rendered in under
      1 s, with no console errors.
    - An edit plus Ctrl+S on a CRLF file in the dev app: it saved with CRLF intact,
      showed "✓ saved", and the panel stayed on the diff.
  - **Not done:** switching files with unsaved edits still drops them without asking
    (as the old edit mode did). The pure-insertion chunks mark every word as changed,
    which reads heavier than a line tint alone.

#### Step V2 — Navigation and freshness

- **Goal:** Move through a change set quickly and trust that it is current.
- **Depends on:** V1.
- **Build:** next/previous hunk and next/previous file keys (keymap + palette); a "viewed"
  check per file, reset when that file changes; auto-refresh from the existing git watcher
  (`git/watch.rs`), keeping selection and scroll; a `+N −M` total that updates live.
- **Done when:** the panel updates as the agent edits, without the refresh button, and the
  whole change set can be walked from the keyboard.
- **As built (2026-10-14):** new `src/state/diffViewed.ts` and
  `src/panels/Diff/mergeNav.ts` (both unit-tested). Checked live in the dev app on this
  repo, with files written from outside the app as an agent would.
  - **Keys** (global, remappable, in the palette; they act on the last active review
    panel and bring it forward):
    - **Ctrl+Alt+↓ / ↑:** next / previous change. Past a file's last change it moves
      to the next file's first change, and back to the previous file's last change,
      so one key walks the whole change set.
    - **Ctrl+Alt+PgDn / PgUp:** next / previous file.
    - **Ctrl+Alt+Enter:** toggles "viewed".
    - Why Ctrl+Alt: CodeMirror owns Alt+arrows (move line) and Shift+Alt+arrows
      (copy line), and the terminal and the TUI use none of these.
    - CodeMirror's own chunk commands wrap around, so `stepChange` is its own. A key
      pressed while the next file is still loading waits instead of skipping that
      file (keys repeat faster than a file loads).
  - **Viewed:** a checkbox per file in the list, and "n/m viewed" in the header.
    `DiffFile` gained a `stamp`, set only by `instance_diff`: the file's size and
    modification time plus its counts. A mark remembers the stamp; once it moves, the
    file counts as not viewed again. Marks live in memory per review panel, so a
    restart forgets them.
  - **Auto-refresh:** the panel starts the G8 repo watcher on its working dir (shared
    and reference-counted with the Git panel). Any change re-reads the file list
    after 300 ms of quiet, one read at a time. The totals and per-file counts update
    live. A file the agent creates or deletes appears or goes away.
  - **The open file updates in place:** when its stamp moves, its two versions are
    re-read. The editor is patched with the single replacement that differs
    (`textPatch`), so the cursor and the visible lines stay put. The base side gets
    the same (`updateOriginalDoc` in unified). The patch is kept out of undo history.
  - **Unsaved edits are never overwritten:** if the file changes on disk while it
    has unsaved edits here, the edits stay, and the bar says "changed on disk —
    saving overwrites that".
  - **Small fixes:**
    - The header wraps in a narrow panel instead of overlapping the refresh button.
    - `forgetScroll` (in `scrollMemory.ts`) stops a remembered scroll offset from
      undoing a jump to a change.
  - **Checked live:**
    - Twelve presses of Ctrl+Alt+↓ walked through four files' changes into the
      fifth; Ctrl+Alt+PgUp went back. Both layouts.
    - A file created outside the app appeared in the list. Marking it viewed showed
      1/11. Editing it on disk cleared the mark and updated the open view.
    - A line added at the top of a 734-line file left the view on the same text.
    - With unsaved edits, an outside change kept them and showed the warning.
  - **Not done:** viewed marks aren't persisted across restarts. The watcher also
    fires for ignored folders (a build writing to `target/`), which costs a list
    re-read every 750 ms or so while that runs, and nothing else.

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
- **As built (2026-10-14):**
  - **Comments:** a gutter on the working-tree side shows "+" on hover. A click
    comments that line, or the selection when the click is inside it. The
    "+ comment" button and **Ctrl+Shift+O** comment the selected lines. The draft
    opens under the diff with the quoted code; Ctrl+Enter adds it, Esc cancels.
  - **The list** sits under the diff for all files. Each entry shows `path:line` (a
    click goes there, opening the file if needed) and the note (click or "edit" to
    change it; emptying a note removes it; × removes it). Commented lines get a dot
    in the gutter and a tint, and the file list shows a count per file.
  - **Store:** `state/reviewComments.ts`, in memory, per instance. Comments survive
    closing the panel or relaunching the console, and are dropped once sent.
  - **Lines follow edits:** in the editor (`Diff/commentMarks.ts`) a comment is a
    document range. Typing, an agent's change arriving through the refresh, or a
    revert move it, and the new lines go back to the store. If a comment's lines are
    deleted whole, it stays on the line left where they were.
  - **Send** builds one prompt (`buildCommentsPrompt`): a header saying the line
    numbers are in the files as they are now, then per comment `path:line` or
    `path:a-b`, up to three quoted lines (shared indent removed, each cut at 120
    characters, then "… (n more)"), and the note. It goes through `sendOrQueue`: sent
    now if the agent is between turns, queued otherwise. The queue holds one prompt,
    so a prompt already waiting is kept ahead of the comments. Send is off while the
    session has no running console in this window. The palette has
    `diffSendComments`; it has no default key.
  - **Add to prompt** (`panels/consoleInput.ts`) puts `@path#L12` or `@path#L12-14`
    in the console unsent: pasted into the terminal, or into the composer when the
    console shows its transcript. The console is brought forward. In the diff it
    goes to the panel's own instance. In the editor (footer button) it goes to the
    project's last focused running Claude console. **Ctrl+Shift+B** does it for
    whichever of the two is the active panel.
  - **Keys:** Ctrl+Shift letters, because Ctrl+Alt+letter types a character on
    AltGr layouts and Alt+letter is the terminal's Meta. O and B aren't used by the
    terminal, the TUI or CodeMirror's default keys.
  - **Revert, not through git patches:** each change has a revert button: "↶ revert"
    at the change in unified view, "↶" in the gap between the sides. A confirm asks
    first. Then the base's lines go back into the buffer and the file is saved.
    - Why not the plan's hunk patches: git's hunks (three lines of context) don't
      line up with the merge view's changes, and the view already holds both texts.
    - This way it's an ordinary edit: Ctrl+Z undoes it while the file stays open.
    - If the file changed while the confirm was open, nothing is reverted, and the
      bar says so.
    - Side by side, the library reverts on its own mousedown; the panel takes that
      press first.
    - A deleted file has no revert, since there is nothing on disk to edit.
  - **Checked live** (a scratch git repo with two changed files, a real Claude
    session):
    - Three comments: one line and one range in `calc.py`, one line in `greet.py`.
    - They arrived as one prompt; the agent changed exactly those three places.
    - The panel's list and counts followed the agent's edits.
    - "@ to prompt" from the diff gave `@src/calc.py#L17-19`, and from the editor
      `@src/calc.py#L13-14`, both unsent.
    - Revert in unified and side by side: the confirm, then the file back at its base
      text, saved, with the counts updated.
    - The keys couldn't be pressed by the test driver (SendKeys doesn't reach the
      existing Ctrl+Shift+D either); the palette lists the commands with them.
  - **Not done:** a comment on a removed line (unified view) isn't possible; comments
    go on the working tree, the file the agent will open.

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
- **As built (2026-10-14):**
  - **Where:** the recommended option, confirmed: `<app data>/notes/<projectId>/<name>.md`
    (`notes.dev/` for a debug build, like the database). Removing a project closes
    its notes panel but leaves the files.
  - **Backend** `src-tauri/src/notes/`: `notes_list`, `notes_read`, `notes_write`,
    `notes_create`, `notes_rename`, `notes_delete`.
    - The note id is the file's stem, which is also its name in the list. Names are
      checked so they can never leave the folder: no separators or characters
      Windows forbids, no leading or trailing dot or space, no reserved device names,
      at most 120 characters. Project ids must be UUID-like.
    - The revision is an FNV-1a hash of the bytes: the same for the same text in any
      process, with no mtime granularity issues.
    - A write names its base revision. A changed or deleted note refuses it with an
      error starting `stale:`; a null base overwrites. One lock covers check and
      write, and the write goes through a temp file and a rename.
    - Every change emits `notes-changed { projectId }`. The file operations take the
      root as a parameter so R8's remote server can call the same rules.
  - **Frontend:** `ipc/notes.ts`; `state/notes.ts` holds the panels (one per project,
    `notes:<projectId>`, with the open note) and the open notes' buffers, so
    unsaved text survives a project swap. Panel `panels/Notes/`:
    - On the left: the list (newest first), "+ new" (asks for the name first,
      proposing "untitled", "untitled 2", …), ✎ or double-click to rename, × to
      delete behind a confirm, and a filter once there are more than four.
    - On the right: `CodeMirrorView` with markdown; edit, split or preview with the
      editor's `PreviewPane`; Ctrl+S and the unsaved mark.
    - A refused save shows "changed elsewhere" with **reload** (drops your edits) or
      **overwrite**. On `notes-changed` the list re-reads, and the open note
      reloads unless it has unsaved edits (then the same banner).
    - **To agent:** "⏎ text to agent" puts the note's text, and "@ to agent" an
      `@path` to its file, in the project's last focused Claude console, unsent
      (`consoleInput.ts` from V3).
  - **Opening:** the rail's project menu ("notes", for SSH projects too, since notes
    are local), the palette, and **Ctrl+Shift+J**.
  - **Layouts:** a `notes` component and `notes` descriptors in the saved layout and
    in presets, defaulting to `[]` for older ones (no schema bump, like `gits`).
    Picking another note changes no dock geometry, so the workspace also saves when
    the notes store changes; without that the open note was lost on restart.
  - **Name fields** commit on Enter or on a click elsewhere in the app, but not when
    the window loses focus (alt-tab). The field still has the keyboard when the
    window comes back.
  - **Checked live** (dev app, workbench project):
    - Created and renamed a note; wrote markdown, saved, and the split view rendered
      it.
    - Changed the file on disk behind the app, then saved: refused with the banner;
      reload brought the outside text in.
    - After a restart, the panel came back with the same note open.
    - Applied another preset and back; and with the notes panel closed, applying a
      preset that had it restored it with its note.
    - Send to agent wasn't run (no live session in that project); it uses V3's
      checked path.

#### Step N2 — Rendered-while-editing markdown (optional)

- **Goal:** Notes read as formatted text while you type, with markup shown only on the
  line being edited.
- **Depends on:** N1.
- **Build:** CodeMirror decorations for headings, emphasis, links, lists and code spans.
  Applies to notes first; offer it for `.md` files in the editor if it holds up.
- **Done when:** a note with headings, lists and code reads cleanly without a preview pane.
- **As built (2026-10-14):**
  - **`src/panels/Editor/livePreview.ts`:** a view plugin that decorates from the
    markdown syntax tree, over the visible ranges only.
    - Styled: headings (sized), bold, italic, strikethrough, inline code, links and
      autolinks, bullets, task boxes, quotes, fenced and indented code, rules.
    - Markup is hidden except on the lines a selection touches. With the editor
      unfocused, every line reads rendered.
    - A task box ticks on click. Ctrl/Cmd+click opens an http(s) link.
    - Tables and images stay as source.
  - **Markdown is GFM now** (`markdown({ base: markdownLanguage })` in `language.ts`),
    for strikethrough and task lists. This also applies to the source view.
  - **`CodeMirrorView` takes `live`.** It swaps the gutters (line numbers, folding)
    for the live view, in a compartment, so switching modes keeps the text, cursor
    and undo history.
  - **Notes:** the modes are live (the default), source, split (source beside the
    preview) and preview.
  - **Editor:** a "✎ live" toggle on markdown tabs, kept in prefs
    `editorLiveMarkdown` (off by default).
  - **Tests:** `livePreview.test.ts` checks what reads through with and without
    an active line, the line styles and the link lookup.
  - **Checked live** (dev app): a demo note with every construct read cleanly.
    Clicking a line showed its markup; ticking a box edited the text; switching
    modes kept the text. In the editor, README.md read cleanly with the toggle on.

#### Step N3 — Notes sync across machines

- **Goal:** The same project notes on every PC that runs Workbench, kept in a private git
  repo, with no lost text when two machines edit the same note.
- **Depends on:** N1.
- **Decided (2026-10-19):** notes stay Workbench's data and sync on their own. They don't
  move into Duck's data repo (`assistant-plan.md` §Two repos): Duck reorganizes its own
  repo automatically, while notes are yours, and notes sync must work with Duck off or not
  set up on a machine.
- **Build:**
  - **Project identity.** A project's id is random per machine, so notes are keyed by a
    **notes key** instead.
    - A new `projects.notes_key` column. On this machine the existing folders keep their
      names: each project's notes key is its current project id, so nothing is renamed.
    - Each notes folder gets `project.json`: `{name, origin}`, where `origin` is the
      project's normalized `origin` URL (read with the existing git commands, local or
      SSH; `https`/`ssh` forms and a trailing `.git` normalize to one string).
    - Opening notes for a project with no notes key: a folder whose `origin` matches is
      linked automatically ("linked to notes from <machine>"). With several matches, or a
      project without a remote, the panel offers **link to existing notes…** (a list of
      unlinked folders by name) or **start new notes**.
    - The notes module and its rules don't change. `note_path` resolves the folder
      through the notes key, so the phone (R8) is unaffected.
  - **The notes root is a git repo** (release build only; `notes.dev/` never syncs).
    - Setup, in Settings → Notes sync, off by default: **create** runs `git init` and
      `gh repo create <name> --private` (after you confirm), or **join** clones an
      existing remote. Joining a machine that already has notes merges them in.
    - Commits: 30 s after the last change to the folder, or when a note is closed, with
      messages like `notes: <project> / <note>`. Pushes follow each commit.
    - Pulls: on start, when the window gains focus after ≥5 min, and before a push. No
      polling while the app is idle.
    - A pulled change emits `notes-changed`, so open panels reload as they do today
      (the unsaved-edits banner covers a note you're editing).
    - The project's `plugins.json` and `scripts/` (Track K) live in the same folder and
      sync with the notes. A pulled change to them emits `plugins-changed`. A conflict
      keeps your version and saves the other as `plugins (from <machine>).json`, which
      the toolbar ignores.
  - **Conflicts never lose text.**
    - Merges are by file. A note changed on both machines keeps your version under its
      name, and the other one is saved as `<name> (from <machine>).md` and committed. An
      *info* item names both.
    - An edit beats a delete: a note deleted on one machine and edited on the other comes
      back.
    - A failed push or pull (offline, auth) retries with backoff and shows as *info*
      after an hour. It never blocks saving: notes always save locally first.
  - **A shared background git queue**, `src-tauri/src/gitqueue/`: per-repo jobs (commit,
    fetch, merge, push), one lock per repo, its own thread, results as events. Notes sync
    is its first user. Duck's data repo uses the same queue (assistant plan L1, L4); if L1
    lands first, it builds this module and N3 reuses it.
- **Key files:** `src-tauri/src/notes/` (notes key, `project.json`), new
  `src-tauri/src/notes/sync.rs`, new `src-tauri/src/gitqueue/`, a migration adding
  `projects.notes_key`, `src/panels/Notes/` (link UI), Settings.
- **Done when:**
  - Two machines (or two Windows users) share notes for the same repo, linked by its
    remote with no manual step.
  - Editing the same note on both while offline ends with both texts kept and one *info*
    item.
  - Saving a note with the network off works, and syncs once it's back.
  - The phone still reads and writes notes unchanged.
- **Out of scope:** real-time co-editing; merging inside a note (line-level merge of
  prose produces surprises; a conflict copy is clearer); syncing anything else.

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
- **As built (2026-10-14):**
  - **Pure rules** live in the new `src-tauri/src/remote/auth.rs` (unit-tested, `now`
    passed in): `PairGate`, `gen_pairing_code`, `ct_eq`, `device_expired`, `origin_ok`
    and `AuthLog`.
  - **Pairing code:** 10 symbols from a 30-symbol alphabet without look-alikes
    (`XXXXX-XXXXX`, ≈49 bits), drawn from the OS random source. Typed input ignores case,
    dashes and spaces. A code exists only after "generate code" in the menu, and that
    command is refused while the server is off. Stopping the server drops the code. It
    still lasts 10 minutes and works once.
  - **Lockout:** the 5th wrong code burns the code (`pairingLocked`) and even the right
    one is refused until a new code is generated. Separately, `/pair` takes at most 10
    attempts per 60 s from anyone; the rest get 429 without being checked. Each refusal
    returns its reason, and the phone shows it inline instead of in an `alert`.
  - **Desktop approval:** a successful pair creates a device with `approved = 0`. Its
    token gets 403 on HTTP and is refused on WebSockets. `RemoteApproval.tsx`, mounted in
    App, shows the oldest waiting device (name, address, when) with *allow*, *turn away*
    and *decide later*. Focus starts on *decide later*, so a stray Enter doesn't allow
    anything. A device not allowed within 10 minutes is dropped. The status bar shows
    "· N waiting". The phone has a waiting view that polls `/api/state` every 2 s and
    moves on by itself when the device is allowed or turned away.
  - **Token transport:** WebSockets carry the token as a `wb-token.<token>` subprotocol
    beside `wb` (the server answers `wb`). HTTP keeps `Authorization: Bearer`. Nothing
    puts the token in a query string any more. Every device's token is compared with
    `ct_eq`, with no early exit.
  - **Origin:** both WebSocket upgrades are refused with 403, and logged, when `Origin`
    isn't this server's own `Host`. No `Origin` (a non-browser client) is let through,
    since it still needs a token.
  - **Revoke cuts live sockets:** previously a revoked phone kept its open dashboard
    socket. Now a `watch` counter (`kick`) is bumped on revoke, turn-away, expiry and
    server stop, and both socket loops re-check their device and close. If the phone's
    socket never opens it asks `/api/state` why, and on 401 it drops the token and
    returns to pairing with a message.
  - **Devices:** migration v9 adds `id` (the UI names devices by id, so the token no
    longer reaches the webview), `last_addr` and `approved`. Devices paired before this
    stay approved. Load backfills a missing id, in case an older build sharing the
    database pairs a device. The menu row shows address and last seen, and revoke is
    still one click. **Expiry is fixed at 30 days unused** rather than a setting.
    Devices expired at startup are recorded in the failure log rather than dropped
    silently.
  - **Auth-failure log:** in memory only, last 30 entries. A repeat of the same failure
    from the same address adds to a count instead of a new row, so a revoked phone's
    reconnect loop takes one line. The menu shows 4 entries, then "show all", and has a
    *clear* button. Every change to devices, the code or the log emits `remote-changed`,
    and `state/remoteServer.ts` (which now holds status, devices and failures) reloads on
    it.
  - **Verified live:** the dev app ran with the server bound to loopback (a test-only
    patch, since reverted). The test drove the desktop webview and a headless Edge at
    phone size:
    - No code → 401 "No pairing code is live". 40 rapid wrong codes → 4 × "Wrong code —
      n more tries", 5 × locked, 31 × rate-limited; then the right code was refused and
      the menu showed the lockout.
    - After the window passed, the phone paired with a lower-case code and sat in the
      waiting view. Its token got 403 from `/api/state` and `/api/action`, and its
      WebSocket was refused with no data.
    - The desktop dialog appeared. *Allow* moved the phone to the live dashboard within
      2 s.
    - Upgrade with `Origin: https://evil.example` → 403; own origin and no origin → 101
      `wb`.
    - CDP's network log showed the token in no URL, only in the WebSocket handshake
      header.
    - Revoke closed the open socket, and the phone returned to pairing with "stopped
      taking this device" and its token gone. *Turn away* from the dialog sent the phone
      back with "didn't allow".
    - The failure log listed each kind with counts.
  - **Not tried:** a real phone, over Tailscale, and the 30-day expiry outside unit
    tests. Tokens are still stored in plain text in the database (hashing them was not
    asked for). If the phone cancels its wait, the desktop still lists the device as
    waiting until it is turned away or runs out.
  - 127 Rust tests (12 new) and 152 frontend tests pass; typecheck passes; lint shows
    only the existing `TornWindow.tsx` warning.

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
- **As built (2026-10-14):**
  - **Listeners:** the server always binds `127.0.0.1:<port>` (where Funnel delivers),
    plus the tailnet address when there is one. Turning remote access on no longer needs
    Tailscale up: a *keeper* thread (`remote/mod.rs`) binds the tailnet address once it
    appears, so a boot where Workbench starts before Tailscale still ends up reachable.
    One axum task per listener, same router. The LAN is still never bound.
  - **Funnel driver:** the new `src-tauri/src/remote/funnel.rs` runs the `tailscale` CLI
    (on `PATH`, or the installer's location; no console window, 20 s deadline per call).
    It reads `status --json` and `serve status --json`, and runs `funnel --bg --yes
    --https=<port> http://127.0.0.1:<port>` to add the funnel and `funnel --https=<port>
    off` to remove it. Parsing and the prerequisite rules are pure and unit-tested
    (6 tests, including the QR code).
  - **Ports:** a release uses public port **443** (an address with no port in it), a
    debug build uses **8443**, so both can be public at once. Funnel allows only 443, 8443
    and 10000; the tailnet's `funnel-ports` grant is checked.
  - **Switch:** *public access · funnel* in the Remote Access menu, off by default and
    persisted (`meta.remote_public`). While it is off, the menu says what it exposes:
    the page is public, but nothing works without a pairing code and the desktop's
    allow. When on, the menu shows the public URL with *copy* and a QR code. The QR code
    is rendered in Rust (`qrcode` crate, SVG, no `image` dependency) through
    `remote_qr_svg`. The status bar adds "· public", or "· public ✕" when there is a
    problem.
  - **Keeper:** whenever the switch and the server are both on, it makes sure the funnel
    is in place. It re-checks every 60 s once working, every 15 s while not, and is woken
    at once by any toggle. Turning the switch off, or disabling the server, removes the
    funnel; the switch keeps its state, so re-enabling the server restores it. A funnel
    left over from a run where the switch was later turned off is removed at startup,
    once Tailscale can be asked.
  - **Prerequisites explained, not failed silently:** the menu says what is missing:
    - the CLI is absent (with a download link);
    - Tailscale is disconnected or logged out;
    - there is no MagicDNS name;
    - HTTPS certificates are off (link to the DNS page);
    - the `funnel` node attribute is missing (link to the policy file);
    - the port isn't in the tailnet's funnel ports.

    A consent link printed by the CLI is passed through. "Workbench keeps trying"
    follows each message.
  - **Someone else's entry:** a port already serving anything but our loopback target is
    reported ("Port 8443 is already serving / → http://127.0.0.1:3999 … remove it with
    `tailscale serve --https=8443 off`") and never overwritten. Our own entry, or our
    proxy served only on the tailnet, is adopted.
  - **Behind the proxy:** for a loopback peer only, `X-Forwarded-For` names the client
    (in the device list and the failure log), and `X-Forwarded-Host` is accepted in the
    WebSocket `Origin` check. In practice Tailscale passes the public `Host` through
    unchanged.
  - **Verified live** against the real tailnet, with the phone simulated by headless
    Edge at phone size. It was pointed at the funnel's *public* relay address (looked up
    via 8.8.8.8, not MagicDNS), which is the path a phone on mobile data takes:
    - With the switches set in the dev database and the app started, the funnel appeared
      by itself.
    - Over the relay: the page loads; `/api/state` gives 401 without a token and 200 with
      an approved one; `/pair` explains that no code is live; a WebSocket from Origin
      `evil.example` gets 403, while the page's own Origin gets 101 `wb`.
    - The phone page is a secure context, goes live over `wss://`, and its service
      worker is **active**. On plain http it never had a secure context.
    - The device row and the failure log show the client's real public IP, not
      127.0.0.1.
    - Menu (driven by real mouse clicks): URL and QR code shown. *Turn off* removed the
      funnel and the address stopped answering. A foreign `tailscale serve` entry on
      8443 was reported and left alone; once it was removed, Workbench put its funnel up
      within 9 s on its own. *Disable* took the funnel down, and *enable* restored it
      within 1 s.
    - **Restart:** with the app stopped and the funnel removed by hand, launching the app
      brought the funnel back with no action taken. The phone then loaded the dashboard
      over public HTTPS and went live.
  - **Found along the way:**
    - A *newly added* funnel took about 2½ minutes before Tailscale's public relay
      completed TLS. The tailnet path answered at once. An ordinary restart doesn't hit
      this: the funnel lives in Tailscale's own config and survives app restarts and
      reboots.
    - WebView2 runtime 155 now drops `--remote-debugging-port` however it is passed, so
      the desktop was driven by window clicks rather than CDP.
  - **Not tried:** a real phone on mobile data, the release build on 443, and the
    "Tailscale disconnected / not installed / attribute missing" messages live (they are
    unit-tested). Loopback is reachable by anything on this machine, which still needs a
    token; DNS rebinding isn't specifically guarded against beyond that.
  - 133 Rust tests (6 new) and 152 frontend tests pass; typecheck and clippy are clean;
    lint shows only the existing `TornWindow.tsx` warning.

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
- **As built (2026-10-14):**
  - **Socket:** `GET /api/transcript?instance=…` (new `src-tauri/src/remote/transcript.rs`),
    with the same auth and Origin check as `/api/ws`. It takes a reference on the T1 follow
    while it is open, but keeps a **cursor of its own**. The follow now also broadcasts
    small notes (`Note::Appended`, `Note::Rotated` with the new path) besides its webview
    events, and on each note the socket reads forward from where it is. So a slow or
    reconnecting phone never misses or repeats a line, and a lagged receiver re-checks
    the follow's position. `transcript_follow` / `transcript_unfollow` became thin
    wrappers over `stream::acquire` / `release`.
  - **Frames:** down `start` / `resume` / `lines` / `rotated` / `page`, up `back { id,
    before }`; typed in `src/remote/protocol.ts` (`TranscriptFrame`).
  - **Only the conversation travels**, as T1 asked: lines are cut to what the model
    keeps (main-thread `user` / `assistant` / `system`) and Edit results lose
    `originalFile`. History pages that hold nothing to show are skipped server-side, so an
    empty page still means "top of file". Measured: reopening a 432 KB transcript sent
    about 10 KB.
  - **Resume:** a reconnect names `session` and `offset`; if that is still the
    instance's transcript the server answers `resume` and carries on from that offset.
    Otherwise it answers `start`, which the phone turns into a rotation so the feed starts
    over.
  - **Phone:** the shared `transcript/feed` and `render` run in the PWA over a
    reconnecting transport (`src/pwa/transcriptSource.ts`, unit-tested with a fake
    socket). `instanceSource` moved to `transcript/desktopSource.ts`, so the phone bundle
    has no Tauri code (bundle 425 kB / 116 kB gzip). The transcript styles get the
    desktop's `--wb-*` names mapped onto the phone palette.
  - **Console overlay** (`src/pwa/console.ts`) opens on the **transcript**. A header
    button switches to the mirrored terminal and back. The choice is remembered per
    instance while the page is open, and SSH projects only get the terminal. The
    transcript keeps following while the terminal is shown. The view has sticky-to-end
    scrolling, "↓ latest", "load earlier", and a working / compacting status line.
  - **Composer:** a sticky multi-line box that grows to about a third of the screen.
    Enter is a new line (phone keyboards dictate into it as usual), the button sends,
    and Ctrl/⌘+Enter also sends. Tapping send keeps the keyboard open. It sends the
    existing `prompt` action. While working there is a *stop* (interrupt) button; while
    needs-you, a row with approve / deny / terminal. When the session isn't running the
    button reads *start* and keeps the text, since a prompt to a stopped console would be
    dropped. Drafts are kept per instance. The viewport meta gains
    `interactive-widget=resizes-content` so on Android the composer stays above the
    keyboard.
  - **Quick keys** in the terminal view: Esc, ↑, ↓, Tab, ⇧Tab, Enter, 1–4, sent as raw
    bytes on the mirror socket. The arrows follow xterm's application-cursor mode.
  - **Verified live** (dev app, headless Edge at phone size against the loopback
    listener):
    - The console opened on the transcript.
    - *start* launched the session; a prompt sent from the composer showed "working"
      and *stop*, then the answer appeared.
    - `/clear` emptied the view, and the next answer arrived on the same socket.
    - Closing the socket by force reconnected with `session` and `offset`. The server
      sent only `resume`, nothing was re-fetched, and a follow-up arrived.
    - Terminal toggle: the mirror went live, Esc sent `1b`, and switching back left the
      transcript intact with the mirror socket closed. Closing the overlay closed every
      socket. No JS errors.
  - **Found along the way:** a new session's file appears only with its first line,
    and the follow takes it up without a rotation, so the socket's cursor had no path
    and showed nothing until a reconnect. The socket now asks the follow for the path
    when it has a session but no file.
  - **Not tried:** a real phone (keyboard overlap, dictation, one-handed feel), and the
    needs-you row against a real permission prompt (it uses the existing approve / deny
    actions). The desktop transcript view was only covered by typecheck after
    `instanceSource` moved.
  - 136 Rust tests (2 new) and 156 frontend tests (3 new) pass; typecheck and clippy are
    clean; lint shows only the existing `TornWindow.tsx` warning.

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
- **As built (2026-10-14):** new `src/state/choiceWatch.ts`, `src/pwa/choice.ts`;
  checked live in the dev app from headless Edge at phone size.
  - **Snapshot:** `RemoteInstance.choice` (`RemoteChoice` in `remote/protocol.ts`)
    carries the pending prompt's id, kind, tool, arguments, questions, the options the
    phone may send, `terminalOnly` and the label of an answer already sent. It is set
    only while the instance is in needs-you. Tool arguments longer than 6000
    characters are cut, because the snapshot is pushed on every change and a whole
    file being written would otherwise go with every push.
  - **Action:** `choose { instanceId, choiceId, option: digit | "deny" }`, handled by
    `chooseRemote` in `state/remoteActions.ts` through T5's `answerChoice`. It is
    ignored unless `choiceId` is still the open prompt, no answer has been sent yet,
    and the digit is one of its options. That covers a stale tap, a double tap and a
    second phone. Rust needed no change, since the server forwards any action
    verbatim. The phone's plain **approve** (Enter) now does nothing on a plan, which
    closes the gap T5 left. It remains the fallback for a needs-you the desktop can't
    describe.
  - **Choice watch (needed for the phone, also fixes a T5 gap):** T5 read
    permission and plan options off the screen, and caught "No" / Esc from the
    transcript, only while the desktop card was on screen. `state/choiceWatch.ts`
    (main window) now does both for every open prompt. It reads the screen on the
    card's schedule (`READ_AT_MS`, moved to `pendingChoice.ts`) and follows the
    transcript until the prompt closes. A desktop console left on its terminal no
    longer stays in "needs you" after "No".
  - **Phone card:** `src/pwa/choice.ts` is a framework-free version of
    `ChoiceCard`, reusing the `.wb-chc` styles at touch size.
    - Compact on a dashboard card, replacing approve / deny: one summary line, the
      options, *terminal* (opens the console on its terminal) and *deny* /
      *cancel*.
    - Full in the transcript view, above the composer and up to 55vh: the arguments
      are drawn by `renderPendingTool`.
    - Fallbacks match T5: a prompt that is `terminalOnly` shows why, plus the
      terminal button. An option typed in the terminal sends its digit, then
      switches to the terminal.
    - A tap shows "sent: …" at once, and the card offers *check the terminal* after
      4 s without the prompt closing. It never re-sends.
    - The card is redrawn only when the prompt or its state changes, so the
      snapshots don't reset a long plan's scroll.
  - **Wrapped option labels:** `parseOptionRows` joined a row that reached the
    screen's edge without a space, which gave "promptsfor you". It now joins without
    a space only when the cut word is path-like (contains `/` or `\`) or longer than
    24 characters, because the TUI wraps at spaces.
  - **Verified live:**
    - A session switched to manual mode with the phone's ⇧Tab key, and a Bash
      prompt showing all four real options, including "Yes, and switch to auto
      mode".
    - "No" tapped: the card closed and the status left needs-you. The desktop
      console was on its terminal, so the watch alone caught this.
    - "Yes" tapped: the command ran.
    - The same prompt's id sent again after it closed: nothing was typed into the
      prompt box.
    - A single-select question: *Green* tapped, and Claude answered "green".
    - A plan in plan mode, showing the plan and its three options read off the
      screen, then *cancel*.
    - The dashboard's compact card shown alongside the full one each time. No JS
      errors.
  - **Tests:** 10 more (`state/remoteActions.test.ts`, `pwa/choice.test.ts`,
    `state/pendingChoice.test.ts`), 166 in all.
  - **Known gaps:**
    - Not tried on a real phone.
    - No live test of a plan approved from the phone, or of an option typed in the
      terminal; both are covered by unit tests only.
    - The dashboard card learns of a tap made in the transcript view only from the
      next snapshot, a fraction of a second later.

#### Step R6 — Push notifications

- **Goal:** The phone is told when an agent needs you, with the page closed.
- **Depends on:** R3 (web push needs HTTPS).
- **Build:** VAPID keys generated and stored on the desktop; subscribe from the PWA after
  pairing; the desktop sends a push on the transitions that already raise an OS toast
  (needs-you, escalation); tapping opens that instance. Per-device mute. Note the platform
  limits found (e.g. install-to-home-screen requirements) in As built.
- **Key files:** `src-tauri/src/remote/`, `src-tauri/src/attention.rs`, PWA service worker.
- **Done when:** a needs-you transition reaches a locked phone.
- **As built (2026-10-14) — built and checked end to end, but not yet on a locked
  phone, so the tracker row stays open:**
  - **Backend** `remote/push.rs`:
    - The VAPID key pair (P-256) is made on first use and stored in `meta`
      (`push_vapid_private`).
    - Payload encryption is RFC 8291 `aes128gcm`; a unit test matches the RFC's
      worked example byte for byte. Each push is signed with an ES256 VAPID JWT
      (RFC 8292) whose audience is the push service's origin.
    - Sending is a blocking `ureq` POST (rustls) on a short-lived thread, with TTL
      1 h and `Urgency: high`. A 404 or 410 from the push service drops the
      subscription.
    - New crates: `ureq`, `p256`, `aes-gcm`, `hkdf`, `sha2`, `base64`, `rand_core`.
      There was no HTTP client with TLS before.
  - **Storage:** migration v10 adds `push_subscriptions`, one row per paired device
    with a `muted` flag. Unpairing a device deletes its row.
  - **Endpoints** (bearer, approved devices only): `GET /api/push` (key, subscribed,
    muted), `POST /api/push/subscribe` (https endpoints and well-formed keys only, so
    a client can't aim our requests at this machine), `POST /api/push/unsubscribe`,
    `POST /api/push/mute`.
  - **When:** `state/notifications.ts` sends `remote_push_send` beside the OS toast,
    on needs-you and on escalation, when the "phone" route is on. That is the same
    switch as before; it no longer depends on the desktop toast being on.
    - Payload: `{title, body, instanceId, tag}`. The tag is the instance, so a newer
      push about the same card replaces the older one.
  - **Phone:**
    - The service worker shows the push and, on a tap, focuses an open dashboard
      (which opens that instance's console) or opens `/#instance=<id>`.
    - `src/pwa/push.ts`: a footer button reads "turn on notifications",
      "notifications: on · mute" or "notifications: muted · unmute".
    - It quietly resubscribes when the desktop lost the subscription, and
      resubscribes when the desktop's key changed.
  - **Platform limits found:**
    - Push needs a secure page: the Funnel (R3) https address, or localhost. The
      plain tailnet `http://100.x` address can't subscribe; the button says so.
    - Permission can only be asked from a tap.
    - On iPhone (iOS 16.4+) only a web app added to the home screen can subscribe;
      in Safari itself `PushManager` is missing, and the button says to add it
      first.
    - Android Chrome subscribes in the browser.
  - **Checked live** (dev app plus headless Edge on the loopback origin, through
    Microsoft's real push service):
    - The button subscribed, and the desktop stored the `wns2…notify.windows.com`
      endpoint.
    - A real session's permission prompt (a Write in manual mode) made a push that
      the service worker showed as "● needs you · r6test.r6" with the instance as
      tag and data.
    - Mute and unmute changed the desktop's flag.
    - Not checked: a tap opening the instance (headless Edge can't tap a
      notification), and **a real locked phone**. To finish: on the phone, open the
      Funnel address, tap "turn on notifications", lock it, and make a session ask
      for permission.

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
- **As built (2026-10-14):**
  - **Wire:** `src/remote/protocol.ts` — the snapshot gains `projects` (id, name, group
    name, remote flag) and `created` (one record per request: `requestId`, `instanceId`,
    `state`, `message`); `RemoteAction` is now a union with `RemoteCreateAction`
    (`requestId`, `projectId`, optional `title`, `text`, `worktree`). The Rust server
    has no action allow-list, so it only changed a doc comment.
  - **Desktop:** `createSession` in `state/remoteActions.ts`. It follows the rail's
    `spawnInstance`: `addInstance` → (worktree) `provisionWorktree` →
    `setActiveProject` → `openConsole` → `activatePanel`. So a phone-made console
    switches the desktop to its project, the same as clicking "new instance". The
    default title is the next free number. That rule is now `nextInstanceTitle`
    (`state/registry.ts`), and the rail uses it too. If the worktree can't be made, the
    instance is deleted again and the record reports `failed` with the error. A failed
    setup command doesn't stop the session; it comes back as the record's `message`.
  - **Idempotent:** `state/remoteCreate.ts` keeps the last 20 records in memory.
    `beginCreate` refuses an id it has already seen, so a double tap, a "send again"
    or a replay over HTTP is a no-op. The records go into the snapshot, and that is how
    the phone learns the new instance's id.
  - **Ready signal: the prompt box on the terminal screen.** `promptBoxReady` looks for
    a `❯` row with a `────` rule right above it and another within five rows below.
    That is the empty input box, captured from Claude Code 2.1.299 in a scratch PTY.
    The workspace trust dialog also has a rule and a `❯`, but its caret row is numbered
    (`❯ 1. Yes, I trust this folder`), so it never reads as ready. Permission prompts
    don't either. The screen is read with `readScreen`, the read T5 approved; this is
    its second user, and it still decides only *when to paste*, never the status. The
    screen is checked every 250 ms. If the box hasn't shown after 60 s (5 min once
    `asksForPassword` has seen an SSH password or passphrase prompt), the prompt
    becomes the instance's queued prompt (`state: "queued"`) and the phone is told
    to check the console. The other candidate, the transcript file appearing, was not
    tried: the screen shows the exact thing the paste needs.
  - **Phone:** `src/pwa/newSession.ts`. There is a **+ new session** button in the
    header (shown when there are projects) and a **+** on each card that opens the
    same sheet for that card's project, with no picker. The plan asked for a button on
    each project group, but the dashboard has no groups (cards are sorted by
    attention), so the card's **+** stands in for one. The sheet has project,
    optional title, optional first prompt and an "isolate in a worktree" box. Its
    status line follows the record. When the new instance shows up in the snapshot,
    the sheet closes and the mirror opens on it. If there is no reply within 6 s, the
    button becomes **send again** and resends the same request id. Request ids don't
    use `crypto.randomUUID`, because plain HTTP on a tailnet address isn't a secure
    context. Once the sheet is closed, a message about the request (queued prompt,
    password, failed setup) shows in a dismissable banner under the attention line.
    Wording helpers are in `format.ts`.
  - **Verified live:** in the dev app with the server temporarily bound to loopback
    (reverted), and the built PWA in headless Edge at 390×844. Steps: pair; open the
    sheet (every project listed, with its group and "(ssh)"); create with a title and
    first prompt using a double tap; then replay the same request over `/api/action`.
    Result: one instance, the sheet closed after 0.5–1 s, the mirror opened, the
    prompt went in once the box showed and "pong" came back, and the console opened on
    the desktop. The card **+** opened the sheet with the project fixed and gave title
    `1`. A worktree session got branch `agent/wt-probe`. An untrusted folder with a
    first prompt sat on the trust dialog and was `queued` after 60 s, with the prompt
    in the queue. An unknown project id was `failed` ("That project no longer
    exists."). No page errors. The probe projects, instances and test device were
    removed afterwards.
  - **Not tried:** an actual phone; a remote (SSH) project, where the password path
    is unit-tested only; a worktree provisioning failure in the app (the backend
    makes branch names unique, so a clash doesn't fail; covered by a mocked test).
  - **Known gaps:** a session queued because of the trust dialog still needs someone to
    answer the dialog in the console. The queued prompt is then sent only after a first
    turn ends, the same as any queued prompt, so it may be quicker to cancel it and
    resend. Records are forgotten on restart, so a request replayed after the desktop
    restarts would create a second session. The sheet's draft isn't kept if the page
    reloads.
  - **Tests:** 21 more (`state/remoteCreate.test.ts`, `state/remoteActions.test.ts`,
    `pwa/format.test.ts`), 152 in all. Typecheck and lint pass; the PWA builds
    (314 kB / 81 kB gzip).

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
- **As built (2026-10-14):**
  - **Server** `remote/notes.rs`, all behind the bearer check:
    - `GET /api/notes` gives the counts per project; `GET …/list`, `GET …/read`, and
      `POST …/create`, `…/save`, `…/rename`, `…/delete` call the N1 module in Rust.
    - Each request checks the project is in the registry (404 otherwise); the N1
      name rules refuse anything path-like (400).
    - A stale save answers 409 with the note as it is now, or null when it was
      deleted.
    - Create takes a name and finds a free "name 2", "name 3" (`create_unique`, new
      in the N1 module). The phone gets no file paths.
    - Notes ride the same Funnel rule as every other endpoint, since they use the
      same auth.
  - **Live both ways:** `notes::notify` now also calls
    `remote::push_notes_changed`, which sends `{"type":"notes","projectId"}` on the
    dashboard socket beside the snapshots (not stored as the snapshot). So a change
    from either side reaches the desktop panel (`notes-changed`) and every phone.
    - The counts come from the server rather than the snapshot, so
      `RemoteMirror.tsx` didn't change.
  - **Phone** (`src/pwa/notes.ts`, `noteText.ts`; `net.ts` gained `api()` and the
    `notes` frame):
    - A **notes** row on the dashboard: each project with its count.
    - The list: newest first, a filter past four notes, and a quick-capture field
      (the first line names the note, without markdown marks or the characters a
      name can't hold).
    - A note opens rendered through the desktop's `renderMarkdown` (marked +
      DOMPurify); **edit** switches to a plain textarea. **Save** saves, and so does
      leaving the note (back or close); if the save can't go through you stay on
      the note.
    - Every keystroke is kept in `localStorage` until saved, and offered again
      (restore / discard) when the note is next opened.
    - **Conflict:** both versions are shown, with **keep mine as a new note**
      ("name (phone)"), **overwrite with mine**, or **drop mine**.
    - Rename and delete (behind a confirm), and **send to…** one of the project's
      sessions through the `prompt` action.
    - A change elsewhere refreshes the list, and the open note unless you're
      editing it; then it says that saving will show both versions.
  - **Checked live** (dev app plus the PWA in headless Edge, on the loopback
    listener with a test device):
    - Refused: no token (401), an unknown project (404), and ids with `/` or `\`,
      for read and create (400).
    - A quick note from the phone: the desktop panel listed it with no restart, and
      the dashboard count went up.
    - The phone was editing while another writer saved: the phone said so, the save
      showed both versions, and "keep mine" left both notes.
    - An edit and save on the desktop re-ordered the phone's list live.
    - A draft planted as if typed offline was offered, restored and saved, and the
      device copy was dropped.
    - A real phone over the tailnet wasn't used this time; the transport is the same
      one R4/R5 checked.

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
- **As built (2026-10-14):**
  - **Finding plans:** `plansIn` / `readPlans` / `planRef` in `transcript/feed.ts`.
    - `readPlans` pages back through the session's file, with the bound
      `readLastResponse` uses (24 pages of 256 KB). So it works whichever view is
      showing.
    - A plan's id is its tool call's id; its title is the first heading or line,
      without `#`, backtick, `*` or `_` marks.
    - `state/plans.ts` caches the plans per instance. Since reading a whole session
      isn't free, it refreshes only when a console shows up and when a plan
      approval prompt appears, retried at 1 s, 3 s and 8 s: the prompt can arrive
      before the plan's line reaches the file. The transcript view also adds the
      plans it has already folded.
  - **Opening** (`openPlan.ts`, `state/dock.openPanelBeside`): a `plan` tab to the
    right of the console, one per plan (`plan:<instance>:<plan id>`). Opening it
    again brings the tab forward.
    - The plan's text is in the panel params, so the tab survives layout saves,
      reloads and presets with no store.
    - The session id param is `fromInstance`, not `instanceId`: the workspace
      treats any panel with `instanceId` as a console.
  - **Three ways in, all clicks:**
    - **Console header:** "open plan" (the latest), with ▾ listing the earlier ones
      when there are several. It shows once the session has a plan, in both views.
    - **The plan's card in the transcript:** an "open plan" button, rendered by the
      shared renderer and caught by the desktop view. The phone hides it, since it
      has no dock.
    - **The plan approval card:** the same button. It uses the tool-use id, so it
      opens the same tab.
  - **The tab** (`PlanPanel.tsx`): read-only markdown with **save as note**, which
    copies the plan into the project's notes. It uses a new `notes_create_with`
    command (free-name create), and the note name rule moved to
    `state/noteName.ts`, shared with the phone.
  - **Checked live** (a real session in plan mode, in a scratch repo):
    - The approval card's button opened the tab beside the console.
    - "save as note" made the note.
    - After a reload the tab was still there.
    - After resuming the session, the header button showed in both views, and the
      transcript card's button opened the tab.
    - Nothing opened by itself.
    - Found and fixed during the run: the header button missed a plan that arrived
      with its prompt (now the retries), and titles kept backticks.

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
- **As built (2026-10-14):**
  - **"⌕ review"** in the review panel's header (shown when there are changes)
    opens a dialog with the editable prompt.
    - The prompt is kept per project in prefs (`reviewPrompts`). The default isn't
      stored, so "reset to default" returns to it. `{base}` becomes the diff's base.
    - The default asks for a review only (no edits): bugs, unhandled cases,
      contradictions, no style nits. It ends with a fenced `findings` block,
      `path:line(-end) | high|medium|low | note`.
  - **The reviewer** (`Diff/reviewRun.ts`) is an ordinary new instance,
    "review · <title>", in the implementing instance's working dir (its worktree if
    it has one). Its console opens beside the diff, and the prompt is submitted
    once the prompt box shows (queued if it never does).
    - The rail flags both as "shared", which they are.
  - **Findings:** when the reviewer's turn ends, its last reply is read from the
    transcript and parsed (`state/reviewFindings.ts`: the last `findings` block;
    lines not in the form are skipped).
    - The reply is re-read for up to about 17 s while it has no block yet: the
      first live run heard the turn end before the reply reached the file, and
      showed "no findings block".
  - **The strip** (`Diff/Review.tsx`, state in `state/reviews.ts`): "is
    reviewing…", then the findings with severity and `path:line` (a click shows the
    lines), each ticked except the low ones.
    - "send N to <title>" adds the ticked findings as V3 comments, with the code
      read from the working tree and the note prefixed with `[severity]`. It sends
      them with any comments already pending (`sendPendingComments`, now shared
      with the panel's own send) and dismisses the review.
    - Send is off while the implementing session has no running console here.
  - **Checked live** (a scratch repo with two planted bugs, two real sessions):
    - The reviewer found the float index (high), the empty-list division (medium)
      and an even-length median quibble (low).
    - "send 2" put the two ticked findings, with the quoted code, into the
      implementing session as one prompt, and it fixed both (`// 2`, a
      `ValueError` on empty input).
    - Nothing was copied by hand.

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

### Track K — Project toolbar (plugins)

Per-project controls in the title bar that run project-specific logic: "build the
installer" and "run a dev instance" for Workbench, a dropdown plus a text field plus a
button for another project. Asked for on 2026-10-19.

**Decided (2026-10-19):**
- **Declarative, not code.** A plugin is a JSON description of controls and the actions
  they run. Workbench draws the controls itself. No plugin code ever runs in the webview,
  so a plugin can't reach the PTYs, git or Duck's proxy token. Real logic lives in
  scripts that the actions run as ordinary processes. No rebuild is needed: the file is
  read at runtime and reloaded when it changes. Code plugins (a sandboxed custom panel)
  can come later if a real need shows up.
- **Stored with the project's notes**, `<app data>/notes/<project folder>/plugins.json`,
  next to N3's `project.json`. It syncs across machines with the notes (N3), stays out of
  the repo, and doesn't appear in the notes list (the list shows `.md` files only).
  Scripts the plugins call can live in the same folder (`scripts/`), so they sync too.
- **Built in parallel with Duck**, in its own worktree session (`agent/plugins`), and
  merged into `main` when done. The overlap with Duck's steps is small: `App.tsx`'s title
  bar, the `lib.rs` command list and `Workspace.tsx`'s components. Duck's plugin tools
  (assistant plan W5) wait for the merge.

#### Step K1 — Plugin file, toolbar and task runs

- **Goal:** Buttons, dropdowns and text fields in the title bar that run a project's
  commands, defined in a file you (or Duck) can edit without rebuilding.
- **Depends on:** N1 (the notes folder). N3 isn't needed: until it lands, the folder is
  the project id's.
- **Format** (`version: 1`; unknown fields are refused, so a typo doesn't silently do
  nothing):

  ```json
  { "version": 1,
    "plugins": [
      { "id": "build", "label": "build",
        "actions": [
          { "id": "installer", "label": "installer", "run": ["npm", "run", "tauri:build"] },
          { "id": "dev", "label": "dev", "run": ["npm", "run", "tauri:dev"], "long": true } ] },
      { "id": "deploy",
        "controls": [
          { "id": "env", "type": "select", "options": ["staging", "prod"], "default": "staging" },
          { "id": "tag", "type": "text", "placeholder": "tag", "pattern": "^v\\d+\\.\\d+\\.\\d+$" } ],
        "actions": [
          { "id": "go", "label": "deploy",
            "run": ["pwsh", "-File", "{data}/scripts/deploy.ps1", "-Env", "{env}", "-Tag", "{tag}"],
            "confirm": "Deploy {tag} to {env}?" } ] } ] }
  ```

  - Controls: `button` (an action), `select`, `text`, `checkbox`. The values of `select`,
    `text` and `checkbox` are kept per project in prefs, so a field keeps its last value.
  - `run` is an **argv array, never a shell string**. `{control}` placeholders are
    substituted inside single arguments only, so a text field's value can't become a
    second command (guardrail: no shell interpolation of user strings). Whoever wants a
    shell writes `["pwsh", "-Command", "…"]` themselves, with no placeholders inside it.
  - Also substituted: `{root}` (the project root), `{data}` (the project's notes folder,
    for synced scripts) and `{branch}`. `cwd` defaults to `{root}`.
  - An action may set `confirm` (a question shown before it runs), `long` (it keeps
    running until stopped, like a dev server) and `env` (extra variables).
  - A `text` control may set `pattern`; the action stays disabled until the value
    matches.
- **Build:**
  - **Backend** `src-tauri/src/plugins/`:
    - `plugins_read(projectId)` → the parsed file, or the validation errors with their
      JSON paths.
    - `plugins_write(projectId, text, baseRevision)` uses the same revision rule as notes
      (a stale base is refused). Duck's writes and the editor go through it.
    - A `notify` watcher on the notes root emits `plugins-changed { projectId }`.
  - **Toolbar** (`src/panels/ProjectToolbar.tsx`): the active project's plugins, in the
    title bar left of palette / templates / layout, with a separator before them. Same
    mono style as `PaletteButton`.
    - Each plugin is a group of its controls.
    - When they don't fit, the last groups fold into a "▾ more" menu.
    - An invalid file shows a single "⚠ plugins" item that opens the file and lists the
      errors.
    - Every action is also a palette entry ("build: installer").
  - **Task runs:**
    - An action runs in a **task panel**, a terminal panel titled after the action. It
      spawns the argv directly: a new `SpawnKind::Task` with `argv`, `cwd` and `env`,
      using `CREATE_NO_WINDOW` like the other children.
    - Running it again reuses its panel. If the previous run is still going, it asks
      first.
    - The PTY gains a `pty-exited { id, code }` event (it has none today).
    - The button shows the run's state: running (spinner), then ✓ or ✗ with the exit
      code for a minute. A `long` action's button becomes ■ stop while it runs.
    - Task panels round-trip in layouts and presets like shells. A task that was
      running when the app closed comes back dormant (not restarted).
  - **Hot reload:** saving the file (from anywhere: the editor, Duck, a sync pull)
    redraws the toolbar within a second, with nothing compiled and no window reload.
    "Plugins: reload" in the palette re-reads the file for the rare missed event.
    "Plugins: edit" opens `plugins.json` in the editor panel.
  - **SSH projects:** v1 runs actions on this machine. Running them on the host through
    the remote shell path is a later option.
- **Key files:** new `src-tauri/src/plugins/`, `src-tauri/src/pty/mod.rs` (task kind,
  exit event), new `src/ipc/plugins.ts`, new `src/state/plugins.ts`, new
  `src/panels/ProjectToolbar.tsx` and the task panel, `src/App.tsx` (`TitleBar`),
  `src/panels/Workspace.tsx`, `src/state/layout.ts`, the palette.
- **Done when:**
  - Workbench's own `plugins.json` gives an "installer" button that runs a release build
    in a task panel and ends ✓, and a "dev" button that starts a dev instance and stops
    it.
  - A select + text + button plugin passes both values as single arguments: a test with
    `a & calc` in the text field prints that literal string.
  - Editing the file updates the toolbar without a restart, and a broken file shows the
    ⚠ item with the error's path.
  - Unit tests cover the parser (unknown fields, placeholders, patterns) and argv
    substitution.
- **Out of scope:** code plugins; actions on the SSH host; plugin output parsed into
  anything beyond the exit code.
- **As built (2026-10-19):**
  - **The file:** `<app data>/notes/<projectId>/plugins.json` (`notes.dev/` for a debug
    build), as decided. The format is the one above, with these additions:
    - A `button` control is `{ "type": "button", "action": "<action id>" }`. It places that
      action among the fields; actions no button places are drawn after the fields.
    - A `checkbox` fills `{id}` with its `on` / `off` text (default `"true"` /
      `"false"`). An argument that is exactly `{id}` and comes out empty is dropped, so
      `"on": "--release", "off": ""` adds a flag or nothing.
    - Only `{` + an id + `}` is a placeholder. Any other brace is text, so pwsh blocks
      and JSON pass through, and `{{` / `}}` are a literal brace.
    - Every problem is reported at its JSON path (`plugins[1].controls[0].pattern`):
      unknown fields, a missing or wrong `version`, bad ids, duplicates, a select
      default that isn't an option, a pattern that isn't a regex, unknown placeholders,
      a button naming no action.
  - **Rules that keep a value from becoming a command**, in
    `src-tauri/src/plugins/format.rs`:
    - The webview never sends an argv. A run names the plugin, the action and the field
      values. `pty_spawn` (kind `task`) re-reads the file, checks the values (the select
      option, the text pattern) and fills the placeholders itself.
    - The program (`run[0]`) can only use `{root}`, `{data}` and `{branch}`.
    - A control's placeholder is refused where an interpreter reads it as code: after
      `cmd /c`, after `pwsh -Command` (and abbreviations), in the script after
      `bash -c` (or `-lc`), `node -e`, `python -c`, `ruby`/`perl -e`.
    - A batch file (`npm` resolves to `npm.cmd`) runs as `cmd.exe /d /c call <path>
      …`, because `call` keeps cmd from stripping the quotes around a path with spaces.
      Batch files re-read their arguments as a command line, so a control value
      holding `& | < > ^ ( ) % ! "` or a control character is refused there. An `.exe`
      gets any value as one argument. A `.ps1` runs through `pwsh -File` (or
      `powershell.exe` when pwsh isn't installed).
  - **Backend** `src-tauri/src/plugins/`:
    - `plugins_read` returns `{ path, revision, file, problems }`.
    - `plugins_write(projectId, text, baseRevision)` follows the notes revision rule
      (a stale base gives `stale:`). It also refuses text that doesn't parse, and
      returns the problems, so Duck (W5) can't leave the toolbar broken.
    - `plugins_init` creates the file with a starter `git status` action when there
      is none.
    - A `notify` watcher on the notes root emits `plugins-changed { projectId }`,
      coalesced over 150 ms.
  - **PTY:**
    - `SpawnKind::Task`; the spawn result carries the filled argv for the panel.
    - `pty-exited { id, code }` comes from a per-spawn watcher that polls the child
      every 250 ms. It doesn't wait for the end of the output, because under ConPTY
      the pipe can stay open after the child is gone. Each spawn has a generation, so
      a killed or respawned child reports nothing.
    - Stopping a task kills its whole tree with `taskkill /T /F` (`kill -TERM -pgid`
      on Unix): `cmd → npm → node → vite` would otherwise outlive the stop.
    - `CREATE_NO_WINDOW` doesn't apply to ConPTY children, which have no console
      window; it is used for `taskkill`.
  - **Frontend:**
    - `state/plugins.ts` holds the last read per project and the field values
      (prefs `pluginValues`, keyed `pluginId.controlId`). `state/pluginModel.ts` has
      the pure helpers, tested in `pluginModel.test.ts`. `state/tasks.ts` holds the
      task panels. `panels/pluginRun.ts` has run, stop and edit, and the confirm
      questions.
    - `panels/ProjectToolbar.tsx`:
      - The groups are measured in an off-screen row, and the ones that don't fit
        fold into "▾ more". The project name gives up the room down to 120 px.
      - A broken file shows "⚠ plugins": it opens the file and lists the problems
        with their paths.
      - A button shows a spinner while its run goes, "■ stop …" for a `long`
        action, then ✓ or ✗ with the exit code for a minute.
      - Enter in a text field runs the plugin's first action.
    - `panels/TaskPanel.tsx`:
      - A header shows the label, the argv that ran and the working dir. A footer
        shows the state, with **stop** and **run again**.
      - The terminal is keyed on the run number, so a re-run starts on a clean screen
        in the same panel. A stopped run keeps its output.
      - Task panels round-trip in layouts and presets (`tasks`, defaulting to `[]`,
        no schema bump) and come back dormant.
    - The palette lists every action of the active project, plus **Plugins: reload**
      and **Plugins: edit** (unbound keymap commands).
  - **Not as planned:** the editor saves `plugins.json` through its usual
    `write_file`, like any other file, not through `plugins_write`. The editor has no
    revisions. The watcher redraws the toolbar either way.
  - **SSH projects:** actions run on this machine. A `cwd` that only exists on the host
    fails with a message saying so.
  - **Tests:**
    - `plugins::format`: the parser (unknown fields, problems at their paths, ids,
      placeholders, the program and shell-code rules, patterns) and substitution (single
      arguments, checkboxes, stale values, the batch-file wrapping and refusals).
    - `plugins`: read, write and init.
    - `pluginModel.test.ts`.
  - **Checked live** (debug app; a `plugins.json` for the workbench project, with
    `cwd` pointed at this worktree):
    - **echo** (a select, a text field, and
      `node -e "console.log(JSON.stringify(process.argv.slice(1)))" {mode} {text}`)
      with `a & calc` printed `["one","a & calc"]` and ended ✓. No calculator
      started.
    - The same value into a `.cmd` script was refused with the reason, and nothing ran.
    - Adding an unknown field to the file turned the toolbar into "⚠ plugins" within
      a second; its list showed `plugins[0].actions[1].lon`. Restoring the file brought
      the toolbar back.
    - A `long` action running `npx vite --port 1441` showed "■ stop dev". Stop freed
      the port and ended the vite process (a grandchild); the output stayed, marked
      "■ stopped".
    - After a restart, every task panel came back dormant, and the text field kept its
      value.
    - The real "dev" action (`npm run tauri:dev`) wasn't run from the debug app: it
      would fight that app's own dev server for port 1430. Vite stood in for it.
    - **installer** (`npm run tauri:build`) ran the release build in its task panel,
      wrote `Workbench_2.0.3_x64-setup.exe`, and ended ✓ with exit 0. The button showed
      the spinner, then ✓.
    - **Plugins: edit** from the palette opened `plugins.json` in the project's editor.

---

## Sequencing

```
C1 ─ C2 ─ C3
T0 ─ T1 ─ T2 ─ T3 ─ T4
               └─ T5 ──────────┐
D1 (─ D2)                      │
V1 ─ V2                        │
   └ V3 ─ A1                   │
N1 (─ N2) ─ N3                 │
N1 ─ R8 (also needs R1)        │
R2 ─ R3 ─ R6                   │
T2 ─ R1 ─ R4 ─────────────── R5
     └ R7
T2 ─ P1
M1
N1 ─ K1 (parallel with the assistant plan, in its own worktree)
```

Suggested order: **C1 → T0 → T1 → T2 → T3 → T4 → T5 → C2 → C3 → D1 → R1 → R7 → R2 → R3 → R4 →
R5 → V1 → V2 → V3 → N1 → R8 → P1 → R6 → A1**, with M1, N2 and D2 whenever convenient. N3
is needed once there's a second machine. K1 runs in parallel with Duck's steps, in its own
worktree session. Whichever of N3 and the assistant plan's L1 comes
first builds the shared git queue.

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
| 6 | `@codemirror/merge` vs extending `UnifiedDiff` — **`@codemirror/merge`**; the edit mode folds into the diff | V1 |
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
| D2 | Drag files from the OS (spike) | ☑ |
| V1 | Diff rendering | ☑ |
| V2 | Diff navigation + freshness | ☑ |
| V3 | Inline comments to the agent | ☑ |
| N1 | Project notes panel | ☑ |
| N2 | Rendered-while-editing markdown | ☑ |
| N3 | Notes sync across machines | ☐ |
| R1 | PWA build | ☑ |
| R2 | Pairing / auth hardening | ☑ |
| R3 | Tailscale Funnel | ☑ |
| R4 | Phone transcript + composer | ☑ |
| R5 | Phone choice cards | ☑ |
| R6 | Push notifications | ☐ |
| R7 | Phone: create a session | ☑ |
| R8 | Phone: project notes | ☑ |
| P1 | Open plan on demand | ☑ |
| A1 | Review with a fresh agent | ☑ |
| M1 | Run summary on done (mod) | ☐ |
| K1 | Project toolbar: plugin file, toolbar, task runs | ☑ |
