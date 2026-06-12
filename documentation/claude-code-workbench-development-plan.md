# Workbench — Development Plan

A step-by-step build plan for **Workbench** (see `claude-code-workbench-design.md` for the
full design). Each step is scoped to be completed by **Claude Code in a single pass**:
self-contained, with explicit scope, file hints, and a verifiable "done when".

**Platform priority:** Windows is the primary target. **Linux support is deferred to the
final phase** — but write platform-agnostic code throughout (the stack already abstracts
the hard parts: `portable-pty` covers ConPTY + Unix PTY, Tauri covers packaging). Don't
hardcode Windows paths, shells, or path separators; just don't *verify/package* Linux until
Phase 5.

---

## How to use this plan with Claude Code

1. **One step per session.** Start a fresh Claude Code session per step. Paste the step (or
   say "do Step 1.4 from the development plan"). Steps are ordered; respect **Depends on**.
2. **Read the referenced design sections first.** Each step lists **Design refs** (`§n`) into
   `claude-code-workbench-design.md`. Those are the source of truth for behavior.
3. **Honor the guardrails** (next section) on every step — they encode settled decisions that
   are painful to retrofit.
4. **Finish with the Definition of Done** (below) before marking the step complete.
5. **Update the progress tracker** checkbox at the bottom and write a commit with the
   suggested message.
6. **If a step is too large for one clean pass**, split it at the natural sub-bullet seam,
   land the first half, and continue in the next session. Steps flagged **(may need 2 passes)**
   are the likely candidates.

### Definition of Done (every step)
- Code compiles: `cargo build` (in `src-tauri/`) and `npm run build` (frontend) both clean.
- `cargo clippy -- -D warnings` clean for touched Rust; TypeScript is `strict`, no `any` leaks.
- The step's **Done when** criteria are met and **manually verified** by running
  `npm run tauri dev` and exercising the feature (this is a GUI app — automated tests cover
  logic, but the human-visible behavior must be eyeballed).
- No new `console.log`/`dbg!` noise; no dead code; comments only where non-obvious.
- Progress tracker updated; commit made.

### Guardrails (settled decisions — never violate)
- **Never drive Claude headless on the subscription.** Interactive PTY only (`§4.3`, decision 2).
- **Never parse `xterm` output for state.** Structured state comes from hooks + transcript
  files only (`§4.3`, `§4.4`).
- **Mint a UUID and launch with `claude --session-id <uuid>`** so PTY→card mapping happens at
  spawn, never by racing `SessionStart` (`§4.2`, decision 12).
- **Hook server filters by `session_id`** — drop any event from a session Workbench didn't
  mint. Build this filter the moment the hook server exists (`§4.4`, decision 10).
- **Hooks + statusline install at user level** (`~/.claude/settings.json`) so worktree dirs
  are covered by one install (`§4.4`, `§4.5`, decisions 10, 17).
- **Status precedence is a sticky state machine** — tool events never downgrade a
  "needs you"/"done" card; debounce tool-event repaints (`§4.4`, decision 15).
- **Cap webgl-rendered consoles at ~10**, canvas/DOM fallback beyond (`§5`, `§9`, decision 14).
- **OS-window tear-off is Phase 4**, gated behind the PTY multiplexer; ship in-window float
  only before then (`§5`, decision 13).
- **Cost/tokens/limits are read-only telemetry**, not hook payloads: tokens from transcript
  JSONL, limits from the statusline side-channel (`§4.5`, decisions 16, 17).
- **Frontend is React/TS** (decision 11). **Editor is CodeMirror 6**. **Layout is `dockview`**.

---

## Tech stack & repo layout (reference)

| Concern | Pick |
|---|---|
| App shell | Tauri 2 (Rust core + system webview) |
| Frontend | React + TypeScript + Vite |
| Panel layout | `dockview` (React build) |
| Terminals | `portable-pty` (Rust) ↔ `xterm.js` over Tauri **Channels** (addons: fit, search, webgl) |
| Editor | CodeMirror 6 |
| State | SQLite via `rusqlite` (or `tauri-plugin-sql`); `tauri-plugin-store` for prefs |
| Git | `git2` (libgit2) or shell-out to `git` |
| Hook bridge | `axum` HTTP server on `127.0.0.1` |
| Notifications | `tauri-plugin-notification` + Tauri tray |

**Suggested layout** (file hints in steps reference this — adjust as the scaffold dictates):

```
workbench/
├─ documentation/
│  ├─ claude-code-workbench-design.md
│  └─ claude-code-workbench-development-plan.md   ← this file
├─ src/                         # React/TS frontend
│  ├─ main.tsx, App.tsx
│  ├─ theme/                    # design tokens, xterm theme generator, CRT overlay
│  ├─ panels/                   # Console, Shell, Editor, Preview, Diff, InstanceManager
│  ├─ state/                    # stores (instances, layout, status, usage)
│  ├─ ipc/                      # typed wrappers over Tauri commands/events
│  └─ keyboard/                 # keymap, command palette
└─ src-tauri/
   ├─ src/
   │  ├─ lib.rs, main.rs
   │  ├─ pty/                   # portable-pty children, Channel streaming, multiplexer
   │  ├─ hooks/                 # axum server, session_id filter, event types
   │  ├─ statusline/            # managed statusline script + ingest endpoint
   │  ├─ registry/              # groups/projects/instances
   │  ├─ db/                    # rusqlite schema + migrations
   │  ├─ git/                   # worktree + diff ops
   │  └─ transcript/            # JSONL tailer (tokens/cost)
   └─ tauri.conf.json
```

**Streaming convention:** PTY output → frontend via a Tauri **`Channel<Vec<u8>>`** per PTY
(efficient binary streaming); keystrokes + resize → backend via `#[tauri::command]`. Don't
emit per-byte global events.

---

## Phase 0 — Spike: prove the hard part (`§8` Phase 0)

> The PTY↔webview bridge is the only genuinely risky part of going Tauri-native. Prove it on
> Windows before building anything else.

### Step 0.1 — Scaffold the app
- **Goal:** A running Tauri 2 + React/TS + Vite window with the repo layout in place.
- **Depends on:** —
- **Design refs:** `§4.1`, `§9`.
- **Build:** `create-tauri-app` (React/TS template); set up Vite, ESLint, `tsconfig` strict,
  `cargo` workspace; commit a blank themed window titled "Workbench". Add `npm run tauri dev`
  and `npm run tauri build` scripts. Wire `dockview` and `xterm.js` as deps (not used yet).
- **Key files:** whole scaffold; `src-tauri/tauri.conf.json`, `package.json`, `src/App.tsx`.
- **Done when:** `npm run tauri dev` opens a window on Windows; build is clean.
- **Out of scope:** any real UI.

### Step 0.2 — PTY bridge spike (shell) **(the de-risk)**
- **Goal:** A `portable-pty` child running the user's shell (`pwsh.exe`), streamed to a single
  `xterm.js` instance, with keystrokes and resize flowing back.
- **Depends on:** 0.1
- **Design refs:** `§4.1` (the one real cost), `§4.2`.
- **Build:** Rust: spawn shell via `portable-pty`, read its output on a thread, push bytes to
  the frontend over a `Channel<Vec<u8>>`. Commands: `pty_spawn`, `pty_write(bytes)`,
  `pty_resize(cols, rows)`, `pty_kill`. Frontend: mount `xterm.js` + fit addon, feed channel
  bytes to `term.write`, send `onData`/resize back.
- **Key files:** `src-tauri/src/pty/`, `src/panels/Console.tsx`, `src/ipc/pty.ts`.
- **Done when:** You can type commands in the embedded terminal on Windows, see output live,
  and resizing the window reflows the shell. No lag, no byte corruption on large output.
- **Out of scope:** multiple PTYs, claude, theming.

### Step 0.3 — Run real `claude` in the console
- **Goal:** Spawn interactive `claude` (not a shell) in a chosen directory with a minted
  `--session-id`, full TUI rendering in `xterm.js`.
- **Depends on:** 0.2
- **Design refs:** `§4.2`, `§4.3`, guardrails.
- **Build:** Generalize 0.2 to launch `claude --session-id <uuid>` in a working dir. Verify
  the real TUI works: plan mode, a permission prompt, a slash command, the status line all
  render and are interactive. Generate the UUID in Rust; expose it on the spawn result.
- **Key files:** `src-tauri/src/pty/`.
- **Done when:** A full Claude Code session is usable inside the embedded console on Windows,
  including approving a permission prompt by keyboard.
- **Out of scope:** mapping to a card (no registry yet); just prove fidelity.

---

## Phase 1 — MVP: daily-usable workbench (`§8` Phase 1)

### Step 1.1 — Theme system & retro chrome
- **Goal:** The shared theme-token layer that feeds CSS variables **and** the `xterm.js` theme,
  plus the box-drawing chrome aesthetic.
- **Depends on:** 0.1
- **Design refs:** `§5.x`.
- **Build:** A single theme token file → CSS custom properties + a function that derives the
  `xterm.js` theme object from it. Monospace-everywhere base; status glyph palette
  (`● ◐ ○ ⑃ ▸ ✓ ✗`); thin square-cornered borders with terminal title bars; the braille
  spinner frames. Ship one default theme ("muted dark"); leave variants/CRT for Phase 3.
- **Key files:** `src/theme/`, global CSS.
- **Done when:** The 0.x console and the app chrome read as one continuous terminal surface;
  changing a token recolors both chrome and the xterm theme.
- **Out of scope:** multiple presets, CRT overlay, per-instance accent.

### Step 1.2 — Persistence layer & data model
- **Goal:** SQLite schema and typed Rust CRUD for Group / Project / Instance, plus prefs store.
- **Depends on:** 0.1
- **Design refs:** `§3`, `§4.5`(persistence/§4.6).
- **Build:** `rusqlite` with a migrations module. Tables: `groups`, `projects` (root path,
  default branch, group_id), `instances` (project_id, title, task_note, worktree_on, branch,
  last_session_id, working_dir, cost/token cache, status). Tauri commands for CRUD. Wire
  `tauri-plugin-store` for prefs. Define matching TS types in `src/ipc/`.
- **Key files:** `src-tauri/src/db/`, `src-tauri/src/registry/`, `src/ipc/registry.ts`.
- **Done when:** Commands round-trip a group→project→instance through SQLite; data survives
  app restart. Schema has a migration path.
- **Out of scope:** UI.

### Step 1.3 — Project registry UI
- **Goal:** Register projects (folder picker), assign to groups, list/edit/remove.
- **Depends on:** 1.2, 1.1
- **Design refs:** `§3`, `§5` (Instance Manager).
- **Build:** "Add project" via Tauri dialog folder picker; detect git repo + default branch;
  optional group assignment/creation; edit/remove. Persist via 1.2 commands.
- **Key files:** `src/panels/InstanceManager/`, `src/state/`.
- **Done when:** You can register a real repo, see it grouped, and it persists across restart.
- **Out of scope:** instances, status dots.

### Step 1.4 — Instance Manager rail
- **Goal:** The left rail tree (Group → Project → Instance) with task notes and row actions.
- **Depends on:** 1.3
- **Design refs:** `§5` (Instance Manager), `§3` (session note).
- **Build:** Collapsible tree; each instance row shows title + **task note** (inline-editable),
  a status dot (static placeholder for now), branch, last-activity, ⑃ worktree marker slot,
  mini cost slot. Header summary line ("N agents need you" — wired to status in Phase 2). Row
  actions wired to commands: new instance, rename, edit note, kill, open working dir in OS file
  manager. Worktree toggle present but **stubbed** (persists the flag only).
- **Key files:** `src/panels/InstanceManager/`.
- **Done when:** Full CRUD of instances from the rail; notes edit and persist; tree collapses;
  keyboard-focusable rows.
- **Out of scope:** live status, real worktree provisioning, console wiring (next step).

### Step 1.5 — Instance lifecycle ↔ console
- **Goal:** Launching an instance spawns `claude` (minted UUID) in the project root and binds it
  to a Console panel; support several instances at once.
- **Depends on:** 1.4, 0.3
- **Design refs:** `§4.2`, `§4.3`.
- **Build:** "New instance" → spawn `claude --session-id <uuid>` in `working_dir`; persist
  uuid/branch; maintain a backend map `session_id → instance_id → PTY`. Clicking an instance
  focuses/opens its console. Kill terminates the PTY and updates the row. Apply the
  **webgl-cap rule** (≤10 webgl consoles; canvas fallback) when many are open.
- **Key files:** `src-tauri/src/pty/`, `src-tauri/src/registry/`, `src/panels/Console.tsx`.
- **Done when:** Two instances on one project run side by side in two consoles; kill/relaunch
  works; the renderer cap engages past 10.
- **Out of scope:** dockview arrangement (next), status dots.

### Step 1.6 — Dockview panel system + layout persistence **(may need 2 passes)**
- **Goal:** Replace ad-hoc panel placement with `dockview`: split / tab / float **in-window**;
  default arrangement; per-project layout saved & restored.
- **Depends on:** 1.5
- **Design refs:** `§5`, decision 13 (no OS-window tear-off yet).
- **Build:** Integrate `dockview` (React). Register panel types: Instance Manager (pinned rail),
  Claude Console, (Shell/Editor stubs to be filled by 1.7/1.8). Default 3-pane layout from `§5`.
  Serialize the dock tree per project to SQLite; restore on project open. Splitters draggable;
  rail collapsible. Console header strip: project · branch · task note · short session id ·
  cost slot.
- **Key files:** `src/panels/`, `src/state/layout.ts`, layout (de)serialization in `db`.
- **Done when:** You can split a console, tab two consoles, float a panel in-window, resize,
  reopen the project, and get the same layout back.
- **Out of scope:** named presets (Phase 3), OS-window tear-off (Phase 4).

### Step 1.7 — Project Shell panel
- **Goal:** A Shell panel = separate PTY running `pwsh.exe` in a chosen instance's working dir.
- **Depends on:** 1.6
- **Design refs:** `§5` (Project Shell), `§4.2`.
- **Build:** Reuse the PTY bridge for a shell child bound to a working dir. Pre-seed a
  `git status` line; quick buttons for status / diff / commit (shell-out). Selectable which
  instance's working dir it targets.
- **Key files:** `src/panels/Shell.tsx`, `src-tauri/src/pty/`.
- **Done when:** A shell opens in the right dir, runs git/tests, lives in the dock beside a
  console.
- **Out of scope:** the Diff/Review panel (Phase 2).

### Step 1.8 — Editor panel (CodeMirror 6) **(may need 2 passes)**
- **Goal:** A themed CodeMirror 6 editor with a file tree scoped to the working dir, tabs,
  dirty indicators, save.
- **Depends on:** 1.6, 1.1
- **Design refs:** `§5` (Editor), `§9`.
- **Build:** File tree (read dir via Tauri fs) scoped to an instance's working dir; open files
  in CodeMirror 6 tabs; language detection (markdown + common code); dirty dots; save to disk;
  CodeMirror theme matched to the active app theme.
- **Key files:** `src/panels/Editor/`.
- **Done when:** Open, edit, save a file from the tree; theme matches chrome; dirty state shows
  and clears on save.
- **Out of scope:** LSP, multi-cursor IDE features (explicit non-goal), preview (next).

### Step 1.9 — Markdown preview
- **Goal:** Live markdown preview, either toggled within the Editor panel or as a side panel.
- **Depends on:** 1.8
- **Design refs:** `§5` (Editor + Markdown Preview).
- **Build:** Render the active markdown buffer to a preview pane (toggle in-panel + a separate
  dockable Preview panel option); themed to match. Scroll-reasonable.
- **Done when:** Editing markdown updates the preview live; preview can sit side-by-side.
- **Out of scope:** export, mermaid/plugins.

### Step 1.10 — Keyboard-first core
- **Goal:** The keyboard navigation baseline so the MVP is usable without a mouse.
- **Depends on:** 1.6
- **Design refs:** `§5.y`, `§1` (keyboard-first).
- **Build:** Bindings: focus rail, cycle panels/tabs (`Ctrl+Tab`), focus numbered panel, split
  (`Ctrl/Cmd+\`), close panel (`Ctrl+W`), switch/launch/kill instance, edit task note, interrupt
  agent. Centralize in `src/keyboard/` with a binding registry (remappable later). Leave
  "jump to next needs-you" as a registered no-op until Phase 2.
- **Done when:** Every MVP action above is reachable from the keyboard; bindings live in one
  registry.
- **Out of scope:** full command palette, vim/modal scheme, remap UI (Phase 3).

---

## Phase 2 — The differentiator: status engine, notifications, worktrees (`§8` Phase 2)

### Step 2.1 — Hook HTTP server + user-level install + session_id filter
- **Goal:** The local `axum` endpoint that receives `http` hooks, installed at user level, with
  the session-id filter from day one.
- **Depends on:** 1.5
- **Design refs:** `§4.4`, decision 10, guardrails.
- **Build:** `axum` server on `127.0.0.1:<port>` (port persisted/prefs). On first run, write
  `http`-type hooks into `~/.claude/settings.json` for the relevant events
  (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PermissionDenied`,
  `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`,
  `PreCompact`), POSTing payloads incl. `session_id`. **Drop any event whose `session_id` isn't
  a registered instance.** Idempotent install (don't duplicate existing Workbench hooks; chain,
  don't clobber, foreign hooks). Typed event structs.
- **Key files:** `src-tauri/src/hooks/`.
- **Done when:** Events from a Workbench-launched session hit the endpoint and are parsed;
  events from a `claude` run outside Workbench are received but **dropped** by the filter;
  re-running install doesn't duplicate entries.
- **Out of scope:** the status state machine (next), notifications.

### Step 2.2 — Status state machine
- **Goal:** Map the hook stream to card status with the sticky precedence rules; wire to the
  rail; spinner + subagent nesting; debounced repaints.
- **Depends on:** 2.1, 1.4
- **Design refs:** `§4.4` (event→status table + state machine), decision 15.
- **Build:** Implement the precedence machine: `PermissionRequest`/`idle_prompt`/`Stop` are
  sticky "needs you"/"done"; tool events never downgrade a sticky state; sticky clears on next
  `UserPromptSubmit`, `PermissionDenied`, or `SessionEnd`. Debounce tool-event repaints
  (~100–200 ms/card); sticky transitions bypass the debounce (instant). Drive the rail status
  dots, working spinner, `SubagentStart/Stop` nested spinner, and "compacting…" transient.
- **Key files:** `src-tauri/src/hooks/`, `src/state/status.ts`, rail components.
- **Done when:** A live session shows ◐ while working, flips to ● the instant a permission
  prompt appears (and stays ● through tool churn), ○ on Stop, and clears correctly on your next
  prompt. Subagent activity nests.
- **Out of scope:** notifications/tray (next).

### Step 2.3 — Notifications, tray badge, attention focus
- **Goal:** OS notifications + tray badge for "needs you", rail attention filter, and
  jump-to-next-needs-you.
- **Depends on:** 2.2
- **Design refs:** `§4.4` (bonus), `§5.y`, `§7` (attention summary).
- **Build:** `tauri-plugin-notification` on transition into ● needs-you; Tauri tray badge =
  count of needs-you instances; rail header "N agents need you" + filter to show only those;
  bind the "jump to next agent that needs you" key (was a no-op in 1.10).
- **Done when:** A backgrounded agent hitting a permission prompt fires a desktop notification,
  bumps the tray count, and the hotkey jumps focus to it.
- **Out of scope:** Discord/phone routing, idle/stuck escalation (Phase 4).

### Step 2.4 — Worktree provisioning (toggle ON)
- **Goal:** The per-instance worktree toggle actually provisions an isolated worktree.
- **Depends on:** 1.5, 2.1
- **Design refs:** `§6`, decisions 5, 7.
- **Build:** On toggle ON: `git worktree add <path> -b agent/<slug>` under
  `.workbench/worktrees/<slug>/` (path configurable in settings); set the instance's working
  dir to the worktree; relaunch `claude` there; show the ⑃ marker + branch. Because hooks are
  user-level, the worktree dir is already covered. Use `git2` or shell-out consistently.
- **Done when:** Toggling a fresh instance ON creates a worktree on its own branch, and its
  console runs there; status hooks still report (filter passes).
- **Out of scope:** post-create setup + merge/cleanup (next).

### Step 2.5 — Worktree post-create & teardown
- **Goal:** Handle the `.env`/`node_modules` gotcha and the done→merge/remove flow.
- **Depends on:** 2.4
- **Design refs:** `§6` (gotcha), `§7` (one-click merge).
- **Build:** Optional post-create step: copy `.env`, symlink/install deps, or run a user-defined
  setup command (configurable per project). On "done": show diff (uses 2.7 if landed, else a
  basic summary), offer **merge** / open PR / `git worktree remove` cleanup.
- **Done when:** A worktree instance can run a configured setup command on create, and be
  merged + cleaned up from the UI.
- **Out of scope:** broadcast+compare (Phase 4).

### Step 2.6 — Shared-working-dir warning
- **Goal:** Warn (never block) when two toggle-off instances share a project root; offer
  one-click isolate.
- **Depends on:** 2.4
- **Design refs:** `§6` (caveat), decision 6.
- **Build:** Detect ≥2 worktree-off instances with the same working dir; show a non-blocking
  "shared working dir" warning on those cards + a one-click "isolate in a worktree" action that
  runs the 2.4 flow.
- **Done when:** Two root-sharing instances surface the warning; the isolate action moves one
  into a fresh worktree without disrupting the other.
- **Out of scope:** blocking behavior (explicitly not wanted).

### Step 2.7 — Diff / Review panel
- **Goal:** A panel showing what an instance changed vs its branch base, with inline edit+save.
- **Depends on:** 1.6, 1.8
- **Design refs:** `§5` (Diff/Review).
- **Build:** Compute diff against branch base (`git2`/shell-out); render in a dockable panel
  bound to an instance; allow small inline edits saved to disk (reuse CodeMirror). This is the
  "make small changes to files Claude edited" loop.
- **Done when:** Selecting an instance shows its diff; editing a hunk and saving writes to the
  file; the diff refreshes.
- **Out of scope:** staging UI, commit composer (use the shell).

---

## Phase 3 — Polish & power features (`§8` Phase 3)

### Step 3.1 — Transcript-tailing: cumulative tokens
- **Goal:** The file-tailing telemetry subsystem: per-session cumulative tokens.
- **Depends on:** 1.5
- **Design refs:** `§4.5`, decision 16.
- **Build:** Tail the session transcript (located by globbing
  `~/.claude/projects/*/<session-id>.jsonl` — the UUID is unique across project folders, so
  this sidesteps reproducing Claude Code's cwd→folder encoding, which differs for worktrees).
  Track the **latest main-thread assistant turn's** `usage` and surface its **context-window
  occupancy** = `input + cache_creation + cache_read` — the same figure `/context` shows ("how
  full is this agent's context"). This is the *latest turn*, **not a cumulative sum**: a sum
  balloons every turn (each re-reads the whole cached prefix) and diverges wildly from `/context`
  (cumulative ≈ 212K vs window ≈ 48K on the same session). Skip `isSidechain` turns (subagents
  have their own window). Read incrementally (byte offset + buffered partial line) so a long
  session isn't re-parsed each tick. Persist to the instance row and emit a `usage-updated` event
  for the live UI. Show the window figure on the instance card and as `ctx NNk` in the console
  header, with the input/cache-write/cache-read breakdown in a tooltip.
- **Cost dropped (project decision):** tokens are the only figure surfaced. Cost is *not*
  computed or shown — removing the pricing-table / `~/.claude/statusline.jsonl` dependency (that
  file doesn't exist by default and transcripts no longer carry per-message cost).
- **No `%` yet:** the transcript records the model (`claude-opus-4-8`) but not the 200k-vs-1M
  variant, so the `/context` denominator isn't reliably knowable here. Show the absolute window;
  a `%` can come from 3.2's statusline (which carries the limit).
- **Done when:** A running session's card + console header show the live context-window size,
  matching `/context`, and it shrinks after `/compact` or `/clear`.
- **Out of scope:** cumulative/lifetime token totals; cost; the usage-limit meter (3.2).

### Step 3.2 — Usage-limit meter via managed statusline
- **Goal:** Account-wide 5-hour + weekly usage meter with reset countdowns.
- **Depends on:** 2.1, 3.1
- **Design refs:** `§4.5` (statusline side-channel), decision 17.
- **Build:** Install a **managed statusline script** at user level that receives Claude Code's
  statusline JSON, POSTs the `rate_limits` object (`five_hour`/`seven_day`:
  `used_percentage`, `resets_at`) to the local server, then prints a useful status line
  (model · branch · cost). **Chain** any pre-existing user statusline rather than clobber it.
  Render one app-global meter (header + tray) with live countdowns from `resets_at`. Handle
  "not present yet" / non-Pro-Max gracefully; add a tooltip noting figures are machine-local
  and approximate.
- **Done when:** After the first API response in any session, the header shows 5h + weekly
  percent used with a countdown; a user's existing statusline still renders.
- **Out of scope:** cross-device reconciliation (not possible — note it).

### Step 3.3 — Layout presets
- **Goal:** Save/switch named layout arrangements by hotkey.
- **Depends on:** 1.6
- **Design refs:** `§5`, `§7` (layout presets).
- **Build:** Save the current dock tree as a named preset ("2-up review", "single focus",
  "writing: editor + preview"); switch via command palette and number keys. Persist presets.
- **Done when:** Saving and recalling presets by number reproduces the arrangement.

### Step 3.4 — Prompt template library
- **Goal:** Save/insert reusable prompts with `{0}`/`{1}` fill-in.
- **Depends on:** 1.5, 1.10
- **Design refs:** `§7` (prompt template library).
- **Build:** Save the currently-typed prompt from the focused console into a named template
  (one keystroke); CRUD templates; positional placeholders `{0}`,`{1}`,… → a fill-in form on
  insert; substitute and insert/send into any instance via palette/picker. Per-project vs
  global scope. (Optional: named placeholders, defaults.)
- **Done when:** Save a template with placeholders, pick it for any instance, fill the form,
  and the resolved prompt lands in that console.

### Step 3.5 — Prompt queue
- **Goal:** Queue a follow-up prompt that auto-sends when the agent finishes its turn.
- **Depends on:** 2.2
- **Design refs:** `§7` (prompt queue).
- **Build:** Let a user queue text for an instance; on that instance's `Stop` event, auto-send
  the queued prompt into its PTY. Show queued state on the card; allow cancel.
- **Done when:** Queueing a prompt then letting the agent finish auto-sends it; cancel works.

### Step 3.6 — CLAUDE.md quick-editor
- **Goal:** Edit a project's `CLAUDE.md` in-app.
- **Depends on:** 1.8
- **Design refs:** `§7` (CLAUDE.md editor).
- **Build:** A per-project action opening `CLAUDE.md` in the editor (create if missing), with
  preview. Reuses 1.8/1.9.
- **Done when:** Open, edit, save a project's `CLAUDE.md` without leaving Workbench.

### Step 3.7 — MCP server manager **(may need 2 passes)**
- **Goal:** View/edit MCP servers across user / project / local scopes.
- **Depends on:** 1.3
- **Design refs:** `§7` (MCP server manager).
- **Build:** List servers per scope with precedence shown (local > project > user); add / edit /
  remove / enable with transport (stdio/http), args, env, headers. **Drive writes through
  `claude mcp add/remove/list`** where possible (authoritative; avoids corrupting the large
  `~/.claude.json`); offer a raw-JSON editor for the small `.mcp.json`. Surface the two
  gotchas: project servers need a trust/approval prompt before first use; MCP "local" scope
  (`~/.claude.json`) ≠ `.claude/settings.local.json`.
- **Done when:** You can see all three scopes with precedence, add a stdio + an http server via
  the CLI path, and edit `.mcp.json` raw — without corrupting `~/.claude.json`.

### Step 3.7b — Skill manager **(may need 2 passes)**
- **Goal:** View / create / edit / remove Agent Skills across user and project scopes.
- **Depends on:** 3.6
- **Design refs:** `§7` (Skill/plugin awareness; reuses the CLAUDE.md editor).
- **Build:** List skills per scope — user (`~/.claude/skills/<name>/SKILL.md`) and project
  (`.claude/skills/<name>/SKILL.md`) — showing each skill's scope and, where available, whether
  it's currently loaded in a session (cross-reference the `system/init` event). **Create**
  scaffolds a new `<name>/SKILL.md` with valid frontmatter (`name`, `description`); **edit** opens
  `SKILL.md` in the 3.6 editor with frontmatter validation (kebab-case `name`, non-empty
  `description`) + markdown preview; **remove** deletes the folder (behind confirmation);
  enable/disable by toggling. A "try it" action inserts `/<name>` into the focused console so you
  can iterate on the description until the skill actually triggers. Plugin-bundled skills are shown
  read-only (awareness, not editing). Unlike 3.7, these are **pure filesystem ops** — a folder + a
  markdown file per skill, no shared-JSON corruption risk and no CLI dependency.
- **Done when:** You can see user + project skills with their scope, scaffold a new skill with
  valid frontmatter, edit + preview it in-app, invoke it via `/<name>` in a console, and delete it
  — all without leaving Workbench.

### Step 3.8 — Session restore (`Ctrl+Shift+T`)
- **Goal:** Reopen yesterday's instances in place, resumed.
- **Depends on:** 1.6, 1.5
- **Design refs:** `§4.5`(persistence), `§7` (session restore), decision 12.
- **Build:** On quit, persist open instances **with layout positions**. On launch, read
  `~/.claude/projects/` and offer to restore; `Ctrl+Shift+T` reopens them in place via
  `claude --resume <session_id>`. Same shortcut also reopens individually-closed sessions,
  most-recent-first (browser-tab reflex). Optional auto-offer restore prompt on launch.
- **Done when:** Quit with 3 instances + a layout, relaunch, hit `Ctrl+Shift+T`, and they
  return in place and resume; closing one then `Ctrl+Shift+T` reopens it.

### Step 3.9 — Theme variants, CRT toggle, per-instance accent
- **Goal:** Ship the look-and-feel options.
- **Depends on:** 1.1
- **Design refs:** `§5.x` (themes, effects).
- **Build:** Presets (green phosphor, amber, cyan/synthwave, muted dark); off-by-default CRT
  overlay (single GPU-cheap CSS layer: scanlines, faint glow, vignette, blinking cursor);
  per-instance accent overlay. Each preset regenerates the xterm theme.
- **Done when:** Switching presets recolors chrome + xterm + CodeMirror together; CRT toggles
  cleanly; per-instance accent shows on cards/consoles.

### Step 3.10 — Command palette, remappable keys, permission-mode quick switch
- **Goal:** Complete keyboard-first control.
- **Depends on:** 1.10
- **Design refs:** `§5.y`, `§7` (permission-mode quick switch).
- **Build:** Fuzzy command palette listing every action with its binding; remap UI persisting
  to a keymap file; permission-mode quick switch (plan / accept-edits / default) per session
  sent into the PTY. (Optional: vim/modal scheme behind a setting.)
- **Done when:** Every registered action is searchable in the palette with its binding; a
  binding can be remapped and persists; permission mode can be switched from the UI.

### Step 3.11 — Git panel (history / branches / checkout) **(may need 2 passes)**
- **Goal:** A project-scoped Git panel: browse history, manage branches (checkout/create/
  delete), inspect the working tree (stage/stash/discard), and fetch/pull/push — the repo-level
  counterpart to the instance-scoped Diff/Review panel.
- **Depends on:** 1.6, 2.7
- **Design refs:** `§5` (Git), `§7` (Git panel), `§6` (worktree relation).
- **Build:** A dockable panel bound to a **project** (not an instance). Read paths via `git2`
  (libgit2) so they're fast and don't shell out per row: commit log (graph where it helps,
  author/date/message/short-SHA in the box-drawing aesthetic), branch list with ahead/behind,
  status (staged/unstaged/untracked), and per-commit diff + changed-file list. Write paths:
  checkout, create/rename/delete branch, stage/unstage hunks, stash/pop, fetch/pull/push —
  shelling out to `git` for the cases libgit2 handles awkwardly (merge/rebase, push-with-creds).
  **Read-first, write-behind-confirmation:** any state-rewriting op (force-push, branch delete,
  discard, hard reset) sits behind an explicit confirm and is logged; **never auto-push**.
  Checking out a branch in a project with live worktree instances surfaces the same
  **shared-working-dir warning** as 2.6/`§6` (you're moving HEAD under an agent). Worktree
  create/remove stays an **instance-card** action (2.4/2.5) — the Git panel shows worktree
  branches as ordinary branches but doesn't own their lifecycle. Wire git actions into the
  command palette (3.10) with bindings; keyboard-navigable history + checkout (`§5.y`).
- **Key files:** `src/panels/Git/`, `src-tauri/src/git/` (extend the diff/worktree module),
  `src/ipc/git.ts`.
- **Done when:** Opening the Git panel on a real repo shows live history and branches; you can
  check out a branch (with the warning when worktree instances are live), stash and pop, and
  fetch/pull/push; destructive ops prompt for confirmation; the view refreshes after each action.
- **Out of scope:** a full commit composer / interactive rebase UI (use the Project Shell);
  worktree provisioning (owned by 2.4/2.5).

### Step 3.12 — Remote projects (SSH + tmux), no telemetry **(may need 2 passes)**
- **Goal:** Let a project point at a **remote host over SSH** instead of a local folder, run
  each instance as a persistent **tmux session** there, and drive its `claude` TUI in a normal
  Console — so you can supervise agents on your server box alongside local ones. **Telemetry is
  deliberately out of scope for remote** (no hooks, no tokens, no usage meter, no git/diff): the
  remote agent's user-level hooks POST to *its* localhost and its transcript lives on *its* disk,
  neither of which crosses the SSH boundary, so those subsystems simply stay inert for remote
  instances rather than being wired across. Remote projects and instances are **clearly badged**
  as remote in the UI.
- **Depends on:** 1.5, 1.3
- **Design refs:** `§4.2` (PTY-as-bytes; the bridge is transport-agnostic), `§3` (data model).
  **Not to be confused with Phase 4 / `§11`**, which is remote *access to Workbench itself*
  (phone → desktop over the tailnet). This step is the inverse: Workbench (local) → a remote
  agent over SSH.
- **Model (decided — "Model A"):** an **instance = one tmux *session*** on the host (named
  `wb-<short instance id>`), **not** a window in a shared session. One-session-per-instance is
  what sidesteps tmux's client-mirroring (multiple clients on the *same* session share one active
  window, so two consoles couldn't show two windows at once). A **project** groups those sessions
  on a single SSH destination. Persistence falls out for free: closing a console or quitting
  Workbench only *detaches* — the remote session (and `claude`) keep running and reattach on
  relaunch.
- **Build:**
  - **Data model (migration v5→v6, append-only per `db/mod.rs`).** Add to `projects`:
    `remote_ssh_dest TEXT` (NULL ⇒ local; non-NULL flags a remote project) and `remote_dir TEXT`
    (the working directory on the host). For a remote project, also store `remote_dir` into the
    existing `root_path` (kept NOT NULL) so code paths that read `root_path` for display don't
    break. Add to `instances`: `remote_tmux_session TEXT` (NULL for local; the session name —
    defaulted to `wb-<short id>` on create, or the adopted name on import). Extend the Rust
    `Project`/`Instance` structs + `New*`/`*Patch` + the TS types in `src/ipc/registry.ts` to
    carry these.
  - **SSH destination, not credentials.** The dialog takes a single **SSH destination string**
    (e.g. `myserver`, resolved from the user's `~/.ssh/config`) plus the remote dir; auth/host/
    port/key stay in SSH config where they belong. Don't build credential management. (Optional
    explicit `user@host:port` is fine, but lead with the config-alias path.)
  - **Spawn path (`pty/mod.rs`).** Thread an optional `remote: Option<RemoteSpawn>`
    (`{ dest, session, dir }`) into `pty_spawn`. When present, build the child as
    `ssh -tt <dest> -- tmux new-session -A -s <session> -c <dir> "bash -lc claude"` instead of the
    local `claude_command`. Notes: `-A` makes it **attach-or-create** (first launch creates the
    session and runs the command; a reconnect attaches the live one and *ignores* the command —
    exactly the desired reconnect semantics); `bash -lc` forces a **login shell** so `claude`/
    `tmux` are on PATH (an `ssh -- tmux …` non-login shell often isn't). The local `ssh` child is
    just another `portable-pty` child — **the reader thread, `pty_write`, `pty_resize`, output
    Channel are all unchanged** (this is the cheap part). Set `SpawnResult.session_id = None` for
    remote (no session-id minting — there's no local hook/transcript correlation to do), which
    `markSpawned` already tolerates.
  - **Frontend spawn threading.** `consoles.ts:openConsole` hardcodes `kind: "claude"`; for a
    remote instance, look up its project and pass the `remote` descriptor through
    `ConsoleSession` → `Console.tsx` → `terminalPool.acquire` → `ptySpawn`. Add the `remote` field
    to `src/ipc/pty.ts`'s `ptySpawn`.
  - **Add-project dialog (`ProjectDialog.tsx`).** Add a **"remote (SSH)"** toggle. When on:
    replace the folder picker + `detectRepo` git inspection (skip it entirely) with an SSH-dest
    field + a remote-dir field; hide the worktree-setup section (local-only). When off, the dialog
    is exactly as today.
  - **Lifecycle semantics (the key behavioral difference).** **Detach ≠ kill.** Closing the
    console or quitting Workbench lets the `ssh` child die, which only detaches tmux — the remote
    session persists (that's the whole point). **Removing** an instance must explicitly
    `ssh <dest> tmux kill-session -t <session>` *then* delete the row. Surface this in the rail's
    remove action for remote instances (e.g. confirm "kill remote session `wb-…`?").
  - **Discover & adopt existing sessions.** On opening a remote project (and via a refresh
    action), run `ssh <dest> tmux ls` and reconcile: mark our `wb-*` instances running vs detached,
    and offer to **import** any *other* live sessions on the host as new instances (attach as-is
    with `tmux attach -t <name>`, storing the adopted name in `remote_tmux_session`). This is the
    Model-A analog of "recognise what's already running on the server."
  - **Remote badging (explicit requirement).** Both the **project** header and every **instance
    card** for a remote project show a clear remote indicator (a new glyph, e.g. `⇄`, + the SSH
    dest, like `⇄ ssh:myserver`). Because there are no hooks, the instance status dot would lie —
    render a static **remote** glyph in its place instead of an idle/working dot.
  - **Gate local-only features off for remote instances** (don't wire them across): hook-driven
    status, transcript tokens, usage meter, worktree toggle, Diff/Review, Git panel, Editor file
    tree, shared-dir warning. They should be hidden or disabled (not error) when the owning project
    is remote.
  - **Resize caveat (note, not a blocker):** `portable-pty` resizes the local `ssh` PTY; ssh
    propagates the window-change to the remote PTY and tmux follows. tmux sizes a session to its
    *smallest* attached client, so a second hand-attached client elsewhere can shrink the view —
    a non-issue with only Workbench attached.
- **Key files:** `src-tauri/src/db/mod.rs` (migration), `src-tauri/src/registry/mod.rs`,
  `src-tauri/src/pty/mod.rs`, `src/ipc/registry.ts`, `src/ipc/pty.ts`,
  `src/panels/InstanceManager/ProjectDialog.tsx`, `src/panels/InstanceManager/InstanceCard.tsx`,
  `src/state/consoles.ts`, `src/panels/Console.tsx`, `src/panels/terminalPool.ts`, `src/theme/`
  (the remote glyph).
- **Done when:** You can "+ add project", flip it to remote, enter an SSH destination + remote
  dir; create an instance and watch its `claude` TUI run live in a Console over SSH+tmux; close
  the console and reopen it to find the **same session still running** (reattached); remove the
  instance and confirm the remote tmux session is gone (`tmux ls` no longer lists it); and the
  project + its instances are visibly badged as remote with no misleading status dots. A second
  remote instance runs side-by-side in its own console without mirroring.
- **Out of scope:** any remote telemetry (status/tokens/usage — explicitly excluded); remote
  git/diff/editor/shell panels (local-only this step; a remote shell could reuse the same SSH path
  later); reverse-tunnel/Tailscale hook bridging (that's the "real version" deferred); Model B
  (windows-of-one-session); credential/known-hosts management (delegated to SSH config).

---

## Phase 4 — Remote access & power features (`§8` Phase 4, `§11`)

> These build on a PTY multiplexer that also unlocks desktop OS-window tear-off.

### Step 4.1 — PTY multiplexing backend **(may need 2 passes)**
- **Goal:** Fan out each PTY to N subscribers with scrollback replay and input routing.
- **Depends on:** 1.5
- **Design refs:** `§11` (terminal mirroring), decision 13.
- **Build:** Refactor the PTY layer so each child multiplexes output to N subscribers; keep a
  ring buffer of recent scrollback; on attach, replay it; route input from any subscriber back
  to the child; handle resize arbitration. The desktop webview becomes one subscriber.
- **Done when:** Two subscribers (e.g. two webviews) attached to one PTY both see live output
  and can send input; a late attach replays scrollback.
- **Out of scope:** remote transport (4.3+).

### Step 4.2 — OS-window tear-off
- **Goal:** Pop a panel into its own OS window (multi-monitor).
- **Depends on:** 4.1, 1.6
- **Design refs:** `§5`, `§7` (multi-monitor tear-off), decision 13.
- **Build:** Create a second Tauri window/webview hosting a panel; for a console, attach it as a
  second subscriber to the multiplexer (4.1). Persist torn-off windows in the layout.
- **Done when:** A console tears off to a second monitor, stays live, and is restored on relaunch.

### Step 4.3 — Remote API + auth (tailnet)
- **Goal:** An authenticated API + WebSocket server bound to the tailnet interface.
- **Depends on:** 4.1, 2.2
- **Design refs:** `§11` (architecture, pairing/auth).
- **Build:** Grow the core into an authenticated API/WS server bound to the tailnet interface;
  one-time pairing token so only approved devices attach (don't trust the whole tailnet).
  Expose: instance list + statuses, prompt send, approve/deny, interrupt, start/stop.
- **Done when:** A paired client over the tailnet reads live statuses and sends a prompt; an
  unpaired device is rejected.

### Step 4.4 — Dashboard PWA (companion Phase A)
- **Goal:** Phone-optimized PWA: read statuses, send a prompt, approve/deny.
- **Depends on:** 4.3
- **Design refs:** `§11` (Phase A).
- **Build:** A phone-optimized PWA reusing the web frontend, served over the tailnet; structured
  controls for the actions in 4.3. ~80% of remote value, no native project.
- **Done when:** From a phone on the tailnet you see statuses and can approve a pending prompt.

### Step 4.5 — Live terminal in companion (Phase B)
- **Goal:** Mirrored live terminal on the phone with reconnect/scrollback.
- **Depends on:** 4.4, 4.1
- **Design refs:** `§11` (Phase B). Note the caveat: approve/deny remotely = injecting
  keystrokes into the live TUI; keep that mapping in one place.
- **Build:** Subscribe the PWA terminal view to the multiplexer over WS; reconnect + scrollback
  replay; mostly-read view with raw keyboard available; structured approve/deny maps to the
  right TUI keystrokes (single source of truth for the mapping).
- **Done when:** The phone shows a live console, survives reconnect with scrollback, and can
  approve via a button that injects the correct keystroke.

### Step 4.6 — Notification routing & escalation
- **Goal:** Route "needs you" beyond the desktop; escalate stuck/idle.
- **Depends on:** 2.3
- **Design refs:** `§7` (notification routing, idle/stuck escalation).
- **Build:** Choose destination: desktop / phone dashboard / Discord (existing MCP). Escalate if
  an instance is "needs you" > N minutes (louder ping / push); flag instances "working" far
  longer than usual as possibly stuck.
- **Done when:** A configured route delivers a needs-you alert to Discord/phone; escalation
  fires after the threshold.

### Step 4.7 — Android app via Tauri Mobile (Phase C, optional)
- **Goal:** Installable Android app reusing the Rust core + frontend, with native push.
- **Depends on:** 4.5
- **Design refs:** `§11` (Phase C).
- **Build:** Tauri Mobile Android target; reuse core/frontend as a thin client (no PTYs on
  phone); native notifications; address background push (foreground service or FCM) and mobile
  packaging.
- **Done when:** An installed Android app drives agents over the tailnet with reliable push.

---

## Phase 5 — Linux support & cross-platform hardening (deferred)

> Code has been platform-agnostic throughout; this phase verifies and packages Linux.

### Step 5.1 — Linux PTY & shell parity
- **Goal:** Confirm PTY, `$SHELL`, signals, and resize behave on Linux.
- **Depends on:** Phase 1+ landed
- **Build:** Verify `portable-pty` on Linux; default to `$SHELL`; check Ctrl+C/interrupt,
  resize, and large-output throughput. Fix any path-separator / line-ending assumptions.
- **Done when:** A `claude` session and a project shell run cleanly on a Linux build.

### Step 5.2 — Linux notifications & integration
- **Goal:** Native notifications and file-manager/open-dir on Linux.
- **Depends on:** 5.1, 2.3
- **Build:** `notify-send`/plugin path for notifications; "open working dir" via the Linux file
  manager; tray on Linux DEs.
- **Done when:** Needs-you notifications and tray badge work on a target Linux DE.

### Step 5.3 — Linux packaging & path audit
- **Goal:** Ship Linux bundles and confirm all path/config logic is portable.
- **Depends on:** 5.1, 5.2
- **Build:** Tauri bundler → AppImage / `.deb` / `.rpm`; audit `~/.claude*` path handling,
  worktree paths, statusline/hook install on Linux; smoke-test the full app.
- **Done when:** Installable Linux artifacts produced; a full session (register → run → status →
  worktree → telemetry) passes on Linux.

---

## Backlog ("worth considering" / "nice to have" — schedule opportunistically)

Pull these in once the relevant phase is stable; each is an independent step when needed:

- **Broadcast + compare** — same task to 2–3 worktree instances, diff side by side (needs 2.4).
- **Global search across sessions/transcripts** (needs 3.1's transcript access).
- **Archive instead of kill** — park a resumable session, collapsed (needs 1.4/3.8).
- **End-of-day digest** — per-agent what/files/cost (needs 3.1).
- **Drag-to-prompt** — drag a file path into a console; paste image into console.
- **Pre-op snapshots** — `git stash`/checkpoint before a risky run.
- **Skill/plugin awareness** — from the session-start init event; pin/star sessions.
- **Audio/voice ping** on needs-you.
- **Headless/Agent SDK power features** (broadcast-to-N, custom chat UI) — mind the subscription
  credit caveat; keep off the core path (`§4.3`).

---

## Progress tracker

**Phase 0 — spike**
- [x] 0.1 Scaffold the app
- [x] 0.2 PTY bridge spike (shell)
- [x] 0.3 Run real `claude` in the console

**Phase 1 — MVP**
- [x] 1.1 Theme system & retro chrome
- [x] 1.2 Persistence layer & data model
- [x] 1.3 Project registry UI
- [x] 1.4 Instance Manager rail
- [x] 1.5 Instance lifecycle ↔ console
- [x] 1.6 Dockview panel system + layout persistence
- [x] 1.7 Project Shell panel
- [x] 1.8 Editor panel (CodeMirror 6)
- [x] 1.9 Markdown preview
- [x] 1.10 Keyboard-first core

**Phase 2 — status engine & worktrees**
- [x] 2.1 Hook server + user-level install + session_id filter
- [x] 2.2 Status state machine
- [x] 2.3 Notifications, tray badge, attention focus
- [x] 2.4 Worktree provisioning
- [x] 2.5 Worktree post-create & teardown
- [x] 2.6 Shared-working-dir warning
- [x] 2.7 Diff / Review panel

**Phase 3 — polish & power**
- [x] 3.1 Transcript-tailing: cumulative tokens
- [x] 3.2 Usage-limit meter via managed statusline
- [x] 3.3 Layout presets
- [x] 3.4 Prompt template library
- [x] 3.5 Prompt queue
- [x] 3.6 CLAUDE.md quick-editor
- [x] 3.7 MCP server manager
- [ ] 3.7b Skill manager
- [ ] 3.8 Session restore (`Ctrl+Shift+T`)
- [ ] 3.9 Theme variants, CRT toggle, per-instance accent
- [ ] 3.10 Command palette, remappable keys, permission-mode switch
- [ ] 3.11 Git panel (history / branches / checkout)
- [ ] 3.12 Remote projects (SSH + tmux), no telemetry

**Phase 4 — remote & power**
- [ ] 4.1 PTY multiplexing backend
- [ ] 4.2 OS-window tear-off
- [ ] 4.3 Remote API + auth (tailnet)
- [ ] 4.4 Dashboard PWA (Phase A)
- [ ] 4.5 Live terminal in companion (Phase B)
- [ ] 4.6 Notification routing & escalation
- [ ] 4.7 Android app via Tauri Mobile (Phase C)

**Phase 5 — Linux**
- [ ] 5.1 Linux PTY & shell parity
- [ ] 5.2 Linux notifications & integration
- [ ] 5.3 Linux packaging & path audit
