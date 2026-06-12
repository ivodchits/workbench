# Workbench — Design Document

**Workbench** is a cross-platform (Windows + Linux) desktop "cockpit" for supervising
multiple Claude Code agents across multiple projects, with light editing built in.

---

## 1. Summary

**What it is:** a supervision/orchestration workbench — not an IDE. You register
projects, spin up one or more Claude Code agents per project, and watch a single
screen that tells you which agents are working, which are waiting on you, and which
are done. You can drop into a shell or edit a file without leaving the app.

**Core value:** kill the context-switching cost of juggling many agents across many
jobs. The screen answers one question at a glance — *where is my attention needed?*

**Non-goals (deliberately):** language servers, debuggers, build systems, a plugin
marketplace, or anything that competes with VS Code. The editor exists for quick
edits to files Claude touched and for reading/writing markdown. Keep the surface
small.

**Keyboard-first:** every action — focusing a panel or tab, switching instance, running
any command, and rearranging the layout — must be reachable from the keyboard alone. The
mouse is a convenience, never a requirement. (Details in §5.y; exact keymap TBD.)

---

## 2. Prior art (read before building)

The worktree-per-agent pattern is established; you don't need to invent the core idea.

| Tool | Form | Notes |
|------|------|-------|
| **Claude Squad** (`smtg-ai/claude-squad`) | Go TUI, tmux + git worktrees | All agents at a glance, isolated branches, merge flow. Closest to your feature #1. |
| **Crystal → Nimbalyst** (`stravu/crystal`) | Electron desktop | Parallel worktree sessions, compare approaches. Crystal deprecated Feb 2026 → Nimbalyst. Closest to your overall vision. |

**How yours differs / why it's worth building:** an integrated **markdown/code editor**
+ a dedicated **project shell** + a **freely arrangeable panel layout** (split, tile,
and tear off any panel — two Claude sessions side by side, or source + preview), plus
**cross-job project grouping** (e.g. CoPicnic vs other clients). The existing tools
are session managers; you're building a lightweight workbench. Skim their UX first —
especially Nimbalyst's panel layout and Claude Squad's "all agents at once" view.
**Claude Squad is also the visual north star** — Workbench borrows its retro-console
look (see §5.x).

---

## 3. Core concepts & data model

- **Group** — optional bucket for organizing projects by job/client. Useful for
  per-client cost tagging and invoicing.
- **Project** — a registered git repo (or folder). Has: root path, default branch,
  `CLAUDE.md`, MCP config, the group it belongs to.
- **Instance (Agent)** — one Claude Code session bound to a *working directory*. By
  default the working dir is the project root; if its per-session **worktree toggle**
  is on, it gets a dedicated git worktree instead (see §6). Carries: status, branch,
  session id, display title, a short optional **task note** (free text describing what
  it's working on right now), worktree on/off, cumulative cost/tokens.
- **Session note** — a brief, optional, user-editable line attached to each instance.
  Shows on the instance card and in the console header so you can tell at a glance what
  each agent is doing without reading its scrollback. Can be left blank, typed manually,
  or auto-suggested from the first prompt or the agent's active to-do (see §7).
- **Session** — the underlying Claude Code session, resumable via `claude --resume <id>`.
  Claude Code stores these under `~/.claude/projects/`, which you can read to restore
  state across app restarts.
- **Layout** — persisted per project as a serialized dock tree: which panels are open,
  how they're split/tabbed, their sizes, and any torn-off windows. Named **layout
  presets** can be saved and switched (see §7).

```
Group: "CoPicnic"
└── Project: copicnic-web   (~/work/copicnic-web)
    ├── Instance: invoice-fix   "fixing June invoice rounding bug"   ● needs you
    ├── Instance: refactor-api  "splitting the billing module"       ◐ working   ⑃ worktree
    └── Instance: docs          "updating README"                    ○ idle
                                  └ note ┘
```

---

## 4. Architecture

### 4.1 Framework — Tauri (decided)

**Tauri 2** (Rust core + system webview, web frontend). Chosen for the small footprint
and low RAM — which matters here because you'll run many PTYs and webview panels at once,
and because the retro-console UI (§5) is lightweight by nature.

| | **Tauri** (chosen) | Electron (rejected) |
|---|---|---|
| Footprint | Small binary, low RAM | Large binary, higher RAM |
| Backend | Rust core (fast, safe, native git/PTY crates) | Node main process |
| Terminal/editor | `portable-pty` (Rust) → `xterm.js`; CodeMirror in webview | `node-pty`; Monaco |
| Cost | More Rust glue (PTY↔webview bridge, IPC) | Less glue, but heavier |

**The one real cost** is the PTY-to-webview bridge: the Rust side owns each
`portable-pty` child and streams its bytes to the matching `xterm.js` instance over
Tauri IPC/events, and feeds keystrokes back. De-risk this first (§8, Phase 0) — it's the
only genuinely tricky part of going Tauri-native. Everything else (dock layout, editor,
hooks) is ordinary web/Rust work.

### 4.2 Process model

- **Rust core (Tauri backend)** owns: project registry, the instance supervisor, the
  local hook server, git operations, and all PTY children.
- **Each Claude instance** = a `portable-pty` child running interactive `claude` in its
  working directory; the Rust core streams its output over Tauri IPC to an `xterm.js`
  terminal in a **Console panel** (and forwards keystrokes back).
- **A project shell** = a separate `portable-pty` child running your shell (`$SHELL` /
  `pwsh.exe`) in a chosen instance's working directory, rendered in a **Shell panel**.
- Instances are independent processes, so one crashing or hanging never freezes the app.
- **Session correlation:** when spawning an instance, Workbench mints a UUID and passes
  it via `claude --session-id <uuid>`, so it can map the PTY → instance card *before* the
  first hook fires. (Don't try to learn the id by waiting for `SessionStart` — when several
  agents launch at once you can't tell which PTY produced which event.)

### 4.3 Driving Claude Code — the central decision

Use **interactive PTY mode**, i.e. spawn the normal `claude` TUI in a pseudo-terminal.
Reasons:

1. **Subscription-friendly.** You're on Max. As of **June 15, 2026**, Agent SDK and
   `claude -p` (headless) usage on subscription plans draws from a *separate monthly
   Agent SDK credit*, and there is a standing concern about automating a subscription
   account via scripts. Driving the normal interactive TUI is just using Claude Code
   the way it's meant to be used on a subscription — no separate metering, no grey area.
2. **Full fidelity for free.** Plan mode, permission prompts, slash commands, status
   line — all of it just works, because you're running the real client.

**Tradeoff:** you can't easily get *structured* state out of a terminal stream. Don't
solve this by parsing `xterm` output (fragile). Solve it with **hooks** (§4.4).

> Headless / Agent SDK (`claude -p --output-format stream-json`) stays on the shelf as
> an optional **phase-4** power feature — e.g. a "broadcast a prompt to N agents" or a
> custom chat UI — with the credit caveat in mind. Don't build the core on it.

### 4.4 Status engine — the heart of feature #1

The "where's my attention needed" view is driven by **Claude Code hooks**, not screen
scraping.

**Mechanism:** the app runs a tiny local HTTP server (e.g. `127.0.0.1:<port>`). The app
installs `http`-type hooks at **user level** (`~/.claude/settings.json`) — see decision 10
for why user-level rather than per-project — that POST each event, including the
`session_id`, to that endpoint. The app maps `session_id → instance card` and updates its
status dot.

> **Session-ID filter (build this from day one):** user-level hooks fire for *every* Claude
> Code session on the machine, including ones you launch outside Workbench. Workbench only
> knows the UUIDs it minted via `--session-id`, so the endpoint must **drop any event whose
> `session_id` isn't a registered instance**. Wire this filter in immediately so we don't
> forget — without it the rail fills with phantom cards from unrelated sessions.

**Event → status mapping:**

| Hook event | Meaning | Card status |
|------------|---------|-------------|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | actively doing work | ◐ **Working** (don't disturb) |
| `PermissionRequest` | wants to run a tool, awaiting approval | ● **Needs you** ← the key signal |
| `Notification` (`matcher: permission_prompt`) | needs approval (fallback signal) | ● **Needs you** |
| `Notification` (`matcher: idle_prompt`) | done, waiting for your next prompt | ● **Needs you** |
| `PermissionDenied` | you/Claude denied a tool | back to ◐ **Working** (turn continues) |
| `Stop` | finished its turn | ○ **Done / your move** |
| `SubagentStart` / `SubagentStop` | helper agent activity | nested spinner under the card |
| `SessionStart` (`source: startup` / `resume`) | session began/restored | register card; can set `sessionTitle` |
| `PreCompact` | compacting context | transient "compacting…" state |
| `SessionEnd` | session closed | mark card closed |

> Prefer `PermissionRequest` / `PermissionDenied` (dedicated, structured) over inferring
> from `Notification`; keep the `Notification` matchers as a fallback for older clients.
> Claude Code exposes ~28 events total — the table above is the subset Workbench acts on.

**Status state machine (precedence — spec it now, painful to retrofit).** `PreToolUse` /
`PostToolUse` fire constantly, and a permission prompt arrives *right after* a `PreToolUse`
("working") for the very same tool. Without explicit precedence, a pending "needs you" gets
stomped straight back to "working" by ordinary event churn. The rules:

- **`PermissionRequest` / `idle_prompt` / `Stop` are *sticky*** — once a card is "needs you"
  or "done", tool events (`PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop`)
  **never** downgrade it.
- The sticky state clears only on the **next `UserPromptSubmit`** (you replied / approved and
  work resumed), `PermissionDenied` (resolved, turn continues → ◐ working), or `SessionEnd`.
- Tool events set ◐ **Working** *only* when the current state isn't a sticky one.

**Debounce the card-update path.** `PreToolUse` / `PostToolUse` are high-frequency; coalesce
them (e.g. one repaint per ~100–200 ms per card) so the rail isn't repainting on every tool
call. Sticky-state transitions bypass the debounce — they must be instant.

**Why HTTP hooks fit perfectly here:** non-2xx responses from an HTTP hook are
*non-blocking*. That's exactly what you want — pure observation, never blocking or
steering Claude. Keep the endpoint fire-and-forget and read-only. (Also: recent
versions run *command* hooks without a controlling terminal, so they can't talk to the
TUI anyway — another reason HTTP hooks are the right tool for this app.)

**Bonus:** the same event stream drives OS notifications (`notify-send` on Linux,
native Notification API on Windows) and a tray badge count of agents needing attention.

### 4.5 Usage limits & token accounting

Two read-only telemetry features that live *beside* the hook engine, not inside it
(hook payloads carry no usage/limit data — confirmed against the docs).

**Account-wide usage meter (5-hour + weekly) — statusline side-channel.** Rate-limit data
is exposed only in the JSON Claude Code pipes to a **custom statusline command**. Workbench
installs a tiny **managed statusline script** (user-level, same place as the hooks) that
POSTs that JSON to the same `127.0.0.1` server, then prints a normal status line. The payload:

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

- **Account-global, not per-instance:** every session reports the same `rate_limits`, so this
  drives one app-wide readout (header / tray), refreshed from whichever session's statusline
  fired most recently. `resets_at` is epoch seconds → real countdowns to the next reset.
- **Workbench owns the statusline** it installs (it's what every console then shows). Render
  something useful (model · branch · cost) so it's not a downgrade; if the user already has a
  custom statusline, **chain** it rather than clobber it.
- **Caveats:** present only *after the first API response*, Pro/Max only, and either window
  may be absent — show "unknown yet" gracefully.

**Cumulative tokens per session — transcript tailing.** Sum the per-message `usage` objects
in `~/.claude/projects/<proj>/<session-id>.jsonl`. Surface `input` / `output` / `cache_*`
as **distinct figures** — with prompt caching, cache-read tokens dominate the raw count and a
single "total" is misleading. Same file-tailing subsystem as cost tracking (§7).

### 4.6 Persistence

- **Registry & state:** SQLite via `rusqlite` (or `tauri-plugin-sql`) — projects,
  instances, last branch, last `session_id`, per-project layout. JSON is fine if you
  prefer.
- **Session recovery:** every instance row persists its `last_session_id`, so a single
  keystroke (`Ctrl+Shift+R`) can resume the active instance's last session in place via
  `claude --resume <id>` (see §7). (Auto-restoring *all* instances + layout on launch was
  considered and dropped — targeted manual resume is what's actually wanted.)
- **Prefs:** `tauri-plugin-store`.

---

## 5. UI / layout

Workbench uses a **flexible dockable panel system**, not a fixed grid. Every panel is
a free-floating "view" you can split (horizontally or vertically), tab together, resize,
or float within the window. This is what lets you watch **two Claude sessions side by
side**, or put the **code editor next to a live markdown preview** — whatever the task needs.

> **Tear-off to a separate OS window is deferred to Phase 4** (see §8, §11). `dockview`'s
> "float" is a panel floating *inside the same webview* — true multi-monitor tear-off means
> a second Tauri window (a second webview) showing the same live console, which requires
> streaming one PTY to two webviews — i.e. the **PTY-multiplexing backend that §11 calls
> "the real engineering."** So in-window split/tab/float ships early; real OS-window tear-off
> rides on the §11 multiplexer. Don't treat tear-off as a free layout feature.

**Panel types** (open as many as you like):

| Panel | Bound to | Notes |
|-------|----------|-------|
| **Instance Manager** | global | The left rail. Usually one, pinned. |
| **Claude Console** | a specific instance | Open several at once for side-by-side agents. |
| **Project Shell** | a working directory | For git, tests, running the app. |
| **Editor** | a file / file tree | Multiple allowed (e.g. source + the markdown it documents). |
| **Markdown Preview** | a file | Pairs with an Editor panel for live preview. |
| **Diff / Review** | an instance | Shows what that agent changed vs its branch base. |
| **Git** | a project (repo) | History, branches, checkout, stash — the repo-level git view. |

**Default arrangement** (what you get on first launch — fully rearrangeable afterward):

```
┌────────────┬───────────────────────┬───────────────────────┐
│            │                       │                       │
│  INSTANCE  │    CLAUDE CONSOLE     │   SHELL / EDITOR       │
│  MANAGER   │    (focused agent)    │   (split or tabbed)   │
│  (rail)    │                       │                       │
│            │  ←—— drag splitters anywhere ——→              │
└────────────┴───────────────────────┴───────────────────────┘
```

- Any splitter is draggable; the rail is collapsible; the whole layout is saved per
  project and restorable as a named **preset** (§7).
- Opening a panel: click an instance to focus its console; **drag** an instance (or use
  a "split" affordance) to open it in a new console beside the current one. Same for
  opening a second editor or a preview alongside a file.
- **Keyboard:** `Ctrl/Cmd+\` split the focused panel; `Ctrl+W` close panel;
  `Ctrl+Tab` cycle panels; a dedicated "jump to next agent that needs you" key; number
  keys to focus saved layout presets.

### Instance Manager (rail)
- Tree: **Group → Project → Instance**.
- Each instance row shows: title + **task note**, **status dot** (color-coded), spinner
  while working, badge when "needs you", branch, a small **⑃ worktree** marker when the
  toggle is on, last-activity time, mini cost readout.
- Header summary: **"3 agents need you"** + a filter to show only those.
- Row actions: new instance, **toggle worktree** (off by default), resume, kill, rename,
  **edit task note**, open working dir in file manager, merge/remove worktree (if any).

### Claude Console
- `xterm.js` bound to one instance's PTY — the full real TUI.
- **Renderer cap:** at most ~10 consoles use the `webgl` renderer at once (browsers cap live
  WebGL contexts at ~16); backgrounded/excess consoles fall back to the canvas/DOM renderer.
  Realistic ceiling for this workflow, so the cap is invisible in practice.
- Header strip: project · branch · **task note** · short session id · running cost.
- Quick actions: interrupt (`Esc`/`Ctrl+C`), `/clear`, insert a prompt template, edit note.

### Project Shell
- PTY in the chosen instance's working dir. For git, running tests, launching the app.
- Pre-seeded `git status` line; quick buttons for status / diff / commit.

### Editor (+ Markdown Preview)
- **CodeMirror 6** — lighter than Monaco, trivial to theme for the retro look (§5.x), and
  ideal for markdown + the occasional small code edit. (Monaco is the heavier fallback if
  you later want full IDE-grade editing.) Markdown preview can live in the same panel
  (toggle) or as a separate side-by-side panel.
- File tree scoped to the instance's working dir; tabs; dirty indicators.

### Diff / Review
- Diff against the branch base — see exactly what the agent changed. Makes "I want to
  make small changes to files Claude edited" pleasant: review the diff, tweak inline, save.

### Git
The repo-level git view, bound to a **project** (not an instance) — this is the
counterpart to the instance-scoped **Diff / Review** pane above. Diff/Review answers
*"what did this agent change?"*; the Git panel answers *"what's the state of the repo,
and let me move around in it."* Open one per project; it reads the project's main working
dir (worktrees keep their own branch, surfaced via the **⑃** marker in the rail, §3/§6).

**What it shows / does:**
- **History** — a commit log (graph view of branches/merges where it helps), with author,
  date, message, and short SHA in the box-drawing aesthetic (§5.x). Click a commit to see
  its diff and changed-file list in place.
- **Branches** — list local + remote branches with ahead/behind counts; **checkout**,
  create, rename, delete, and fast-forward/merge from the panel. Checking out a branch in
  a project that has live worktree instances surfaces the same "shared working dir" warning
  as §6 (you're moving HEAD under an agent's feet) rather than silently switching.
- **Working tree** — staged/unstaged/untracked at a glance, stage/unstage hunks, **stash**
  / pop, discard (behind confirmation). Overlaps intentionally with the Project Shell's
  pre-seeded `git status` (§5 Project Shell) — the Git panel is the GUI affordance, the
  shell stays the escape hatch for anything not surfaced here.
- **Remote** — fetch / pull / push with ahead/behind shown; **never auto-pushes**.

**Design notes:**
- **Read-first, write-behind-confirmation.** History/branch browsing is frictionless and
  non-destructive; anything that rewrites state (force-push, branch delete, discard, hard
  reset) sits behind an explicit confirm and is logged. Keep the panel honest — it shows
  real repo state, it doesn't paper over it.
- **Relation to worktrees (§6).** Worktree provisioning/merge/cleanup stays an
  *instance-card* action (§5 Instance Manager rail) because it's tied to an agent's
  lifecycle. The Git panel is the *project-wide* lens — it can show the worktree branches
  as ordinary branches but doesn't own their create/remove flow.
- **Keyboard-first (§5.y):** focus history, move by commit, check out the selected branch,
  and trigger fetch/pull/push from the keyboard; all git actions are in the command palette
  with their bindings shown.
- **Implementation:** `git2` (libgit2) for read paths (log, branch list, status, diff) so
  the history view is fast and doesn't shell out per row; shell out to `git` for the few
  operations libgit2 handles awkwardly (some merge/rebase/push-with-creds cases). Same
  `git2`-or-shell-out choice already noted in §9.

### 5.x Visual design — retro console (the Claude Squad vibe)

The whole app should read as **one continuous terminal**, so the chrome and the embedded
`xterm.js` consoles feel like the same surface rather than a GUI wrapped around a terminal.
Claude Squad gets this feel because it *is* a TUI; Workbench fakes it convincingly in the
webview.

**Typography**
- Monospace everywhere — UI labels, menus, the rail, everything. Ship a good terminal
  font (e.g. JetBrains Mono, IBM Plex Mono, or Berkeley Mono if licensed); let the user
  pick. The app font and the `xterm.js` font are the same.

**Color**
- Dark base (near-black or deep blue-grey), small palette, one or two phosphor accents.
- Status palette doubles as the whole UI's accent system:
  `◐ working` = amber/yellow · `● needs you` = magenta or red · `○ done/idle` = green ·
  `closed` = dim grey. High contrast; colorblind-safe pairing checked.
- The `xterm.js` theme object is generated from the active app theme so the real Claude
  TUI inside a console matches the chrome around it.

**Chrome & borders**
- Box-drawing aesthetic: thin square-cornered borders with terminal-style title bars,
  e.g. `╭─ console · invoice-fix ──────╮`. No rounded cards, no drop shadows, no gradients.
- Status shown as **text glyphs**, not graphical icons: `● ◐ ○ ⑃ ▸ ✓ ✗`. The working
  spinner is an ASCII/braille frame cycle (`⠋⠙⠹⠸⠼⠴⠦⠧`) like a CLI spinner.

**Effects (tasteful, toggleable)**
- Optional CRT layer: faint scanlines, a subtle text glow/bloom, a slight vignette,
  blinking block cursor. Keep it GPU-cheap (a single CSS overlay) and **off-by-default
  toggle** so it never fights readability during real work.

**Themes**
- Ship a few presets — *green phosphor*, *amber*, *cyan/synthwave*, plus a calm *muted
  dark* for long sessions. Per-instance accent color (from §7) overlays on top.

**Implementation**
- Pure CSS in the webview for chrome/borders/CRT overlay; a shared theme token file feeds
  both the CSS variables and the `xterm.js` theme. Box-drawing via real Unicode characters
  or CSS borders styled to match. CodeMirror gets a matching theme so the editor doesn't
  break the spell.

### 5.y Keyboard-first control

Everything must be doable without the mouse. The terminal aesthetic and a keyboard-only
workflow reinforce each other.

- **Focus & navigation:** jump to the rail, cycle panels/tabs, focus a numbered panel
  directly, and "jump to the next agent that needs you."
- **Instance control:** switch / launch / kill / resume, toggle worktree, edit the task
  note, interrupt the agent — all keyboard-bound.
- **Layout:** split or close the focused panel, move/swap panels, float a panel in-window,
  and recall saved layout presets by number — from the keyboard. (OS-window tear-off: Phase 4.)
- **Command palette** as the universal fallback: fuzzy-search every action with its
  binding shown, so nothing is mouse-only and bindings stay discoverable.
- Bindings should be **remappable**; a modal/vim-style scheme is worth considering given
  the console look. (Exact keymap: TBD — spec it later.)

---

## 6. Git worktrees — optional, per session, off by default

Worktrees are a **per-instance toggle, disabled by default**. Most sessions (markdown
edits, a quick question, working alone on a branch) don't need one, so a new instance
just runs in the project root. Flip the toggle on when you want an agent isolated on its
own branch — typically when running **several agents on the same project in parallel**.

**Toggle OFF (default):** the instance runs in the project root on the current branch.
Simple, zero setup.
> Caveat to surface in the UI: if two toggle-off instances share the same project root,
> they can step on each other's edits. Workbench should show a small "shared working dir"
> warning when that happens, and offer a one-click "isolate in a worktree" action.

**Toggle ON:** Workbench provisions an isolated worktree for that instance:
1. `git worktree add <path> -b agent/<slug>` — under a sibling dir or a managed
   `.workbench/worktrees/` area (your choice in settings).
2. Launches `claude` there; the instance card shows the **⑃ worktree** marker + branch.
3. On "done": show the diff, offer **merge** / open PR / **`git worktree remove`** cleanup.

**Gotcha to handle when ON:** worktrees don't share `.env` or `node_modules`. Offer an
optional post-create step to copy `.env`, symlink/install deps, or run a user-defined
setup command. (You already use worktrees with Claude Code, so this just removes the
manual `worktree add`/`remove` dance when you do want it.)

---

## 7. Suggested additions

**Confirmed / high value (build these):**
- **Task note per session** *(confirmed)* — the short editable line from §3. Cheap to
  build, high payoff when juggling many agents. Enhancement: **auto-suggest** it from
  the instance's first prompt, and/or keep it **live** by mirroring the agent's current
  active to-do — Claude Code maintains a to-do list, so the "what it's working on right
  now" can update itself while still being manually overridable.
- **Attention summary + OS notifications + tray badge** — falls straight out of the
  hook stream. The single most useful feature for supervising many agents.
- **Layout presets / saved workspaces** — because the layout is now free-form, let users
  save named arrangements ("2-up review", "single focus", "writing: editor + preview")
  and switch with a hotkey. Pairs naturally with the dockable panel system.
- **Per-instance diff/review pane + one-click merge** — closes the loop on parallel work.
- **Git panel (repo-level history / branches / checkout)** *(requested)* — the project-scoped
  counterpart to the per-instance diff pane (§5 Git). Lets you read history, switch branches,
  and manage the working tree without dropping to the Project Shell — handy when an agent
  leaves you on a branch and you want to see where you are, check out something else, or stash
  before a risky run. Read-first, destructive ops behind confirmation; worktree create/remove
  stays an instance-card action (§6). Mostly read paths via `git2`, so it's cheap to build on
  the git layer already needed for the diff pane and worktrees.
- **Cost & token tracking** per instance / project / group. **Source note:** hook payloads
  do **not** carry cost/token data — read it from the transcript JSONL
  (`~/.claude/projects/<proj>/<session-id>.jsonl`, per-message `usage`:
  `input_tokens` / `output_tokens` / `cache_*`) and `~/.claude/statusline.jsonl`
  (cumulative `total_cost_usd`). So this is a **file-tailing subsystem, separate from the
  hook-driven status engine** — not a Phase-2 hook feature. With multiple clients (CoPicnic
  et al.), per-group tagging maps directly onto billing/invoicing.
- **Usage-limit meter (5-hour + weekly)** — account-wide readout of how much of each rolling
  window you've consumed, with live countdowns to reset. Fed by the **managed statusline
  side-channel** (§4.5), not hooks. App-global (header/tray), since limits are per-account.
- **Cumulative tokens per session** — input / output / cache tokens summed from the transcript
  (§4.5), shown on the instance card alongside cost. Part of the same file-tailing subsystem.
- **Prompt template library** *(requested)* — save the **currently active prompt** (what's
  typed in the focused console) into a named template with one keystroke; create / edit /
  delete templates; quick-insert one into any instance via the command palette or a picker.
  - Templates support positional placeholders `{0}`, `{1}`, … When you pick a template that
    has them, Workbench pops a small **fill-in form** (one field per placeholder), substitutes
    the values, then inserts or sends the finished prompt. Optional extras: named placeholders,
    default values, and per-project vs global templates. Complements Claude Code's own custom
    slash commands (`$1` / `$ARGUMENTS`) but lives at the app level with a guided fill UI that
    works across instances.
- **`CLAUDE.md` quick-editor** per project — edit the file you live in without opening
  the repo elsewhere.
- **MCP server manager** *(requested)* — one place to view and edit MCP servers in **any
  scope**: *user* (global, `~/.claude.json`), *project* (shared `.mcp.json` at the repo
  root, git-committed), and *local* (private to you for this project, in `~/.claude.json`
  keyed by path). Show each server's scope and the precedence (local > project > user),
  and add/edit/remove/enable with transport (stdio/http), args, env, and headers.
  - *Implementation note:* drive writes through the `claude mcp add/remove/list` CLI where
    possible — it's authoritative and avoids corrupting the large shared `~/.claude.json` —
    and offer a raw-JSON editor for the small `.mcp.json`. Surface two gotchas: project
    servers require a trust/approval prompt before first use, and MCP "local" scope
    (`~/.claude.json`) is *not* the same file as `.claude/settings.local.json`.
- **Session timeline/log** per instance (rendered from the transcript).
- **Resume last session (`Ctrl+Shift+R`)** *(shipped)* — resume the **active instance's** last
  session in place via `claude --resume <session_id>`: same conversation, context window intact.
  *Active instance* = the rail card you have focus on, else the active console's instance. The
  key is **ignored when a session is already live** there (checked against the backend, not the
  console store — a self-exited `claude` still reads "running"); an instance that never ran is a
  no-op. A plain `--resume` keeps the original session id, so hooks + token tailing keep working
  untouched. (The earlier "reopen yesterday's whole desk + layout on launch" idea, and a
  reopen-most-recently-closed stack, were dropped in favor of this targeted resume.)

**Worth considering:**
- **Prompt queue** — line up a follow-up prompt that auto-sends when the agent finishes
  its current turn (detected via the `Stop` hook), so you can leave instructions without
  babysitting.
- **Broadcast + compare** — send the same task to 2–3 worktree instances (different
  approaches), then diff their results side by side. This is the Crystal/Nimbalyst
  "compare approaches" idea, made one click.
- **Permission-mode quick switch** — toggle plan mode / accept-edits / default per
  session from the UI instead of typing it in.
- **Idle / stuck escalation** — if an instance has been "needs you" for N minutes,
  escalate the notification (louder ping, phone push); if "working" far longer than
  usual, flag it as possibly stuck.
- **Notification routing** — choose where "needs you" goes: desktop, the Tailscale phone
  dashboard, or **Discord** (you already run a Discord MCP setup).
- **Global search across sessions** — search output/transcripts across all instances
  ("which agent touched the auth flow?").
- **Archive instead of kill** — park a finished session (collapsed, resumable) rather
  than destroying it; keeps the rail tidy without losing context.
- **End-of-day digest** — per agent: what it did, files changed, cost. Handy for
  per-client time/cost reporting.
- **Drag-to-prompt** — drag a file from the editor tree into a console to insert its
  path; paste an image straight into the console (Claude Code accepts images).

**Nice to have:**
- **Remote access + Android companion** — see and drive your agents from your phone over
  the tailnet. This is substantial enough to have its own section: see **§11**.
- **Multi-monitor tear-off** — pop any panel into its own OS window; e.g. consoles on one
  monitor, editor on another. **Phase 4** — depends on the §11 PTY multiplexer (a second
  OS window is a second webview that needs the same PTY streamed to it), so it can't ship
  with the early in-window dock layout.
- **Audio/voice ping** on "needs you"; **per-instance color** + theming; **command palette**.
- **Focus mode** — auto-advance to the next agent needing attention.
- **Pre-op snapshots** — `git stash` tag or checkpoint before a risky agent run.
- **Skill/plugin awareness** — show which skills/plugins loaded (from the `system/init`
  event at session start), and pin/star important sessions.

---

## 8. MVP scope & phasing

- **Phase 0 — spike (days):** Tauri shell + one `portable-pty` child running `claude`,
  streamed to an `xterm.js` panel, on Windows *and* Linux. This proves the PTY↔webview
  bridge — the only hard part of going Tauri-native. Do it before anything else.
- **Phase 1 — MVP:** project registry; instance rail with **task notes**; dockable
  panels (Console + Shell + Editor, split / tab / **float in-window**, layout saved);
  CodeMirror read+save; the retro theme. Instances run in the project root (worktree toggle
  present, can ship stubbed). Usable daily. *(In-window float only — OS-window tear-off is
  Phase 4, see §5.)*
- **Phase 2 — the differentiator:** hook-driven status engine (with the session-id filter
  and status state machine from §4.4) + notifications; multiple instances per project; the
  **worktree toggle** (provision/merge/cleanup); diff view.
- **Phase 3 — polish:** cost tracking + cumulative per-session tokens + the usage-limit
  meter (the §4.5 file-tailing + statusline side-channel subsystem), layout presets,
  prompt templates (with `{0}`/`{1}` fill-in) + queue, `CLAUDE.md` editor + MCP server
  manager, resume last session (`Ctrl+Shift+R`), theme variants + CRT toggle, the **Git panel**
  (history / branches / checkout, §5 Git — builds on the `git2` layer landed in Phase 2 for
  the diff view and worktrees).
- **Phase 4 — power/remote:** the **PTY-multiplexing backend** (§11 Phase B) and the
  **OS-window tear-off** that rides on it (§5); the remote API + Android companion (§11,
  itself phased A→B→C); notification routing (Discord/phone); optional headless SDK features.

---

## 9. Tech stack summary

| Concern | Pick |
|---------|------|
| App shell | **Tauri 2** (Rust core + system webview; frontend **React/TS** — see decision 11) |
| Panel layout | `dockview` (split / tab / float in-window; OS-window tear-off in Phase 4) |
| Terminals | `portable-pty` (Rust) ↔ `xterm.js` over Tauri IPC (addons: fit, search, webgl). **Cap ~10 webgl-rendered consoles** (browser WebGL-context limit); canvas/DOM renderer for the rest. |
| Editor | **CodeMirror 6** (markdown + light code; Monaco as heavier fallback) |
| State | SQLite via `rusqlite` / `tauri-plugin-sql`; `tauri-plugin-store` for prefs |
| Git | `git2` (libgit2 bindings) or shell-out |
| Hook bridge | small Rust HTTP server (`axum` / `tiny_http`) on `127.0.0.1` |
| Notifications | `tauri-plugin-notification` + Tauri tray |
| Packaging | Tauri bundler — MSI/NSIS (Windows), AppImage/`.deb`/`.rpm` (Linux) |

---

## 10. Decisions (settled)

These are resolved; defaults are chosen so you can change your mind later without a
rewrite.

1. **Framework: Tauri 2.** Rust core + webview. (§4.1)
2. **Driving Claude Code: interactive PTY** via `portable-pty`, never headless on the
   subscription. (§4.3)
3. **Layout: free-form dockable panels** (`dockview`), multiple panels of the same type
   allowed, tear-off windows supported. (§5)
4. **Editor: CodeMirror 6.** (§5, §9)
5. **Worktrees: per-session toggle, off by default.** (§6)
6. **Shared working dir: warn, never block.** Two worktree-off instances in one root get
   a non-blocking "shared dir" warning + a one-click "isolate in worktree" — your
   flexibility is preserved. (§6)
7. **Worktree location (when on):** a sibling `.workbench/worktrees/<slug>/` next to the
   repo, path configurable in settings. (§6)
8. **Task note:** manual, with auto-suggest from the first prompt; live to-do mirroring is
   an **opt-in per session**, not the default. (§3, §7)
9. **Status engine: Claude Code hooks**, delivered as `http` hooks to a local Rust
   endpoint. (§4.4)
10. **Hook install location: user-level `~/.claude/settings.json`.** Chosen over
    per-project `.claude/settings.local.json` because **worktree instances run in a
    *separate* working directory** and wouldn't inherit a project-root install — user-level
    hooks cover every working dir (root and worktrees) with one install. The cost is that
    hooks fire for *all* Claude sessions on the machine, so the endpoint **must filter by
    `session_id`** (drop events from sessions Workbench didn't mint — build this from day
    one, see §4.4). (§4.4, §6)
11. **Frontend: React/TS.** `dockview` — the backbone of the entire UI — is React-first
    (its float/tab/drag API and docs lead with React; the vanilla build trails), so React
    closes the question. (§9)
12. **Session correlation: mint a UUID and launch with `claude --session-id <uuid>`**, so
    PTY → card mapping happens at spawn, not by racing `SessionStart`. (§4.2)
13. **OS-window tear-off deferred to Phase 4**, gated behind the §11 PTY multiplexer;
    early layout ships in-window float only. (§5, §8)
14. **xterm.js renderer cap: ~10 webgl consoles**, canvas/DOM fallback beyond that
    (browser WebGL-context limit; realistic ceiling for this workflow). (§5, §9)
15. **Status precedence state machine** (sticky "needs you"/"done"; tool events never
    downgrade; debounced repaints) — specced in §4.4.
16. **Cost & per-session cumulative tokens are a file-tailing subsystem** (transcript
    JSONL), *not* a hook feature, since hook payloads carry no usage data. Tokens shown as
    distinct input/output/cache figures, not one cache-inflated total. (§4.5, §7)
17. **Usage limits (5h + weekly) via a managed statusline side-channel.** The only
    machine-readable source of `rate_limits` is the JSON Claude Code pipes to a custom
    statusline command; Workbench installs one (user-level) that POSTs to the local server.
    Account-global meter, not per-instance; chain any pre-existing user statusline. (§4.5, §7)

*Still genuinely open (low stakes, decide during build):* exact theme presets to ship first.

---

## 11. Remote access & Android companion

**Idea:** from your phone, connect to the running Workbench on your desktop over your
tailnet — see every agent's status, read its console, send prompts, approve/deny
permission prompts, start/stop instances. If Workbench isn't running, the companion just
shows "offline." Tailscale handles the secure transport, so there's **no cloud, no relay,
no NAT punching, and no account system to build** — the single biggest reason this is
cheaper than it sounds.

### Architecture
- The desktop's Rust core (which already runs the hook server and owns every PTY) grows
  into a small **authenticated API + WebSocket server** bound to the tailnet interface.
  The phone is a **thin client**: it runs no PTYs; it subscribes to state and a terminal
  stream and sends input/actions back.
- **Pairing/auth:** Tailscale secures the wire, but don't implicitly trust every device on
  the tailnet — add a one-time pairing token so only approved devices can attach.
- **Terminal mirroring:** the core multiplexes each PTY to N subscribers (desktop webview
  + phone). On attach, replay recent scrollback; route input from any client back to the
  PTY; handle resize. This is the real engineering — and it's useful for the desktop too
  (multi-window, future screen-sharing).
- **Phone UX:** a tiny screen makes raw TUI keyboarding painful, so the terminal view is
  mostly for *reading*, and *acting* sits behind structured controls — prompt box,
  approve/deny, interrupt, instance switcher — with raw keyboard available when needed.
  > Caveat: the hook stream tells you a permission is *pending*, but **acting** on it
  > remotely still means **injecting the right keystroke into the live TUI** over the PTY.
  > That's not a read-only thin client, and the exact keys can shift across Claude Code TUI
  > versions — keep the approve/deny mapping in one place so a TUI change is a one-line fix.

### How big is it? (rough, for a solo dev on this stack)
Three independently shippable phases:

| Phase | Scope | Effort | Notes |
|-------|-------|--------|-------|
| **A — Dashboard PWA** | Read statuses + send a prompt + approve/deny, served as a phone-optimized **PWA** over the tailnet | **Small** (~days–1.5 wk) | Reuses the web frontend; no native project; ~80% of the value. Start here. |
| **B — Live terminal** | PTY multiplexing + input routing + reconnect/scrollback | **Medium** (~1–2 wk) | The core work; also benefits the desktop. |
| **C — Real Android app** | Wrap as an installable app via **Tauri Mobile** (Android target), reusing the Rust core + frontend; native notifications | **Medium** (~1–2 wk + platform yak-shaving) | Only if you want an installed app + reliable push. |

**Bottom line:** the companion *UI* is cheap — Tailscale removes the infra you'd normally
build (auth server, relay, push gateway) and you reuse the web stack. The cost isn't the
app; it's three things: the **PTY-multiplexing backend** (Phase B), reliable **background
push** when the app is killed (Android needs a foreground service or FCM — the one place
tailnet-only doesn't fully solve it), and **mobile packaging** (Phase C). End-to-end
"everything from the phone" is on the order of **a few weeks of part-time work**, most of
it backend you'd want for the desktop anyway.

**Caveat (same as headless):** a phone sending prompts to a session you're actively
supervising is just you, interactively — fine. Don't let it drift into unattended
automation of the subscription account.



- Claude Code headless / Agent SDK & subscription credit note — https://code.claude.com/docs/en/headless
- Claude Code hooks reference (events, `http` hooks, terminal sequences) — https://code.claude.com/docs/en/hooks
- Claude Squad — https://github.com/smtg-ai/claude-squad
- Crystal / Nimbalyst — https://github.com/stravu/crystal
