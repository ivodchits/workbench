# Duck — architecture

How Duck (the D.U.C.K. assistant) is built, as it stands. The plan and the reasons
behind each decision are in `assistant-plan.md`. This file describes the code, and every
Duck step updates it as part of its Done when. Duck's self-development sessions (L3)
read it first.

Last updated: step W5 (2026-10-19).

## The shape

```
 surfaces ── Duck Protocol ──▶ engine (TS, main webview) ──▶ SDK ──▶ /anthropic proxy (Rust) ──▶ API
 (drawer,     protocol.ts      engine.ts: the loop          client.ts   key, token, ledger, cap
  phone R1)                    tools/: registry + tools
                               threads.ts ──▶ assistant_* commands ──▶ duck.db
                               port.ts ──▶ port.local.ts ──▶ Workbench stores
```

- **The engine runs in TypeScript, in the main window**, because the app's live state and
  actions are there. Rust holds what must stay out of JavaScript: the API key, the proxy,
  spend accounting, and storage.
- **Four boundaries** keep Duck separable from Workbench:
  1. `WorkbenchPort` is the only way Duck touches the app (ESLint-enforced).
  2. The Duck Protocol is the only way surfaces talk to Duck.
  3. Duck's state lives in its own `duck.db`, prefs and keychain names.
  4. Its Rust code lives in its own module tree, `src-tauri/src/assistant/`.

## Modules

### Webview: `src/assistant/`

| File | What it is |
|---|---|
| `index.ts` | `initAssistant()` (called from `App.tsx` with the other engines) builds the store, the trust store, the registry and the engine; `getDuck()` returns the in-process transport. `endpoint()` maps protocol messages onto the engine and adds the spend (from a `SpendSource`: the ledger commands and `assistant-usage` events) and the trust messages (`trustView()` adds the floor's labels). |
| `protocol.ts` | The Duck Protocol, version 1: `ClientMessage` (send, stop, confirm, thread.new, thread.delete, sync, thread.open, settings.set, trust.pause, trust.rule.add, trust.rule.remove, trust.mode, trust.floor, trust.decisions, trust.replay, task.close) and `DuckEvent` (threads, history, thread, threadDeleted, message, delta, tool, confirm, confirmed, turnState, spend, settings, trust, decisions, decision, tasks, replay, error). A `ConfirmRequest` carries the tool's `summary` and, for a file edit, `review` (each file's before and after, shown as diffs); a `note` notice carries a `NoteEdit` (before, after, revision) and a `plugins` notice a `PluginsEdit` (the plugin file and its scripts, before and after, and the new revision) for the drawer's chips. Source `event` marks a follow-up from Workbench, not the user. `createLocalTransport` stamps `v`. |
| `settings.ts` | Duck's settings (pref `assistant`): `confirmPrompts` (ask before every prompt sent to a session), `codingModel` (what `create_session` uses for coding work) `answerSessionPrompts` (T2: off by default, which keeps the trust watcher in shadow mode for every project), `codingPermissionMode` (M4), and the workers' `maxWorkers`, `workspace` and `tiers` (D1: each tier's model and effort). Loaded at start, changed only through `settings.set`. |
| `policy.ts` | `createPolicy({settings, trust, messages})`: the gate, an adapter over the trust engine. It builds a `TrustRequest`, runs `decide`, applies the rate guard and logs the decision. A `deny` becomes the call's error, and a rate-guard trip a `trust` notice. Without a trust store it is W2's: consequential calls ask, and prompts too when `confirmPrompts` is on. |
| `trust/rules.ts` | Rules in Claude Code's syntax (`assistant:write_note`, `assistant:answer_choice(question)`, `Bash(npm test:*)`, `Edit(src/**)`, `WebFetch(domain:x)`): `parseRule`, `matches`, `evaluate` (deny > ask > allow, global plus the call's project). |
| `trust/floor.ts` | `FLOOR`: the always-ask entries as data, each with must-catch and must-pass examples; `floorHit(texts, off)`. |
| `trust/mandate.ts` | `findGrant(messages, quote, now)`: the user's own recent message a `grantedBy` quote comes from. |
| `trust/decide.ts` | `decide(request, config, {grant})`, in this order: kill switch / project `off` / tripped thread (W2's answer), floor (and a tool's own `asks`, such as a plugin action with a confirm question), the confirm-prompts setting, rules, mandate, tier. `baseline()` is W2's answer. |
| `trust/store.ts` | `createTrustStore(backend)`: rules, modes, floor-off and the kill switch in memory, written through to duck.db. It seeds `STARTER_RULES` once, holds the in-memory rate guard (keyed by thread, or `session:<id>` for a session's prompts; `trip()` trips one at once), and keeps the decision log. |
| `trust/session.ts` | Claude Code permission prompts (T2), the deterministic half: `decidePrompt(req, config)` (null when trust doesn't apply; else the session's rate guard, the floor, a file write outside the session's folder but not Claude Code's own scratchpad, memory or plan files, the rules; else `judge`), `pickYes` ("Yes" by label, only from options read off the screen), `callLine`. |
| `trust/judge.ts` | The judge: `JUDGE_SYSTEM` (frozen), `Verdict`, `judgeText` (the call in `<untrusted>`, the mandate in `<task>`, tags inside defanged, long strings cut) and `judge(input, call)`: Haiku (`judge`), and on `ask` + `medium` Sonnet (`judge2`); only `allow` + `low` passes. |
| `trust/watcher.ts` | `startTrustWatcher({port, trust, judge, notice})`: decides every permission prompt as it opens; allow answers "Yes", deny sends Esc and posts a notice to the thread that started the session, ask leaves it to you. Registers the needs-you hold, logs every decision (`superseded` when the prompt closed first), and leaves a line under the session's card. |
| `trust/replay.ts` | `replay(calls, deps)`: the past week's tool calls (`assistant_replay_calls`) through `decidePrompt` and the judge (every call you rejected, a sample of the rest), reported as disagreements, refusals of calls that ran, and a sample of what would still ask. |
| `tasks.ts` | Worker tasks (D1): `createTaskManager({port, backend, settings, tell})` keeps the records (`assistant_tasks`), starts queued tasks while `maxWorkers` allows (a start takes its slot synchronously), settles a task on its worker's turn end from a fresh `result.json` (one nudge, then the last reply), reports every outcome to the asking thread as a `<workbench_event>`, and handles follow-ups, closing and the records left running by a restart. `firstPrompt`, `briefText`, `tierOf`, `parseResult` are exported for tests. |
| `spend.ts` | `createTurnMeter()`: bills each metered `thread` call to the one turn that is calling (none if two are), giving each thread's latest turn cost for the `spend` event. |
| `engine.ts` | The loop. Pure helpers `toApiMessages`, `effectiveEffort`, `buildParams` and `eventText` are exported for tests. Each tool call gets a `ToolContext` with the settings, `notice()` (a thread item the model never sees) and `later(text)` (a follow-up sent into the thread as a `<workbench_event>` user message with source `event`, which runs its own turn). A tool with `prepare` has it run first (a throw fails the call before any card); what it returns is kept on the call (`BatchCall.prepared`, persisted with a parked batch) and handed to `describe`, `review`, `trust` and `run` (`ctx.prepared`). The gate is asked with the call's own tier (`registry.callTier`), the card's summary and the tool's trust facts (`registry.trustFacts`). It answers run, ask, or deny with a reason, and an optional notice. |
| `threads.ts` | `createThreadStore(backend)`: threads, messages (loaded per thread on first use) and parked tool batches, in memory and persisted. Appends to one thread are serialized so each gets the next `seq`. |
| `client.ts` | `getClient()` (the SDK at the proxy, with the launch token as its key), `purpose()`, `capMessage()`, `errorMessage()`, `structured({model, system, input, schema?, purpose, …})` (one call, structured output parsed), and `oneShot(name, input, {schema?})` for Haiku primitives over it. |
| `prompt.ts` | The frozen system prompt, `MAIN_MODEL` / `PRIMITIVE_MODEL`, and `PRIMITIVES` (one frozen prompt per Haiku job; the key is its `x-wb-purpose`). |
| `port.ts` / `port.local.ts` | `WorkbenchPort` and its one implementation over the stores. The only file under `src/assistant/` allowed to import `src/state/**` or `src/panels/**`. Members: projects, sessions (live phase, pending choice with its id, worktree, model, last activity), transcript paging, usage limits, a git snapshot of a directory, notes list/read, Duck's spend; and the W2 actions: `sendPrompt` (`state/promptOutbox.ts`: one prompt per turn, confirmed by `UserPromptSubmit`; a stopped session is resumed with the prompt on claude's command line), `createSession` (`startNewSession` from `state/remoteActions`, shared with the phone), start/resume/interrupt/stop/kill, `answerChoice` (refused unless the named prompt is still open), `openPanel`, note writes, `onPhase`; and W5's plugins: `listPlugins` (the parsed file, each plugin's field values as a run sends them, each action's last run), `pluginsText`, `checkPlugins`, `writePlugins`, `readScript` / `writeScript`, `previewPluginAction` (the argv and cwd the backend would spawn, and the confirm question filled in), `runPluginAction` (`startPluginRunFor` in `panels/pluginRun.ts`: no confirm question, refused while running, the project shown first because task panels are drawn for the shown project only) and `onTaskEnd` (from the tasks store; the last lines come from `terminalPool.readTail`); `startPluginsDraft` (`startNewSession` with `beforeLaunch`, which makes the draft and registers the session before its first launch), `readPluginsDraft`, `clearPluginsDraft`; and T2's: `choiceOf`, `onChoices`, `holdNeedsYou` (`state/promptHold.ts`; `onPhase` also waits on it for a fresh needs-you, and drops one Duck answered), `sessionContext` (the stored mandate, else the transcript's first prompt; the latest prompt; the home folder) and `noteSession` (`state/trustLines.ts`, the line under the card). `createSession` and `startPluginsDraft` store a `mandate` (memory and duck.db `meta`). |
| `fakePort.test-util.ts` | `fakePort(data)` and the `project()` / `session()` builders: a port over fixture data for the engine's and the tools' tests. Actions are recorded in `calls`, notes writes keep the revision check, `phase()` fires `onPhase`. `toolCtx(port)` is a tool context that records notices and follow-ups. Plugin files are kept as text with a revision counter (`fakeCheck` stands in for the parser), and `endTask()` ends a run. |
| `tools/registry.ts` | `defineTool({name, description, schema, tier, tierFor?, prepare?, describe?, review?, trust?, timeoutMs?, run})` and `createRegistry(tools)`: the API tool list sorted by name, built once; `tierOf(name)`, `callTier(name, input, port)` (a tier that depends on the input or state), `prepare(...)` (async work the card needs, before the gate), `describe(...)` (the confirmation card's sentence), `review(...)` (the card's diffs), `trustFacts(...)` (the call's project, rule specifier, text for the floor, and `asks`). |
| `tools/getTime.ts` | `get_time` (read tier): the local date, time and zone. |
| `tools/read.ts` | The W1 read tools: `list_projects`, `list_sessions`, `get_pending_choice`, `read_session`, `usage_limits`, `git_overview`, `list_notes`, `read_note`, `duck_spend`. Compact JSON, empty fields left out; projects and sessions are named by id or name (`findProject` / `findSession`, which list the choices on a miss or an ambiguity). |
| `tools/act.ts` | The W2 action tools. Reversible: `send_prompt`, `create_session`, `start_session`, `open_panel`, `wait_for_session`, `create_note`, `append_note`, and `resume_session` on a stopped session. Consequential: `answer_choice`, `interrupt_session`, `stop_session`, `kill_session` (the rail's kill: removes the row; refused with a worktree or a remote tmux session), `write_note`, `delete_note`, and `resume_session` over a running session. Note writes leave a "Duck edited" chip. Each tool's `trust` names its project. `answer_choice`'s facts carry the prompt's kind as the specifier, the Claude Code call a "yes" would allow (for the floor), and `grantedBy` (never for a "don't ask again" option). `stop_session`, `kill_session`, `resume_session` and `delete_note` take `grantedBy` too: the user's words asking for that call. |
| `tools/plugins.ts` | The W5 toolbar tools. Read: `list_plugins` (fields with values, actions with their `run` template and last run), `read_plugins` (the raw file and its revision). Consequential: `run_plugin_action` and `write_plugins`, whose `prepare` works out the card. A run's card shows the argv after substitution and the cwd; its facts give the specifier `plugin:action`, the argv as a `Bash` call for the floor, `asks` when the file has a confirm question, and `grantedBy`. It is pinned to the file's revision and previewed again just before it starts; its end comes back through `later` with the exit code and last lines. An edit is checked (`plugins_check`) and its base revision compared in `prepare`, so problems come back at their JSON paths before a card; scripts go into `{data}/scripts/` before the file, and a `plugins` chip offers the diff and undo. `delegate_plugins_edit` hands a change that needs the code read to a drafting session (on the coding model, with the `workbench:plugins` skill, allowed to edit only its draft folder) and watches it; `apply_plugins_draft` reads the draft from disk and goes through the same card and write as `write_plugins`. |
| `summarize.ts` | Session summaries (W3): `createSummarizer({port, backend, call})` reads a session's transcript since its last summary (or a given time) with `readPlainText`'s `since`, makes one Haiku `summary` call, and keeps the last summary per session in duck.db `meta`. `newest` checks a transcript for activity without a call; `withReply` adds a turn's final reply the transcript doesn't have yet. |
| `tools/summaries.ts` | The W3 tools, over `ctx.summaries`: `summarize_session` and `summarize_activity` ("since I was away"). |
| `tools/tasks.ts` | The D1 tools, over `ctx.tasks`: `run_task` (reversible; posts the `task` notice that the thread shows as a live card), `task_status`, `task_followup`, `task_close`, `list_tasks`. |
| `tools/testConfirm.ts` | `test_confirm`, a consequential tool that does nothing, for trying the confirmation card. Registered in dev builds only. |
| `mcp.ts` / `tools/mcp.ts` | External MCP servers (X1), from the settings' `mcpServers` (default: Quest Log at `http://127.0.0.1:7437/mcp`, no token). `createMcpHost(mcpRequest)` caches a server's `tools/list` for 5 minutes and turns a `tools/call` result into text. The tools are fixed, so a server that's down or changes never touches the cached prefix: `mcp_tools` (read: the servers, or one server's tools with their schemas and `readOnly`), `mcp_read` (read: only the tools named in the server's `readTools`), `mcp_call` (consequential: everything else; card summary `server: tool {args}`, specifier `server:tool` so a rule like `assistant:mcp_call(quest_log:create_entry)` can allow one tool, and `grantedBy`). Results come back in `<mcp_result … untrusted>`. The drawer's settings have an on/off and the URL per server. |

Outside the folder, `src/transcript/plainText.ts` (`readPlainText`) writes a session's
recent items as text for `read_session`: user, Claude, one line per tool call, cut to a
character cap from the oldest end. It shares `src/transcript/summary.ts` (a tool call's
target and title) with the DOM renderer.

**Untrusted text:** `read_session` wraps the transcript in `<transcript … untrusted>`, and
any `</transcript>` inside is defused, so a session's text can't close the wrapper.
Questions in pending choices and note contents come back as plain JSON data; the system
prompt's safety rules cover them.

### Rust: `src-tauri/src/assistant/`

| File | What it is |
|---|---|
| `mod.rs` | `Assistant` state (the DB, the launch token, the HTTP client), `init`, and the Tauri commands. |
| `key.rs` | The API key in Windows Credential Manager (`duck/anthropic-api-key`, `duck-dev/…` for debug builds). |
| `proxy.rs` | `/anthropic/{*path}` on the hook server: token check, CORS for the app's origins, endpoint allow-list, budget check, key swap, streaming forward, usage tap. |
| `usage.rs` | The price table, the stream meter, and ledger rows. |
| `budget.rs` | Limits, month-to-date spend, and the cap rule (at the cap only Haiku with a purpose other than `thread` passes). |
| `threads.rs` | Threads, append-only messages and parked batches in `duck.db`; `delete` removes a thread with its messages and batches in one transaction. |
| `summaries.rs` | The last summary per session (W3), JSON in `meta` under `assistant_summary:<instance>`. |
| `workspace.rs` | Duck's workspace (`prepare`, its `CLAUDE.md`), task folders (`new_task`, `result`, both only under `tasks/`), the workers' registration (`register`: a settings file with the allow list in app data, and a `worker_sessions` row in the main DB) and `launch_args` for `pty_spawn`; the `assistant_tasks` records. |
| `replay.rs` | `scan(dir, days, max)`: the tool calls in the transcripts touched in the window, each with its outcome (`ran`, `rejected`, `denied`, `error`, `none`), the conversation's first prompt and the latest one before it, and the permission mode. Behind `assistant_replay_calls`, on a worker thread. |
| `trust.rs` | Rules, project modes, floor-off, the seeded flag, the kill switch (`meta` `assistant_trust_paused`), sessions' mandates (`meta` `assistant_mandate:<instance>`) and the decision log. `set_trust_paused` in `mod.rs` writes the flag, ticks the tray item (`attention::set_trust_check`) and emits `assistant-trust-paused`. |
| `mcp_client.rs` | `assistant_mcp_request(url, token_env, method, params)`: JSON-RPC to an MCP server over Streamable HTTP (X1). One session per URL (`initialize` + `notifications/initialized` on first use, `mcp-session-id` kept, a 404 retried once on a new session); JSON or SSE replies. In Rust because a local server sends no CORS headers, and so a bearer token is read from the environment variable `token_env` names and never reaches the webview. |
| `db.rs` | `duck.db` / `duck.dev.db` and its append-only migrations. |

### The desktop surface: `src/panels/Assistant/`

| File | What it is |
|---|---|
| `duckState.ts` | The desktop's one subscription to the protocol, an external store shared by the button and the drawer: threads, the open thread, loaded messages, streaming text, turn states, locally queued messages, confirmations, spend. Actions (`sendMessage`, `stopTurn`, `answer`, `openThread`, …) only send protocol messages. Persists `assistantDrawer` prefs (width, open thread, interrupt). |
| `view.ts` | `toItems(messages)`: stored messages → display items (user text, reply text, a tool chip with its result attached, notices; thinking and system messages hidden). `sessionLink()` reads `#session/<id>` links. |
| `DuckButton.tsx` | The title-bar button ("D.U.C.K.", the icon beside it): toggles the drawer, the acronym tooltip, a confirmation-count badge, an amber/red tint past the soft limit/cap, ⏸ while trust is paused. |
| `TrustViews.tsx` | `TrustPanel` (kill switch, rules, project modes, the floor with a typed confirmation) and `DecisionsPanel` (the log with make-a-rule / always-ask, the rule from `suggestRule`; and the replay of the past week with its report). Opened from the settings popover; they take the thread's place. |
| `Drawer.tsx` | The drawer: header (thread list, new, the trust pill that is the kill switch, settings, close), thread view (markdown replies, tool chips, queued bubbles), confirmation cards, spend line, composer (Enter / Shift+Enter / Esc, "think hard" = effort `high` for one message). Always mounted and only hidden, so the thread and scroll survive closing. |
| `DrawerSettings.tsx` | Queue-or-interrupt, and "start at login, minimized to the tray" (`@tauri-apps/plugin-autostart`; disabled in dev builds). |
| `DuckIcon.tsx` | The icon as a CSS mask in the accent colour, always the eyeless version. Images in `src/assets/duck/`. |

`src/panels/` is outside the boundary rule, so the drawer may use the stores directly
(it opens a `#session/<id>` link's console with `setActiveProject` + `openConsole` +
`activatePanel`). Everything it learns about Duck still comes through the protocol.

### Outside the Duck tree

- `src-tauri/src/window.rs` builds every webview (the main window and tear-offs) with
  one WebView2 profile, including the no-throttling args that keep the engine's timers
  running while the window is hidden. The debug build has its own profile folder.
- `src/App.tsx` calls `initAssistant()` and mounts the button and the drawer;
  `eslint.config.js` holds the boundary rule.
- `toggleAssistant` (default Ctrl+Shift+Space) and `toggleTrust` (Ctrl+Alt+Shift+Space)
  are in `keyboard/keymap.ts`; the drawer registers their handlers.
- The tray (`attention.rs`) has a right-click menu: Show Workbench, and "Pause Duck's
  trust", a check item that flips the kill switch in Rust.
- `src-tauri/src/plugins/draft.rs` owns toolbar drafts: it writes the embedded
  `workbench:plugins` skill (`src-tauri/resources/claude-plugin/`) to app data, makes
  a project's draft folder, and adds the drafting session's launch arguments in
  `pty_spawn` (`--permission-mode default`, `--plugin-dir`, `--add-dir`, `--settings`
  with an Edit rule for the draft folder only).
- `src/state/promptOutbox.ts` delivers Duck's prompts: one line per session, the
  prompts waiting for a turn's end sent as one, `now` ones into the running turn
  (never into a waiting permission prompt), a prompt taken only on
  `UserPromptSubmit`, Enter retried while the box holds text,
  and a stopped session started with the prompt as its launch prompt
  (`state/launchPrompt.ts`, taken by `terminalPool` at spawn; `pty_spawn`'s
  `initial_prompt` puts it after `--`).
- `src/state/duckOwned.ts` marks Duck's workers (the card's "duck ·", and no toasts or
  pushes for them in `notifications.ts`). `src/panels/BackgroundConsoles.tsx` holds a
  worker's terminal off screen until it runs, so a worker starts without switching the
  shown project (`openConsole(…, {background})`). `deliverWhenReady`'s `trustFolder`
  answers the folder-trust dialog for Duck's workspace.
- The dock's root has `isolation: isolate`, so dockview's layers (floating groups at
  z-index 999) stay under the drawer (z-index 60) while modals (100) stay above it.
- Start at login: `tauri-plugin-autostart` (pinned `~2.5.1`; later versions need Tauri
  2.12) registers the app with `--minimized`; `window::build_main` then builds the main
  window hidden, and a left click on the tray icon shows it (`window::show_main`).

### `duck.db` tables

- `assistant_usage`: one row per API call.
- `meta`: budget limits.
- `assistant_threads (id, title, mode, created, updated)`.
- `assistant_messages (thread_id, seq, ts, role, content JSON, source)`: append-only; a
  trigger refuses UPDATE, and `append` refuses any `seq` but the next. `role` is `user`,
  `assistant`, `system` (a mid-conversation system message) or `notice` (shown, never sent).
- `assistant_pending (id, thread_id, created, data JSON)`: one row per parked tool batch.
- `assistant_rules (id, effect, pattern, project_id, created)`: a null project is global.
- `assistant_decisions (id, ts, thread_id, tool_use_id, project_id, tool, summary, input,
  decision, layer, reason, rule_id, shadow)`: the audit log, the last 5000 rows, kept
  after a thread is deleted.
- `assistant_trust_modes (project_id, mode)`: only projects that aren't `live`.
- `assistant_tasks (id, data JSON, updated_at)`: worker tasks (D1).
- `meta` `assistant_summary:<instance>`: a session's last summary (W3).

The main `workbench.db` holds `worker_sessions (instance_id, effort, permission_mode,
strict_mcp, add_dir)`, which `pty_spawn` reads at each launch.

## The engine loop

One turn on a thread (`engine.ts`):

1. **Append the user message.** If the wanted effort differs from the one in force, also
   append a mid-conversation system message `{content: [], output_config: {effort}}`.
   This keeps the cache; a top-level effort change would invalidate it. The default is
   `medium`.
2. **Stream a reply** with `client.beta.messages.stream`:
   - Request settings: Sonnet 5.5, adaptive thinking, `fallbacks: "default"`.
   - Caching: a 1-hour cache breakpoint on the system prompt (which also covers the
     tools), plus automatic 1-hour caching for the tail.
   - Context editing (`clear_tool_uses` past 40k input tokens) and the purpose header
     `x-wb-purpose: thread`.
   - Text deltas are emitted as they arrive.
3. **Act on the stop reason:**
   - `end_turn`: done.
   - `pause_turn`: append the reply and resend.
   - `tool_use`: see step 4.
   - `max_tokens`: keep the reply only if it has no tool call (a cut-off tool call can't
     be answered), then show a notice.
   - `refusal` (the whole fallback chain declined): don't keep the reply; show a notice
     with `stop_details.explanation`.
   - `model_context_window_exceeded`: show a notice.
4. **Tools:**
   - Each call is validated with its zod schema, then the gate (the trust policy) decides:
     - `run` (default for the read and reversible tiers): runs now. All calls that may
       run do so in parallel, each within its time budget (default 10 s; a timeout
       becomes an `is_error` result and aborts the tool's signal).
     - `deny` (a trust rule): the call fails at once with the gate's reason.
     - `ask` (default for the consequential tier when no rule allows it): the batch is **parked**, written to
       `assistant_pending` with the results so far, and a `confirm` event goes out for
       each ask.
   - `confirm()` records each answer. Once every ask is answered it runs the allowed
     calls, turns denied ones into `is_error` results, and sends all results back in
     **one** user message. Then the loop continues.
   - Because parked batches are persisted, a confirmation survives a reload.
5. **Stop** (AbortController):
   - During a stream, the reply's text is kept, and thinking and half-made tool calls are
     dropped.
   - During tools, the results that exist are stored and the rest become "stopped".
   - While parked, every open ask is answered "stopped".
   - Each case ends with a `stopped` notice.
6. **Errors:**
   - The proxy's `402 budget_exceeded` becomes a `cap` notice.
   - Any other failure becomes an `error` notice.
   - After 25 rounds in one turn the engine stops with a `rounds` notice.

**Deleting a thread** (`deleteThread`): refused while a reply runs (stop it first). A
parked thread is deleted with its batch, so its confirmations vanish; its queue is
dropped. Every surface gets `threadDeleted`. Spend rows are kept.

**Other rules:**
- **Queueing:** a message sent while a turn runs, or while one is parked, waits in a
  per-thread queue and runs next. It is never dropped.
- **History is append-only.** `toApiMessages` only filters what is sent: it drops notices,
  and drops a system message that a failed turn left in front of a user message (the API
  needs a system message to be last or followed by an assistant turn).
- **Thread titles:** the first message of a new thread is named by the `title` primitive
  (Haiku, thinking off), fire and forget.

## Adding a tool

1. Write `src/assistant/tools/<name>.ts` with `defineTool`:
   - a `snake_case` name;
   - a description that says when to use it;
   - a zod object schema;
   - a tier;
   - `timeoutMs` if 10 s is wrong.

   Work that can take longer must return a handle at once and report later as a new
   message in the thread.
2. If it needs app state or actions, add a member to `WorkbenchPort` and implement it in
   `port.local.ts`. Never import a store from the tool.
3. Give a non-read tool a `trust(input, port)` that names the call's project (and any
   text the floor should read), so per-project rules and modes apply to it. If its card
   needs async work (what a command will really run, a file's current text), do it in
   `prepare` and read the result in `describe`, `review`, `trust` and `ctx.prepared`.
4. Add it to `TOOLS` in `index.ts`.

   Adding or changing a tool changes the cached prefix, so the next request in every
   thread re-writes the cache once.

## Calling the API from anywhere else in Duck

- Use `getClient()` and always pass `purpose(...)`.
- A main-thread call is `thread`.
- A Haiku job goes through `oneShot` with its own entry in `PRIMITIVES`.
- Never send an unmetered endpoint: the proxy allows only messages, count_tokens and
  models.

## Language

Duck always replies in English, whatever language you write in (English, Russian or
Spanish). It uses another language only when the conversation calls for it: a word
being discussed or translated, or an explicit request. Thread titles are English too.
Both rules are in `prompt.ts`.

## Not built yet

- The Sonnet toggle (M2, once there is a Haiku thread to step up from); the drawer has
  "think hard" (effort `high`) instead.
- Effort routing (M2).
- Duck answering Claude Code questions and plans, and promoting rules into Claude Code's
  own settings (T3).
- Git writes from Duck (left out of W2 on purpose).
- The WebSocket transport (R1).
