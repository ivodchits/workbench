# Duck — architecture

How Duck (the D.U.C.K. assistant) is built, as it stands. The plan and the reasons
behind each decision are in `assistant-plan.md`. This file describes the code, and every
Duck step updates it as part of its Done when. Duck's self-development sessions (L3)
read it first.

Last updated: step H5 with R4 (2026-10-23). L3 audited it against the code. Since W5 it also
covers W6, D2, D4, P1, P2, M2, M3, A5, A6, A7, W4, L1, L2, L3, L4, R1, R2, R3, B1, B2, T3, D3, V1 to V7,
V8, S1, S2, X1, H1 to H5, H8, R4 and the morning routine. A fresh session changing Duck: read "The shape", then "Where to
change X" at the end, then the module rows it points to.

## The shape

```
 surfaces ── Duck Protocol ──▶ engine (TS, main webview) ──▶ SDK ──▶ /anthropic proxy (Rust) ──▶ API
 (drawer,     protocol.ts      engine.ts: the loop          client.ts   key, token, ledger, cap
  phone R1)                    tools/: registry + tools
                               threads.ts ──▶ assistant_* commands ──▶ duck.db
                               port.ts ──▶ port.local.ts ──▶ Workbench stores
                               brain/ ──▶ brain_* commands ──▶ claude -p on the subscription (M3)
                                  ▲                                │ tools/call
                                  └── brain-tool-call ◀── /duck/mcp ◀┘
```

- **Two brains.** A turn runs on the API (the engine's own loop) or, when the API credits
  run low, on the subscription brain: a headless Claude Code per thread whose only tools
  are Duck's, served over MCP and run by the same engine (step M3).
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
| `protocol.ts` | The Duck Protocol, version 1: `ClientMessage` (send, stop, confirm, thread.new, thread.delete, thread.compact, sync, thread.open, settings.set, trust.pause, trust.rule.add, trust.rule.remove, trust.mode, trust.floor, trust.decisions, trust.replay, task.close, task.rerun, task.diff (L3: open a change to Duck's branch in the Diff/Review panel), thread.memory (L1: "don't remember this conversation"), L4's thread.keep (the pin that keeps a thread from the clean-up), thread.view (the thread a surface shows: the drawer sends it on every switch, the bridge for each phone), routine.set (pause, resume, delete, run now) and backup.create (the settings' button), autopilot, reader, dnd, and V4's turn.commit / turn.withdraw for a `provisional` send) and `DuckEvent` (threads, history, thread, threadDeleted, message, delta, provisional, withdrawn, goThread, tool, confirm, confirmed, turnState, routing, spend, settings, trust, decisions, decision, tasks, autopilots, routines (L4: every routine as a `RoutineView` and the backup as a `BackupView`), replay, reader, error). A `ConfirmRequest` carries the tool's `summary` and, for a file edit, `review` (each file's before and after, shown as diffs); a `note` notice carries a `NoteEdit` (before, after, revision) and a `plugins` notice a `PluginsEdit` (the plugin file and its scripts, before and after, and the new revision) and a `memory` notice a `MemoryEdit` (`core.md`'s path, before and after, W4) for the drawer's chips. Source `event` marks a follow-up from Workbench, not the user. B2: `hosted.get` (with `refresh`) → `hosted` (`HostedServerView`: the stdio servers Duck could host); a `ConfirmRequest`'s `choices` and `denyLabel`, and `confirm`'s `choice`. `createLocalTransport` stamps `v`. |
| `settings.ts` | Duck's settings (pref `assistant`): `confirmPrompts` (ask before every prompt sent to a session), `codingModel` (what `create_session` uses for coding work) `answerSessionPrompts` (T2: off by default, which keeps the trust watcher in shadow mode for every project), `codingPermissionMode` (M4), the workers' `maxWorkers`, `headlessWorkers` (D4), `workspace`, `tiers` (D1: each tier's model and effort), `workerIdleStopMinutes` and `closeFinishedHours`, `summaryOnDone` (W3), `planApproval` and `settledPromotions` (T3), `sessionModes` and `sessionModel` (D3: the built-in modes that think on the subscription, and on which model), `announce` and `dndUntil` (V5), `mcpServers` (X1), `mcpHost` and `firefox` (B2: the stdio servers Duck hosts, by name; the bridge's server, the agent profile, the agent's and your browser's names, your sites), `disabledSkills` (S2: skills turned off, by name), `compactAt` (A6: compact a thread past this many input tokens; 0 never), `deleteIdleThreadsDays` (L4: housekeeping deletes threads idle this long; 7, 0 never), `reminderSpellMinutes` (H8: the quiet spell after which the general reminders come up again; 30), and `google` (the Desktop OAuth client id for Drive and Sheets; the first build's `morning.googleClientId` is taken over). Loaded at start, changed only through `settings.set`. |
| `policy.ts` | `createPolicy({settings, trust, messages})`: the gate, an adapter over the trust engine. It builds a `TrustRequest`, runs `decide`, applies the rate guard and logs the decision. A `deny` becomes the call's error, and a rate-guard trip a `trust` notice. Without a trust store it is W2's: consequential calls ask, and prompts too when `confirmPrompts` is on. |
| `trust/rules.ts` | Rules in Claude Code's syntax (`assistant:write_note`, `assistant:answer_choice(question)`, `Bash(npm test:*)`, `Edit(src/**)`, `WebFetch(domain:x)`): `parseRule`, `matches`, `evaluate` (deny > ask > allow, global plus the call's project). |
| `trust/floor.ts` | `FLOOR`: the always-ask entries as data, each with must-catch and must-pass examples; `floorHit(texts, off, exception?)`. L4: `FLOOR_EXCEPTIONS`, named exceptions a tool claims in its facts (`floorException`): each lets one exact text past one entry, and every other entry still reads it. The only one is `duck-data-push` (`git push origin HEAD (duck-data)` past `push`). |
| `trust/mandate.ts` | `findGrant(messages, quote, now)`: the user's own recent message a `grantedBy` quote comes from. `quotes(text, quote)` (T3): whether `create_session`'s `delegatedBy` is in the user's latest message. |
| `trust/decide.ts` | `decide(request, config, {grant})`, in this order: kill switch / project `off` / tripped thread (W2's answer), floor (and a tool's own `asks`, such as a plugin action with a confirm question), the confirm-prompts setting, rules, mandate, tier. `baseline()` is W2's answer. |
| `trust/store.ts` | `createTrustStore(backend)`: rules, modes, floor-off and the kill switch in memory, written through to duck.db. It seeds `STARTER_RULES` once (L4 added `allow assistant:git_push(duck-data origin)`; an install seeded before it asks for the push until you add it), holds the in-memory rate guard (keyed by thread, or `session:<id>` for a session's prompts; `trip()` trips one at once), and keeps the decision log. |
| `trust/session.ts` | Claude Code permission prompts (T2), the deterministic half: `decidePrompt(req, config)` (null when trust doesn't apply; else the session's rate guard, the floor, a file write outside the session's folder but not Claude Code's own scratchpad, memory or plan files, the rules; else `judge`), `pickYes` ("Yes" by label, only from options read off the screen), `callLine`. |
| `trust/judge.ts` | The judge: `JUDGE_SYSTEM` (frozen), `Verdict`, `judgeText` (the call in `<untrusted>`, the mandate in `<task>`, tags inside defanged, long strings cut) and `judge(input, call)`: Haiku (`judge`), and on `ask` + `medium` Sonnet (`judge2`); only `allow` + `low` passes. |
| `trust/watcher.ts` | `startTrustWatcher({port, trust, judge, notice, holdOther})`: decides every permission prompt as it opens; allow answers "Yes", deny sends Esc and posts a notice to the thread that started the session, ask leaves it to you. Registers the needs-you hold (a question's or a plan's goes to `holdOther`, T3), logs every decision (`superseded` when the prompt closed first), and leaves a line under the session's card. `waitForChoice` is shared with `delegate.ts`. |
| `trust/delegate.ts` | T3: `startDelegateWatcher({port, trust, call, notice, planApproval, skip})` for questions and plans outside autopilot runs and workers. A question gets Sonnet's pick (`ANSWER_SYSTEM`, purpose `delegate-question`): answered in a `delegated` session, a suggestion on the card otherwise, a serious one always yours. A plan gets a review against the mandate (`PLAN_SYSTEM`, `plan-review`) on its card, and with `planApproval: "approve"` one that passes is approved with "Yes, manually approve edits" (`pickManual`, by label from the screen). Follows the project's trust mode; logs `delegated` / `plan-review` rows. See "Questions, plans and promotion" below. |
| `trust/promote.ts` | T3: `promotions(rows, config, settled)` (a pattern, `suggestRule`'s, approved `PROMOTE_AT` = 3 times in a project by a rule or the judge, shadow included; never a bare tool), `withAllow(text, pattern)` (the settings file with it on `permissions.allow`, everything else kept), `lineDiff`, and `createPromoter` (counts the newest 2000 decisions, previews, promotes to Claude Code's list or a Duck rule, dismisses; settled keys in `settledPromotions`). |
| `trust/replay.ts` | `replay(calls, deps)`: the past week's tool calls (`assistant_replay_calls`) through `decidePrompt` and the judge (every call you rejected, a sample of the rest), reported as disagreements, refusals of calls that ran, and a sample of what would still ask. |
| `tasks.ts` | Worker tasks (D1): `createTaskManager({port, backend, settings, tell})` keeps the records (`assistant_tasks`), starts queued tasks while `maxWorkers` allows (a start takes its slot synchronously), settles a task on its worker's turn end from a fresh `result.json` (one nudge, then the last reply), reports every outcome to the asking thread as a `<workbench_event>`, and handles follow-ups, closing and the records left running by a restart. `firstPrompt`, `briefText`, `tierOf`, `parseResult` are exported for tests. L3: a task marked `self` (a change to Duck, from `improve_duck`) has its branch read when it finishes (`port.worktreeChanges`, checked by `safetyFiles`) before the thread is told; the record keeps `changes` (branch, base, files, the uncommitted ones, the ones in the safety layer), and the report says them. L4: a task marked `quiet` (a routine's own: housekeeping, a backup repair) never tells its thread that it started, waits or finished; the routine reads its outcome. A worker's question still goes to Duck. |
| `apiWorker.ts` | The API worker (D2): a worker task run on Duck's API credits instead of a session when the subscription's limits are close (5-hour window at 70%, week at 80%; `tasks.ts` `route()`). A task marked `prep` (the morning routine's `prep_ahead`) never goes to the API: it waits until the window resets. One sub-loop on the tier's model with the server's web search and fetch and one tool of ours, `submit_result`, which writes the same `result.md` / `result.json`. Purpose `api-worker`. |
| `autopilot.ts` | Plan autopilot (P1, P2): Duck runs a session's "step → /compact → continue" loop. After each turn an `autopilot-review` call (Sonnet, low effort, structured) says `continue`, `needs_you` or `plan_done`. Unattended runs (P2) keep to a window or an end time, pause over a subscription limit (`AUTOPILOT_LIMITS`) and carry on after the reset, pause on the same step failing twice, and check in on a stalled turn. One per session, kept in `assistant_autopilots`. |
| `modes.ts` | Modes (S1): `MODES` (`assistant`, `chat`, `duck`), each `{title, about, effort, systemPrompt, tools, voicePatience}`; `modeOf(id)` (an unknown id is the assistant), `findMode` / `allModes` / `setUserModes` (S2: the modes from skills), `systemFor(mode, assistant)` (the mode's built-in prompt, or the assistant's from the config), `patienceFor(mode, setting)` (the more patient of the two), `thinksOnSession(mode, sessionModes)` (D3: the mode's threads think on the subscription brain; `Mode.backend`, a skill's `backend: session`). `CHAT_PROMPT` and `DUCK_PROMPT` keep `SAFETY_RULES` verbatim. See "Modes" below. |
| `toolset.ts` | `TOOLS` (every tool Duck has; the test tools in dev builds), `DEFERRED` (the ones loaded on demand), `SERVER_TOOLS` (B1: the API's web search and fetch) and `TOOL_NAMES` (Duck's and the server's: what a mode or a skill may name), for `index.ts` and the tests. |
| `tools/web.ts` | B1: `WEB_TOOLS`, the server's `web_search_20250305` (5 a reply, the user's timezone for local results) and `web_fetch_20250910` (8 a reply, a page cut to 12k tokens). See "The web" below. |
| `skills.ts` | Skills (S2): `parseSkill(row, known, disabled)` turns a `SKILL.md` (read by `skills.rs`) into `{name, description, body, tools, mode, problems, enabled}`. `tools:` must name Duck's tools; `mode:` makes a `Mode` (the body inside `BASICS` and `SAFETY_RULES`, `tools:` or `COMMON_TOOLS` plus `switch_mode`, `effort`, `pauses`, `title`), and can't be a built-in id. `skillsBlock(skills)`: the `<skills>` block, the usable ones sorted by name, then the modes they add. `createSkills({store, tools, disabled})`: `list()` reads (one read at a time), registers the modes (`setUserModes`) and calls `onChange` when the list differs; `write` goes over `expected` and reads again. See "Skills" below. |
| `routing.ts` | Per-message routing (M2), no classifier call: effort the thread's mode's (`medium`, `high` for a rubber duck), `high` for "think hard" (English, Russian, Spanish) and research, plan or comparison asks; the model is Sonnet, or Haiku for the rest of the month past the budget's soft limit, where "think hard" sends that one message on Sonnet. |
| `announce.ts` | Announcements (V5): Duck's reply to a `<workbench_event>` is the news, said at its producer's level (`info`, `report`, `needs_you`) on this PC when you're at it, else a phone with Duck open, else a push. Do Not Disturb, quiet hours, full-screen apps, the Speak switch, waiting for a gap, and batching are its etiquette (`AnnounceSettings`). An announcement never turns the mic on (V8): turning it on within a minute of one said in full opens its thread first (`heardAnnouncement` / `replyTarget` in `voiceState.ts`). |
| `speakable.ts` | Spoken replies' words (V2): `Sentences` cuts a stream into whole sentences, `toSpoken` makes one sayable, `langOf` picks Kokoro (English) or Silero (Russian), and a Russian sentence with digits or Latin letters gets the `speakable_ru` Haiku rewrite or `russianFallback`. |
| `reader.ts` | Read-aloud (V3): a source in sections, each made when its turn comes (narrated by Haiku first in `narrate` mode), played on the desktop or the phone that asked, after the reply is over; pause / resume / next / previous / stop, and a position kept per source for "continue reading". |
| `voiceNames.ts` | The name fixer (V1): project and session names and a term list, said in Russian and written in Cyrillic by Parakeet, put back in their own spelling with loose matching for longer names. |
| `remoteBridge.ts` | Duck on the phone (R1): the webview's half of the remote server's `/api/assistant` socket. Frames are checked against what a phone may do (no settings, no loosening trust, no replay, no thread delete); messages are stored as `phone` / `phone-voice`; spoken replies, reads and announcements go down as `tts` parts a sentence at a time; screenshots never go to the phone. A socket that says `hello` is also a host (H1): its `hello` / `device.result` frames go to `hosts.ts`, and its calls come down as `device.call` / `device.cancel`; only `phone` can be a host over it. H5: a phone host gets `phone.reminders` (the open reminders' coming times, `phoneAlarms` in `reminders.ts`: two weeks of a repeat's) on hello and on each change, and its `reminder.action` (Done / Snooze from the app's own notification) goes to `actOnReminder` in `index.ts`, from a socket that said hello only. |
| `hosts.ts` | Host-bound tools (H1): `createHosts(declared)` holds each connected host (`pc`, `phone`) and the tools it offers (only the engine's own for that host count); `call(host, tool, input, signal)` sends `device.call` and settles on `device.result`, a stop or timeout sends `device.cancel`, a host that isn't there or didn't announce the tool fails at once ("the phone isn't connected"), and one that leaves or reconnects fails its open calls. `serveHost` is a host's side (hello with its handlers, refuses a tool it didn't announce, aborts on cancel); `connectLocal` joins the two in process, for the desktop's `pc` tools. |
| `spend.ts` | `createTurnMeter()`: bills each metered `thread` call to the one turn that is calling (none if two are), giving each thread's latest turn cost for the `spend` event. |
| `timings.ts` | D3: `createTurnClock` times each turn you start from the engine's events (start, `routing`'s mode and brain, the first delta, the first sentence, idle or parked), with an API turn's cost from the meter and the subscription's 5-hour window before and after; the endpoint keeps each in `turn_timings`. `timingStats` / `statLine`: the medians per mode, brain and model, $ an hour on the API and the window's % an hour on the subscription, over conversations of 5 minutes or more (protocol `timings.get`). |
| `engine.ts` | The loop. Pure helpers `toApiMessages`, `effectiveEffort`, `buildParams` and `eventText` are exported for tests. Each tool call gets a `ToolContext` with the settings, `notice()` (a thread item the model never sees) and `later(text)` (a follow-up sent into the thread as a `<workbench_event>` user message with source `event`, which runs its own turn). A tool with `prepare` has it run first (a throw fails the call before any card); what it returns is kept on the call (`BatchCall.prepared`, persisted with a parked batch) and handed to `describe`, `review`, `trust` and `run` (`ctx.prepared`). The gate is asked with the call's own tier (`registry.callTier`), the card's summary and the tool's trust facts (`registry.trustFacts`). It answers run, ask, or deny with a reason, and an optional notice. |
| `threads.ts` | `createThreadStore(backend)`: threads, messages (loaded per thread on first use) and parked tool batches, in memory and persisted. Appends to one thread are serialized so each gets the next `seq`. |
| `client.ts` | `getClient()` (the SDK at the proxy, with the launch token as its key), `purpose()`, `capMessage()`, `errorMessage()`, `structured({model, system, input, schema?, purpose, …})` (one call, structured output parsed), and `oneShot(name, input, {schema?})` for Haiku primitives over it. |
| `prompt.ts` | The system prompt and the voice note as built in (L3: the defaults; what a thread runs with comes from `config.ts`), `MAIN_MODEL` / `PRIMITIVE_MODEL`, and `PRIMITIVES` (one frozen prompt per Haiku job; the key is its `x-wb-purpose`). |
| `config.ts` | Duck's prompts as data (L3): `config/system.md` and `config/voice.md` in the workspace (`CONFIG_FILES`). `createConfig(store)`: `current()` reads them, seeds a missing one with its default (recording the default's hash as the seed), lets a file untouched since its seed follow a new build's default, and falls back to the default for one `problemsWith` refuses (too short or long, or without `SAFETY_RULES` verbatim), saying why; `forThread(id)` returns the thread's pin, or pins it on the files now (`assistant_config_pin`), so a thread's system prompt never changes under its cache. `applyEdits` (each `find` exactly once), `hashOf`, `ipcConfigStore`. |
| `selfdev.ts` | Duck changing its own code (L3): `SAFETY_PATHS` / `safetyFiles` (the trust engine, `proxy`/`budget`/`key`/`trust.rs`, L4's `gitlane.rs` (the push guard), and `selfdev.ts`, `config.ts`, `tools/improve.ts`), `selfProject` (the project whose folder or name is "workbench", unless named), `improveBrief` (the request, the related `lessons` entries, where to read first, the allowed paths, the safety layer, the test commands, "commit on the branch, don't merge or push", and `result.md`'s contents), `REBUILD`. |
| `port.ts` / `port.local.ts` | `WorkbenchPort` and its one implementation over the stores. The only file under `src/assistant/` allowed to import `src/state/**` or `src/panels/**`. Members: projects, sessions (live phase, pending choice with its id, worktree, model, last activity), transcript paging, usage limits, a git snapshot of a directory, notes list/read, Duck's spend; and the W2 actions: `sendPrompt` (`state/promptOutbox.ts`: one prompt per turn, confirmed by `UserPromptSubmit`; a stopped session is resumed with the prompt on claude's command line), `createSession` (`startNewSession` from `state/remoteActions`, shared with the phone), start/resume/interrupt/stop/kill, `answerChoice` (refused unless the named prompt is still open), `openPanel`, note writes, `onPhase`, `onSessionYouStarted` (H8: a session you started from the rail or the phone, from `state/registry.ts`; Duck's own aren't told); L3's `worktreeChanges` (`instanceDiff` against the project's current branch, and `gitStatusEntries` in the worktree for what isn't committed), `mergeWorktree` (`teardownWorktree` with a merge into the target `worktreeTeardownInfo` names: the rail's own path) and `runInShell` (`newShell`, `whenShellRunning`, then the command typed into the PTY); and W5's plugins: `listPlugins` (the parsed file, each plugin's field values as a run sends them, each action's last run), `pluginsText`, `checkPlugins`, `writePlugins`, `readScript` / `writeScript`, `previewPluginAction` (the argv and cwd the backend would spawn, and the confirm question filled in), `runPluginAction` (`startPluginRunFor` in `panels/pluginRun.ts`: no confirm question, refused while running, the project shown first because task panels are drawn for the shown project only) and `onTaskEnd` (from the tasks store; the last lines come from `terminalPool.readTail`); `startPluginsDraft` (`startNewSession` with `beforeLaunch`, which makes the draft and registers the session before its first launch), `readPluginsDraft`, `clearPluginsDraft`; and T2's: `choiceOf`, `onChoices`, `holdNeedsYou` (`state/promptHold.ts`; `onPhase` also waits on it for a fresh needs-you, and drops one Duck answered), `sessionContext` (the stored mandate, else the transcript's first prompt; the latest prompt; the home folder; T3's `delegated`), `noteSession` (`state/trustLines.ts`, the line under the card) and T3's `adviseChoice` (`state/choiceAdvice.ts`, a line on the choice card while that prompt is open). `createSession` and `startPluginsDraft` store a `mandate` (memory and duck.db `meta`). |
| `fakePort.test-util.ts` | `fakePort(data)` and the `project()` / `session()` builders: a port over fixture data for the engine's and the tools' tests. Actions are recorded in `calls`, notes writes keep the revision check, `phase()` fires `onPhase`. `toolCtx(port)` is a tool context that records notices and follow-ups. Plugin files are kept as text with a revision counter (`fakeCheck` stands in for the parser), and `endTask()` ends a run. |
| `tools/registry.ts` | `defineTool({name, description, schema, tier, tierFor?, prepare?, describe?, review?, trust?, timeoutMs?, run})` and `createRegistry(tools)`: the API tool list sorted by name, built once; `tierOf(name)`, `callTier(name, input, port)` (a tier that depends on the input or state), `prepare(...)` (async work the card needs, before the gate; it gets the settings and the Google host too), `describe(...)` (the confirmation card's sentence), `review(...)` (the card's diffs), `trustFacts(...)` (the call's project, rule specifier, text for the floor, and `asks`), and `toolsFor(names)` (S1: a mode's tools, none deferred, built once per set). `opts.server` (B1) are the API's own tools, sent as they are after the tool search; a mode names them like any other. Tools in `toolset.ts`'s `DEFERRED` (M2: the plugin, autopilot and screen tools and a few rare ones) go out with `defer_loading` and are found with the server's regex tool search, which keeps the fixed prefix small. B2: `setExternal(defs)` replaces the hosted servers' tools, added after Duck's own and always deferred (one of Duck's names is never replaced); `ToolDef.inputSchema` sends a JSON Schema as it is; `tierFor` and `callTier` get the call's `prepared`; `choices` / `denyLabel` give the card buttons in place of allow / deny. H1: `host` (`workbench` by default, `any`, `pc`, `phone`); a `pc` or `phone` tool is declared without `run` (its call goes to `ctx.hosts`), is always deferred, and `toolsOn(tools, host)` names a host's tools. |
| `tools/getTime.ts` | `get_time` (read tier): the local date, time and zone. |
| `tools/read.ts` | The W1 read tools: `list_projects`, `list_sessions`, `get_pending_choice`, `read_session`, `usage_limits`, `git_overview`, `list_notes`, `read_note`, `duck_spend`. Compact JSON, empty fields left out; projects and sessions are named by id or name (`findProject` / `findSession`, which list the choices on a miss or an ambiguity). |
| `tools/act.ts` | The W2 action tools. Reversible: `send_prompt`, `create_session`, `start_session`, `open_panel`, `wait_for_session`, `create_note`, `append_note`, and `resume_session` on a stopped session. Consequential: `answer_choice`, `interrupt_session`, `stop_session`, `kill_session` (the rail's kill: removes the row; refused with a worktree or a remote tmux session), `write_note`, `delete_note`, and `resume_session` over a running session. Note writes leave a "Duck edited" chip. Each tool's `trust` names its project. `answer_choice`'s facts carry the prompt's kind as the specifier, the Claude Code call a "yes" would allow (for the floor), and `grantedBy` (never for a "don't ask again" option). `stop_session`, `kill_session`, `resume_session` and `delete_note` take `grantedBy` too: the user's words asking for that call. |
| `tools/plugins.ts` | The W5 toolbar tools. Read: `list_plugins` (fields with values, actions with their `run` template and last run), `read_plugins` (the raw file and its revision). Consequential: `run_plugin_action` and `write_plugins`, whose `prepare` works out the card. A run's card shows the argv after substitution and the cwd; its facts give the specifier `plugin:action`, the argv as a `Bash` call for the floor, `asks` when the file has a confirm question, and `grantedBy`. It is pinned to the file's revision and previewed again just before it starts; its end comes back through `later` with the exit code and last lines. An edit is checked (`plugins_check`) and its base revision compared in `prepare`, so problems come back at their JSON paths before a card; scripts go into `{data}/scripts/` before the file, and a `plugins` chip offers the diff and undo. `delegate_plugins_edit` hands a change that needs the code read to a drafting session (on the coding model, with the `workbench:plugins` skill, allowed to edit only its draft folder) and watches it; `apply_plugins_draft` reads the draft from disk and goes through the same card and write as `write_plugins`. |
| `summarize.ts` | Session summaries (W3): `createSummarizer({port, backend, call})` reads a session's transcript since its last summary (or a given time) with `readPlainText`'s `since`, makes one Haiku `summary` call, and keeps the last summary per session in duck.db `meta`. `newest` checks a transcript for activity without a call; `withReply` adds a turn's final reply the transcript doesn't have yet. |
| `tools/summaries.ts` | The W3 tools, over `ctx.summaries`: `summarize_session` and `summarize_activity` ("since I was away"). |
| `tools/tasks.ts` | The D1 tools, over `ctx.tasks`: `run_task` (reversible; posts the `task` notice that the thread shows as a live card), `task_status`, `task_followup`, `task_close`, `list_tasks`, and D2's `task_rerun` (deferred). `findTask` and `view` are shared with `tools/improve.ts`. |
| `tools/improve.ts` | L3: `improve_duck(request, scope, effort?)` (reversible): scope `config` returns the prompt files for Duck to draft from; scope `code` starts a `self` code task, tier serious (Opus, `medium` unless named), in a worktree of the Workbench repo, with `improveBrief`. `propose_config_change(file, edits, why)` (consequential, `asks`: always a card): `prepare` makes the edits on the file as it is and checks the result, the card shows the diff (`review`), `run` writes it over the text it was read as and commits it; new threads get it. `merge_duck_change(task, safetyConfirmed)` (consequential, `asks`; deferred): `prepare` reads the branch fresh and refuses an unfinished task, an empty branch or uncommitted files; a branch in the safety layer takes two cards, the second only after the first was confirmed (`firstConfirms`, in memory); then `port.mergeWorktree` and the task closes. `rebuild_duck(build)` (consequential; deferred): `npm run tauri:dev` or `tauri:build` in a new shell in the repo. |
| `tools/skills.ts` | S2: `load_skill(name)` (read: the body; a skill with `tools:` narrows the rest of the turn through `ctx.narrow`), `draft_skill(name, text, why)` (consequential, deferred, `asks`: the whole `SKILL.md`, checked by `parseSkill` in `prepare`; the card's diff is the file before and after; written over what was read and committed). `splitDraft` reads a draft's frontmatter as `skills.rs` does. |
| `tools/threads.ts` | Duck's own threads (A5, A7): `start_thread` (the user's own words, cut from their message, go in as its first message; with `go`, the surface moves there), `list_threads`, `go_to_thread` (the surface moves once this reply is over), consequential `delete_thread`, and S1's `switch_mode` (`start_thread` with `go` into a new thread of another mode). |
| `routines.ts` | Routines (L4): `Schedule` (every hour; a day, a weekday or a date of the month at a time, local; `idle`: after the first idle hour from then on), `Action` (a message to Duck in the routine's thread, a skill to run (S2), a worker task from a brief, or a built-in `job`: `backup`, `housekeeping`, `docs`), `nextSlot`, `isDue` (an idle slot whose day has gone by runs at once), `scheduleText`. `createRoutines({backend, run, idleMs})`: `load` adds the missing `BUILT_IN` routines (hourly backup, Sunday housekeeping, monthly docs; pausable, not deletable), `tick` runs what's due (one run per routine; a missed slot runs once, then the next slot is counted from now), `runNow` (its slot stays), `memo` (a job's state on its record). Records in `routines`. |
| `housekeeping.ts` | What routines do (L4): `createHousekeeping(deps).run(r)`. A message routine tells its thread (a `<workbench_event>`), a task routine runs a task there; the built-in ones report to one "Housekeeping" thread, made when first needed. **Backup**: `git.status`, then a push only when there's something to push; offline or auth failures are told once as info and as needs-you after a day; rejected or a lock starts a `quiet` standard code task in the Duck project with `repairBrief` (fetch and merge on its branch, never push or force), which Duck merges (`port.mergeWorktree`) and pushes after, telling you only if it's blocked; no remote: a weekly reminder offering `set_up_backup`. **Housekeeping**: `idleThreads` (idle past the setting, not kept, nothing reporting to it, not `busy`, read by the nightly tidy since), deleted through `engine.deleteThread`; `git.housekeep` (the mechanical part); then a `quiet` standard code task with `housekeepingBrief` tidies `memory/` on its branch. Its branch is merged when every file is under `memory/` or `skills/`, all committed, and every entry `git.review` finds dropped is in its `result.json` `removed` with a reason and a source; otherwise the thread gets it for your OK (`merge`). **Docs**: a `self` code task with `DOCS_REQUEST` through `improveBrief`, merged as any change to Duck. `check()` follows the routines' tasks (on every task change). |
| `tools/routines.ts` | L4, all deferred: `schedule_routine` (reversible: a message or task routine reporting to this thread), `list_routines` (read, with the backup's state), `pause_routine` (pause / resume / delete), `git_push` (consequential: Duck's data repo to `origin` now; no arguments but the fixed repo and remote; trust facts claim the `duck-data-push` floor exception, specifier `duck-data origin`), `set_up_backup(name)` (consequential, `asks`: `gh repo create --private`), `merge_housekeeping(task)` (consequential). `RoutinesHost` is `ctx.routines`. |
| `tools/autopilot.ts` | The P1/P2 tools over `../autopilot.ts`, all reversible: `start_autopilot`, `autopilot_status`, `pause_autopilot`, `resume_autopilot`, `stop_autopilot`. |
| `tools/haikuTask.ts` | `haiku_task` (M2): a reading-heavy chore over transcripts and notes the tool fetches itself, done in one Haiku call so the long text never enters Duck's context (about 25k tokens a source, 100k in all). |
| `tools/screen.ts` | W6: `read_screen` (a session's console as untrusted text, with a hash) and consequential `press_keys`, refused when the screen changed since that hash or when you've typed there lately; keys into an open prompt are judged as `answer_choice`. |
| `tools/screenshot.ts` | V3: `screenshot` (downscaled PNG as image blocks, with the monitor list) and `save_screenshot`. |
| `tools/pc.ts` | H2, the `pc` host's tools (deferred, as every host tool is): `steam_library` (read; installed games, the last played first, `query` filters), `steam_launch` and `steam_install` (reversible; the game named as people say it, `appid` to pick from a call's choices; install searches the store), `steam_activity` (read; the Web API key's playtime, recently played, friends online, a game's achievements), `media_now_playing` (read) and `media_control` (reversible: play, pause, toggle, next, previous), `open_on_pc` (reversible: a web link, or Steam's run / install / store link for a game). `pcHandlers(backend)` is the PC's side, served in process from `index.ts` over `ipc/pc.ts`; each handler checks its input against the tool's schema again. `rankGames` / `clearPick` / `matchScore`: a game by name (exact, the name's start with or without "the", every word, an acronym, inside the name, or one or two typos; roman numerals as digits); a pick is clear at 0.75 and 0.05 ahead of the next, otherwise the call returns up to five choices. |
| `tools/phone.ts` | H5, the `phone` host's tools (deferred, as every host tool is), run by the Android app (`duck-android/`, R4): `phone_set_timer` / `phone_set_alarm` (reversible; the clock app's intents, without opening it), `phone_show_alarms` (read), `phone_media_now_playing` (read) / `phone_media_control` (reversible), `phone_notifications` (read; new since the last look, or `all`; its text wrapped as untrusted by `shape`, `notificationsOutput`), `phone_reply` (consequential; through the notification's own reply action), `phone_find_contact` (read), `phone_call` / `phone_send_sms` (consequential), `phone_flashlight`, `phone_do_not_disturb`, `phone_volume`, `phone_navigate`, `phone_open_app` (reversible). Calls, texts and replies always ask (`trust`'s `asks`). A host tool's optional `shape` (registry) turns the host's answer into what the model gets, in the engine. |
| `tools/media.ts` | H3, all deferred but `open_on_phone` (a `phone` host tool, deferred as every host tool is, served by the phone from H5): `play_music(query, id?, on?)` (reversible; the provider's search in its music category, the first result that names at least 60% of the query's words (`pickItem`), else up to five choices to call again with `id`), `find_video(query)` (read; up to eight, with id, channel and length), `play_video(id, on?)` (reversible). Playing opens the link on the device through its host tool (`open_on_pc` / `open_on_phone`); the device is `on`, else where the user's latest message came from (`ctx.surface`). |
| `music/provider.ts` | H3: the `MusicProvider` interface (`search(query, kind)`, `play(item, device, open)`), `MediaItem`, `coverage` / `pickItem` (the query's words, without filler like "play some", found in the title and artist), `length`. |
| `music/youtube.ts` | H3: `youtubeMusic`, the first provider, over `ipc/music.ts`: a search kept for an hour (each costs 101 of the 10,000 free daily units); play opens `music.youtube.com/watch?v=<id>` for a song, `www.youtube.com/watch?v=<id>` for a video (`youtubeUrl`, only for an 11-character id). |
| `reminders.ts` | H8: the reminders host over `ipc/reminders.ts` (`createReminders`: the latest read of `reminders.json`, `put` over a record's `before`, `forProject`, `opening(first)` (the general reminders' turn-scoped note on a new thread or after `reminderSpellMinutes` without a message), `pulse`), the clock (`createReminderClock`: one timer for the next due, each announced once for its due, late when it came due before the app started; bookkeeping in `meta`), the time rules (`dueAt`, a day being 09:00; `dueText`; `isActive`: open, and due if it has a time), `findReminder` (id, title, or every word), `projectLine`, `view` / `widgetOrder`. H4: `comesUpAt` (the snooze, else the due, else a repeat's latest occurrence come; a later occurrence wins over an old snooze), `nextOccurrence` (daily, weekdays, weekly, monthly kept to the due's day), `completed` (a repeat moves on, else done), `snoozed`, `parseDuration` / `durationText`, `SNOOZE_MINUTES` (10); the host's timers (`timers`, `loadTimers`, `addTimer`, `dropTimer`, rows in `meta`); the clock announces each reminder once per time it comes up (`announce(r, late, at)`) and rings each timer once (`ring`), dropping it. See "Reminders" below. |
| `tools/reminders.ts` | H8: `list_reminders(project?, state?)` (read; timed, by project, general), `add_reminder(title, details?, project?, due?)`, `complete_reminder` / `dismiss_reminder(reminder)`, `edit_reminder(reminder, …, repeat?)` (all reversible; the last two deferred). H4: `add_reminder` takes `repeat` (needs a due); `complete_reminder` moves a repeat to its next time; `snooze_reminder(reminder, for? | until?)` (deferred); `set_timer(duration, label?)` and `cancel_timer(timer?)` (deferred), timers in `duck.db`, no commit; `list_reminders` also gives the running timers. All `host: "any"`. Each change leaves a `reminder` chip with the record's diff and an undo, and a stale write is redone once over a fresh read (`change`, exported for the push's buttons with `closing` and `snoozing`). `remindersFor(ctx, projectId)`: the project's titles for `create_session` and a code `run_task`. |
| `tools/weather.ts` | H2: `weather(place?, days?)` (read, `any` host, deferred): Open-Meteo's geocoding (`"Portland, Oregon"` picks by region or country) and forecast, no key, in °C / km/h / mm: now, the next 12 hours' rain chance, the days. Without `place`, the `home` setting (the drawer tab's Home). |
| `tools/readAloud.ts` | V3: `read_aloud` resolves a source (a session's reply, a note, a summary, text) and hands it to the reader in `verbatim`, `narrate` or `summary` mode. |
| `tools/quiet.ts` | V5: `set_quiet`, Do Not Disturb and the Speak switch by voice or text. |
| `brain/policy.ts` | Which brain answers a turn (M3): `pickBackend` over the `brainPolicy` setting (`auto`, `api`, `subscription`), a mode set to think on the subscription (D3, `session`: there while it has room, whatever the budget), the API's soft limit, a "credit balance is too low" this month (`creditsGone`), and the subscription's windows (both under 70% / 80%, `SUBSCRIPTION_LIMITS`; no reading counts as room). `switchCard` words the card of a switch. |
| `brain/subscription.ts` | The subscription brain's engine side (M3): `BrainHost` (`createBrainHost` over `ipc/brain.ts`; L3: `spawn` takes the thread's system prompt; D3: `BrainSpawnOptions`, the model, effort and `chosen` for a mode that thinks there), `brainPrompt(system, chosen)` / `BRAIN_PROMPT` (the system prompt plus what's different inside Claude Code), `mcpTools` (the registry's own definitions, so the two paths never drift), `toMcpResult`, `storedBlocks` / `storedResults` (a reply kept as API messages: no thinking, tool names without `mcp__duck__`, source `brain`), and the handoff: `brainTurn` puts what the session hasn't seen in front of your message (all of the thread for a new session, the compaction's summary for what it covers, the core memory; the turns since its last reply for a running or resumed one), `lastBrainSeq`, `unanswered`. `ASKED` is what a call parked on a card returns. |
| `core.ts` | Core memory (W4): `memory/core.md` in the workspace, four sections (`CORE_SECTIONS`: About you, Preferences, Standing instructions, Names & nicknames) of one-line bullets. `addFact` / `removeFact` (the fact named, else the one fact containing the words; several is ambiguous and removes nothing), `coreText` (the `<core_memory>` block, null without facts; it says a standing instruction never counts as `grantedBy`), `createCoreHost` over `assistant_core_read` / `assistant_core_write`. Capped at `CORE_MAX_CHARS` (8000, ~2k tokens). |
| `memory.ts` | Long-term memory, the engine's side (L1): `MemoryHost` (`createMemoryHost` over `ipc/memory.ts`), automatic recall (`recallFor`: the message searched, `worthRecalling` keeps up to `RECALL_K` = 3 hits, a memory entry holding two of its words or a note three; slower than `RECALL_MS` or failing, it's left out), `recallNote` (the `<recalled_memories>` block, plus the lesson line when `isCorrection` says the message corrects Duck, in English or Russian), `memoryOff` (a thread's latest `memoryOff` notice), `today`. L2: `recallFor` returns a `Recall` (the note, the query, the hits and how many the search found) and asks `host.question` for a contradiction to carry (`questionLine`, a `<memory_question>` block); `recallRow` makes the log row after the turn: `usedHit` counts a hit as used when the reply says two of its own words (`stems`, cut as the index cuts them, the message's words left out), and a `recall` call in the turn is `selfRecall`. `MemoryHost` gains `log`, `question` and `tidy`. L3: and `suggestion`, carried as a `<duck_suggestion>` block (`suggestionLine`: mention it once, offer `improve_duck`, start nothing unasked). |
| `consolidate.ts` | Memory consolidation (L2): `createConsolidator({threads, messages, tasks, list, apply, state, call, idleMs})`. `run` reads the window since the last run (`consolidationInput`: the memory with `[eN]` ids, your conversations newest first up to 60k characters, without events or threads with `memoryOff`, and the tasks that finished), makes one Haiku `consolidate` call (structured: `Consolidation`), and `planFrom` turns the answer into one `MemoryPlan` (contradictions first, whose entries are then kept out; merges of two or more real ids; retirements; new entries; ids made up or used twice dropped), applied as one commit whose message lists every change. Contradictions wait in the `questions` state for `question`; repeated requests go to `skill_offers` for S2. L3: the input also has `<tool_errors>` (`toolErrors`: tool calls that failed more than once in the window, by tool, not the ones you declined or stopped), and the answer's `improvements` (changes to Duck a pattern calls for) wait in `improve_offers`; `suggestion` hands out one a week at most, each once. No activity, no call. `tick` (every 5 minutes, from `index.ts`) runs it once per local date when you've been away `IDLE_MS` (an hour), or 10 minutes when the last run is over 36 h old; a failure waits an hour. |
| `tools/memory.ts` | W4: `remember_core(section, fact)` and `forget_core(fact)`, both reversible. Each edit is made on the file as read and written over that text; a save of yours in between makes it read again and redo the edit once; the commit message names the fact. L1: `remember(topic, fact, why, conf, tags)` (reversible; refused in a thread you asked it not to remember), `recall(query)` (read; memory and notes), `forget(query)` (consequential: `prepare` finds the entries holding every word, the card lists them, `run` removes them). L2: `tidy_memory` (reversible) runs the consolidation now. All loaded, none deferred. Every write leaves a `memory` chip with the diff and an undo. |
| `tools/testConfirm.ts` | `test_confirm`, a consequential tool that does nothing, for trying the confirmation card, and `test_announce`, for trying an announcement. Registered in dev builds only. |
| `mcp.ts` / `tools/mcp.ts` | External MCP servers (X1), from the settings' `mcpServers` (default: Quest Log at `http://127.0.0.1:7437/mcp`, no token). `createMcpHost(mcpRequest)` caches a server's `tools/list` for 5 minutes and turns a `tools/call` result into text. The tools are fixed, so a server that's down or changes never touches the cached prefix: `mcp_tools` (read: the servers, or one server's tools with their schemas and `readOnly`), `mcp_read` (read: only the tools named in the server's `readTools`), `mcp_call` (consequential: everything else; card summary `server: tool {args}`, specifier `server:tool` so a rule like `assistant:mcp_call(quest_log:create_entry)` can allow one tool, and `grantedBy`). Results come back in `<mcp_result … untrusted>`. The drawer's settings have an on/off and the URL per server. |
| `tools/mcpHost.ts` / `hosted.ts` | The hosted stdio servers' tools (B2): `hostedTools(server, tools, {isBrowser, refLine})` turns a server's list into `<server>__<tool>` tools with its own JSON Schema (`ToolDef.inputSchema`), wrapped results (`hostedOutput`: `<mcp_result … profile untrusted>`, images kept). The Firefox bridge's tiers (`classifyBrowserCall`): read (lists, page text, snapshot, screenshot), in-app = reversible (navigate, tabs, click, type, keys), consequential (upload, script, bookmarks, history, your clipboard, unknown tools); a click, submit or Enter on what reads as submit / pay / log in / send is consequential, and log in, pay, send also put `browser <kind>: …` in the floor's texts; typing into a password, card or code field is refused in `prepare`. `browsers_select` isn't offered. Another server: read with `readOnlyHint`, else consequential. Fixed tools: `use_personal_browser(reason, site?)` (consequential, `asTool: assistant:firefox`, specifier `profile:personal[@site]`; a site on `firefox.personalSites` is reversible via `tierFor`'s `prepared`), `use_agent_browser`, `browser_login(url, why)` (always asks; `choices` agent / personal, `denyLabel` "Skip"). `createHostedSync` rebuilds the registry's hosted tools (`setExternal`) at start and after a settings change, and gives the settings' `hosted` view. |
| `browser.ts` | B2: the thread's Firefox profile. `createBrowserHost({call, startProfile})`: `profileOf` / `setProfile` (default agent), `run(thread, fx, tool, args)` one call at a time, selecting the thread's browser first (`browsers_list` → `findBrowser` → `browsers_select`, trusted 20 s); no agent: 8 s for a new bridge's add-on to reconnect, then `firefox_start_profile` and 25 s more; `connected(fx, profile)`; `refLine(tab, ref)` from the tab's last snapshot. `parseBrowsers`, `findBrowser` (agent: the named one, else the one named like the profile, else the only one not yours), `siteOf`, `personalAllowed`. `FirefoxSettings` / `DEFAULT_FIREFOX`. |
| `google.ts` | Duck's `GoogleHost`: `search`, `read`, `cells`, `exportSheet` (prepares the workspace first), `draft` (into the `DRAFT_FOLDER`, "Duck drafts") and `drafts` (a month's), over the `assistant_sheet_*` commands. `isGoogleExpired` / `googleErrorText` read the backend's `google_expired:` errors. |
| `tools/sheets.ts` | Google Sheets tools (deferred), over `ctx.google`; Duck works out a draft's changes itself, nothing is configured per cell. `find_sheet` (read: sheets by name, at most 10) and `read_sheet` (read: a tab's non-empty cells with formulas, 150 rows by 26 columns, its tabs; wrapped as untrusted). `create_sheet_draft` (consequential, 90 s): `prepare` reads the chosen cells, refuses a formula cell, a formula value, a repeated cell or no change, and the card shows each change old → new with Duck's reason; `run` exports the original to `data/invoices/` (best effort) and hands the plan to `assistant_sheet_draft`, returning the link. Sending stays with the user. Without the sign-in they say to connect in Google Auth. |
| `tools/prep.ts` | Prep ahead of the day (phase 4): `prep_ahead` (reversible, deferred) starts a standard `writing` worker marked `prep` with a fixed, draft-only brief: prep notes for a meeting or a checklist for a deadline. `prepCandidates` gives the briefing today's timed meetings still ahead and overdue, dated or critical items (not the invoice, nor what has prep already); `prepPart` lists the day's prep tasks under `prepared`. |
| `tools/morning.ts` | `morning_briefing` (the morning routine, phase 1; read tier, 30 s): only when the user asks ("morning routine"). One call gathers the day in code, no model call: a fixed list of quest_log reads through `ctx.mcp` (`whoami`, `get_agenda`, `get_calendar_occurrences` today to +2 days, `get_stats`, in parallel, a failed read noted) reduced to the schedule by time, overdue and open items, what's ahead and the invoice entry (by the invoice's tag, default `duck:invoice`), wrapped as untrusted. When the invoice entry (tag `duck:invoice`, with its description, where the sheet's link usually is) is due, it links the drafts Duck made this month (`drafts`, 20 s cap; also in `prepared`), else offers one: on a yes Duck finds the sheet (the description's link, `find_sheet`, or the user), reads it with `read_sheet`, works out the changes and calls `create_sheet_draft`; without the sign-in it says to connect in Google Auth; it offers prep for `prepCandidates` (started only on the user's yes with `prep_ahead`) and lists the day's prep and the invoice draft under `prepared`; an expired token becomes "reconnect in Duck's settings"; and Workbench's sessions waiting on the user, worker tasks, autopilots, limits and the git exceptions of projects in use. The result carries the briefing's order (the system prompt is frozen and has no dates) and where to save it: the "Duck" project's `morning-<date>` note, made with `create_note` or added to with `append_note`. Quest Log down: it says so and briefs on the rest. |

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
| `key.rs` | The API key in Windows Credential Manager (`duck/anthropic-api-key`, `duck-dev/…` for debug builds), and the Google credentials (`google.rs`). |
| `proxy.rs` | `/anthropic/{*path}` on the hook server: token check, CORS for the app's origins, endpoint allow-list, budget check, key swap, streaming forward, usage tap. |
| `usage.rs` | The price table, the stream meter, and ledger rows. |
| `budget.rs` | Limits, month-to-date spend, and the cap rule (at the cap only Haiku with a purpose other than `thread` passes). `saved_usd`: this month's subscription-brain turns at their API price (`record_saved`, M3), never part of the spend. `youtube_units_today` (H3): today's free YouTube quota used, from `assistant_quota` (`record_quota`). |
| `threads.rs` | Threads, append-only messages and parked batches in `duck.db`; `delete` removes a thread with its messages, batches and config pin in one transaction. L4: `set_keep` (the pin housekeeping respects). |
| `routines.rs` | Routine records (L4): one JSON row each in `routines`, listed in the order made. |
| `timings.rs` | Turn timings (D3): one JSON row per turn in `turn_timings`, by start time; `assistant_timing_add` prunes rows past 90 days, `assistant_timings(since)`. |
| `gitlane.rs` | Duck's background git lanes for its data repo (L4). `push` queues `push_now` on the git queue behind the memory commits and waits: `git push --porcelain origin HEAD:refs/heads/<branch>` (checked by `refuse_force`), classified as `pushed`, `nothing`, `no_remote`, `no_repo`, `offline`, `auth`, `rejected`, `lock`, `detached` or `failed`. `status` (remote, branch, commits ahead of `origin`). `create` writes a README saying the repo is private, commits it, and runs `gh repo create <name> --private --source <ws> --remote origin --push`. `review_branch` lists a branch's files against its merge base and the memory bullets it drops whose fact isn't in what it adds. `housekeep(cutoff)` on the git queue: task folders dated before the cutoff keep only `brief.md`, `result.md` and `result.json` and get a line in `tasks/INDEX.md`; uncommitted `memory/` and `config/` files, `reminders.json` (H8), and the indexed tasks' results are committed; `git gc --auto`. Commands `assistant_backup_status`, `_push`, `_create`, `assistant_branch_review`, `assistant_housekeep`. |
| `summaries.rs` | The last summary per session (W3), JSON in `meta` under `assistant_summary:<instance>`. |
| `memory.rs` | Long-term memory (L1). The files: `memory/<topic>.md` (`decisions`, `preferences`, `people`, `goals`, `lessons`, `projects/<name>`; `journal/` is L2's), one bullet per entry, `- 2026-10-22 — fact. Why: … (src: thread:…, conf: high, tags: …)`; `parse_file` reads any bullet, with or without the date and the parenthesis. `write` (secrets refused by `secret_in`: key and token patterns, a password after `:`/`=` or in quotes, long random-looking strings; the same text already in the file isn't written again), `forget` (exact bullets), `restore` (an undo, over the expected text), `list`. The index: `ensure` rescans what changed (by size and time) in `memory/` and, read-only, the notes root, each marked dirty by a `notify` watcher (or rescanned on every search without one); `search` splits the query into `terms` (stop words and numbers dropped, a long word cut by a letter or two so inflections match), ORs them in FTS5 (trigram), and ranks by words matched, then rank; a note hit is labelled `note: <project> / <name>`. `matching` is the AND for `forget`. Git: `commit` queues `commit_now` on the git queue: `git init` on the first change, then a commit of just the files changed, as Duck, none when nothing changed. L2: `apply` makes a consolidation's `Apply` (removals, then additions through `write`, then the day's bullet in `journal/<YYYY-MM>.md`, `- 2026-10-21 — paragraph (src: tidy)`) and returns one edit per file from before the run to after it, plus what it skipped (a secret, too long, not a topic); `assistant_memory_apply` commits it once. `log_recall` and `recall_stats` keep and count `recall_log`. |
| `workspace.rs` | Duck's workspace (`prepare`, its `CLAUDE.md`, a `.gitignore` line for `data/`), task folders (`new_task`, `result`, both only under `tasks/`), the workers' registration (`register`: a settings file with the allow list in app data, and a `worker_sessions` row in the main DB) and `launch_args` for `pty_spawn`; the `assistant_tasks` records; the core memory (W4: `read_core`, and `write_core`, which refuses with "stale:" unless the file is still the text it was read as). |
| `headless.rs` | Headless workers (D4): a worker session as `claude -p` over stream-json both ways. Prompts and interrupts are messages, permission requests are answered as data (racing the `PermissionRequest` hook, the first answer winning); otherwise it is an ordinary session to the status engine, summaries, the trust watcher and the transcript view. |
| `subscription_brain.rs` | The subscription brain (M3): `brain_spawn` starts thread `t`'s `claude -p` (stream-json both ways, `--include-partial-messages`, `--model sonnet --effort medium` (D3: `opus`, and the mode's effort, for a mode that thinks there), `--tools ""`, `--strict-mcp-config` with only Duck's server and a per-process bearer token, `--permission-mode dontAsk --allowedTools mcp__duck`, `--setting-sources ""`, Duck's prompt by `--system-prompt-file`) in `<workspace>/brain`, with no `ANTHROPIC_*` or `WORKBENCH_INSTANCE_ID`, no CLAUDE.md, no auto-memory and no deferred tools. Session id = thread id, kept on disk, so a later spawn `--resume`s it. Emits `brain-event` (text deltas, `assistant` / `user` messages, `result`, init) and `brain-exited`; `rate_limit_event` goes to the usage meter (`statusline::ingest_rate_limit_info`), each `result` into the subscription ledger at its API price. `brain_send`, `brain_interrupt`, `brain_kill`, `brain_tool_result`; `kill_all` on exit. |
| `mcp_server.rs` | Duck's MCP server (M3) at `/duck/mcp` on the hook server, JSON-RPC by hand: `initialize`, `ping`, `tools/list` (the tools the brain was started with), `tools/call` (a `brain-tool-call` event to the webview, awaited up to 10 min). The bearer token picks the thread; anything else is 401, and a GET (the optional event stream) is 405. |
| `autopilot.rs` | Autopilot records (P1): one JSON row per session in `assistant_autopilots`, with its capped step log. |
| `replay.rs` | `scan(dir, days, max)`: the tool calls in the transcripts touched in the window, each with its outcome (`ran`, `rejected`, `denied`, `error`, `none`), the conversation's first prompt and the latest one before it, and the permission mode. Behind `assistant_replay_calls`, on a worker thread. |
| `trust.rs` | Rules, project modes, floor-off, the seeded flag, the kill switch (`meta` `assistant_trust_paused`), sessions' mandates (`meta` `assistant_mandate:<instance>`) and the decision log. `set_trust_paused` in `mod.rs` writes the flag, ticks the tray item (`attention::set_trust_check`) and emits `assistant-trust-paused`. |
| `mcp_host.rs` | Duck's host for stdio MCP servers from your Claude Code config (B2), on `rmcp`: `McpHost` (managed) starts a server on first use (`crate::mcp::mcp_list` over the home folder, its env to the child only, `CREATE_NO_WINDOW`, `cmd /c` only for a `.cmd`), `kill_tree`s it after 10 minutes idle or on exit. `mcp_host_tools(server, refresh)` (from `mcp_tool_cache` by a hash of the command line unless `refresh`), `mcp_host_call(server, tool, args, timeout)` (the `CallToolResult` as JSON), `mcp_host_servers` (names and command names only), `mcp_host_running`, `mcp_host_stop`, `firefox_start_profile(profile)` (`firefox.exe -P <it> --no-remote`, not waited on). |
| `mcp_client.rs` | `assistant_mcp_request(url, token_env, method, params)`: JSON-RPC to an MCP server over Streamable HTTP (X1). One session per URL (`initialize` + `notifications/initialized` on first use, `mcp-session-id` kept, a 404 retried once on a new session); JSON or SSE replies. In Rust because a local server sends no CORS headers, and so a bearer token is read from the environment variable `token_env` names and never reaches the webview. |
| `google.rs` | The morning routine's Google access: the installed-app OAuth flow (a loopback redirect, PKCE) for the user's own Desktop client and only `drive.readonly` + `drive.file`, so the token can't write to the original sheet. The refresh token is in Credential Manager (`duck/google-sheets-token`, `duck-dev/…` in debug), the client's secret, if any, in `duck/google-oauth-secret` (by `cmdkey`); access tokens stay in memory. `invalid_grant` forgets the token and fails with `google_expired: …`. Commands: `assistant_google_status`, `_connect(client_id)`, `_disconnect` (revokes). |
| `steam.rs` | H2: Steam on this PC. `parse` reads Valve's KeyValues (`.vdf`, `.acf`); `steam_root` (the registry's `SteamPath`), `libraries` (`libraryfolders.vdf`), `installed` (every `appmanifest_*.acf`, without the redistributables, the last played first). Commands: `assistant_steam_library`, `assistant_steam_store_search` (the store's search, no key), `assistant_steam_activity(appid?)` (the Web API with `duck/steam-api-key`, the account from `config/loginusers.vdf`; the key never reaches an error, `without_url`), `assistant_pc_open` (`may_open`: http(s), or `steam://rungameid|install|store/<digits>`; nothing else). |
| `youtube.rs` | H3: `assistant_youtube_search(query, kind)`: the YouTube Data API with `duck/youtube-api-key` (never in an error, `without_url`), `search.list` for ids (the Music category for `music`) then `videos.list` for plain titles, channels (" - Topic" dropped) and lengths. Records 101 units in `assistant_quota` per search; a used-up quota is said plainly. |
| `reminders.rs` | H8: `reminders.json` at the root of Duck's repo, `{"reminders": [...]}`. `read` (a file that doesn't parse, or a bad record, is a `problem`, never written over), `put(id, before, after, message)` (one record replaced, made or removed over what it was, else `stale:`; checked; fields it doesn't know kept; commits just the file through `memory::commit`). A `notify` watcher on the workspace folder emits `duck-reminders-changed`. Delivery bookkeeping in `meta` `reminder_seen:<id>`. H4: the record's `repeat` (daily, weekdays, weekly, monthly; needs a due) and `snoozedUntil` (a local time); timers in `meta` `duck_timer:<id>`; a push's one-use button token in `meta` `reminder_action:<token>` (a day; `issue_action`, `take_action`), and `act`, which the remote's `POST /api/reminders/action` calls and which emits `duck-reminder-action {id, action}`. Commands `assistant_reminders_read`, `_put`, `_watch`, `_seen`, `assistant_reminder_seen_set`, `assistant_timers`, `assistant_timer_set`, `assistant_reminder_push` (the push, with the token when it has buttons). |
| `media.rs` | H2: Windows' media sessions (`GlobalSystemMediaTransportControlsSessionManager`, the `Media_Control` feature), on a blocking thread in the MTA. `assistant_media_now_playing` (each app's title, artist, album, status, and which is current; `app_name` names a browser by its AppUserModelID) and `assistant_media_control(action)` (`target`: the session that plays, else the current one). |
| `sheets.rs` | Google Sheets. Reads: `assistant_sheet_search` (sheets by name), `assistant_sheet_read` (a tab's non-empty cells, shown and as formulas, 150 rows by 26 columns, and its tabs), `assistant_sheet_cells` (given cells, up to 20) and `assistant_sheet_export` (the cells, plus the tab as CSV, the file as xlsx and a JSON sidecar in `<workspace>/data/invoices/`). Only Google Sheets files. The draft: `assistant_sheet_draft` refuses a second draft of a sheet for a month while the first is in Drive, re-reads the original against what the card showed, refuses a formula cell (in the original and the copy), makes the drafts folder once, copies with Drive's `files.copy` and falls back to uploading the xlsx export as a new Sheet, records the file, then sets the cells (`USER_ENTERED`, plain values only) and reads them back. `assistant_sheet_drafts` lists a month's drafts still in Drive. |
| `skills.rs` | Duck's skills (S2): `skills/<name>/SKILL.md` in the workspace. `list` (cached; a `notify` watcher on `skills/` marks it stale, so an edit is read on the next request), each file's frontmatter fields (`crate::skills::frontmatter`, the skill manager's parser made general), body, text and problems (a folder name that isn't kebab-case, no frontmatter, a `name:` that isn't the folder's, no description, over 64 KB); `write` (over the text it was read as, else "stale:"; the caller commits). Commands `assistant_skills_list`, `assistant_skill_write`. |
| `config.rs` | Duck's prompt files (L3): `read` (`config/system.md` and `config/voice.md` only, with each one's seed from `meta` `config_seed:<file>`), `write` (over the text it was read as, else "stale:"; records a seed when given; the caller commits), `pin` / `pinned` (a thread's prompts as JSON under their hash; a pinned thread keeps its pin). Commands `assistant_config_read`, `_write`, `_pin`, `_pinned`. |
| `db.rs` | `duck.db` / `duck.dev.db` and its append-only migrations; `assistant_google_files` records every Drive file Duck made (the drafts folder, each draft with its source sheet and month). |

### The desktop surface: `src/panels/Assistant/`

| File | What it is |
|---|---|
| `duckState.ts` | The desktop's one subscription to the protocol, an external store shared by the button and the drawer: threads, the open thread, loaded messages, streaming text, turn states, locally queued messages, confirmations, spend. Actions (`sendMessage`, `stopTurn`, `answer`, `openThread`, …) only send protocol messages. Persists `assistantDrawer` prefs (width, open thread, interrupt). |
| `view.ts` | `toItems(messages)`: stored messages → display items (user text, reply text, a tool chip with its result attached (B1: a web search or fetch too, its result from the same reply, by `webResultText`; cited text gets numbered links and the reply a "Sources" line), edit chips for notes, the toolbar, the core memory and (H8) reminders (`reminderFiles`: the record as JSON), notices; thinking and system messages hidden). `sessionLink()` reads `#session/<id>` links. |
| `DuckButton.tsx` | The title-bar button ("D.U.C.K.", the icon beside it): toggles the drawer, the acronym tooltip, a confirmation-count badge, an amber/red tint past the soft limit/cap, ⏸ while trust is paused. |
| `TrustViews.tsx` | `TrustPanel` (kill switch, rules, project modes, the floor with a typed confirmation) and `DecisionsPanel` (the log with make-a-rule / always-ask, the rule from `suggestRule`; and the replay of the past week with its report). Opened from the settings popover; they take the thread's place. |
| `Drawer.tsx` | The drawer: header (thread list, new, memory, the trust pill that is the kill switch, settings, close), thread view (markdown replies, tool chips, queued bubbles), confirmation cards, spend line (its tooltip: today's cost and, H3, today's YouTube search units), composer (Enter / Shift+Enter / Esc, "think hard" = effort `high` for one message). A task card for a change to Duck (L3, `SelfChange`) adds its branch, the safety badge, and "open diff" / "ask for changes" (fills the composer, `fillComposer`) / "merge…". Always mounted and only hidden, so the thread and scroll survive closing. |
| `RemindersBadge.tsx` | H8: the reminders widget, a red dot with the open count ("!" for a broken file) in the duck's upper-left corner, or the chat's with the duck hidden; a click lists titles only (`widgetOrder`), Escape closes it; it pulses when one comes up (`remindersPulse`). From the `reminders` event. |
| `RoutinesSettings.tsx` | The "routines" settings tab (L4): where Duck's data is backed up (or a name field and "back up to a private GitHub repo…", which asks once more), "Delete threads idle for", and every routine with its schedule, next and last run, and run now / pause / resume / delete. |
| `DrawerSettings.tsx` | Queue-or-interrupt, and "start at login, minimized to the tray" (`@tauri-apps/plugin-autostart`; disabled in dev builds); the workers' settings, with "Edit core.md" (W4) and which brain Duck answers on (M3). |
| `SkillsSettings.tsx` | The "skills" settings tab (S2), Duck's capabilities in one place: each skill and mode with its description, its problems, on/off (`disabledSkills`) and "edit" (the file in the "Duck" project's editor); the MCP servers (X1, moved here from the sessions tab). |
| `openCore.ts` | `openCoreMemory(workspace)` (W4): prepares the workspace, makes `core.md` with its empty sections if missing, and opens it in the "Duck" project's editor. `openDuckFile(workspace, path)` (S2) opens any file of the workspace there. |
| `MemoryView.tsx` | The Memory view (L1): the long-term memory by topic, a search over it and the notes, per entry "edit" (the file in the "Duck" project's editor) and "forget", and "don't remember this conversation" for the open thread (a `thread.memory` request, which posts a `memoryOff` notice). L2: the last tidy with what it changed, "tidy now" (`tidyMemory` from `index.ts`), and the past 14 days' recall numbers (`assistant_recall_stats`). |
| `TasksView.tsx` | The Tasks view (D2): worker tasks newest first, with headline, cost for an API worker, and ways on (open `result.md`, save to notes, open the console, go to the thread). |
| `OverviewView.tsx` | Every thread at a glance (A5): what each does, its news since you looked, its autopilots and tasks; no model call. |
| `AnnounceSettings.tsx` / `SpeechSettings.tsx` / `VoiceSettings.tsx` | Settings tabs for announcements (V5), spoken replies (V2: engine, voices, rate, Chirp fallback, downloads) and voice input (V1, V4: the key, microphone, speech-to-text, conversation mode, talking over Duck; V6: the wake word's switch, sensitivity slider, when it stays deaf, and what it's doing, `wakeLine`). |
| `GoogleSettings.tsx` | The "google auth" tab: the OAuth client id, connect/disconnect and the `cmdkey` hint for the client secret; and whether the Chirp speech key is stored, with this month's use (which voice to use stays in the voice tab). |
| `voiceState.ts` | Push-to-talk (V1) and conversation mode (V4, the key's default): voice prefs, the HUD, and where a transcript goes (names fixed, then sent to the open thread as `voice`, or into the composer). V6: the wake word's prefs (`wake`, `wakeSensitivity`, `wakeFullScreen`, `wakeBattery`, `wakeKeepClips`), its `wake-state` (the ear on `DuckButton.tsx`), and the tray's `wake-toggle`. |
| `replySpeech.ts` | Spoken replies on the desktop (V2): which replies are spoken, fed to `src-tauri/src/voice/tts.rs` a sentence at a time as they stream; a stock acknowledgement when nothing is said in time. |
| `VoiceOverlay.tsx` | The listening sign, the `voice-overlay` window's page. |
| `DuckAvatar.tsx` / `duckCanvas.ts` / `duck3d.ts` | The ASCII duck: a raymarched 3D rubber duck in characters (`duck3d.ts`, pure), its frame loop (`duckCanvas.ts`, shared with the phone), and the drawer's component; the beak follows the speech level. |
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
- `src-tauri/src/voice/` (track V): speech to text (Parakeet over ONNX Runtime, Silero
  VAD), the global push-to-talk key and capture, conversation mode with echo
  cancellation (`aec.rs`, `conversation.rs`, `turn.rs`), text to speech (`tts.rs`:
  Kokoro, Silero, Chirp), presence for announcements, screen capture and the listening
  overlay window. Models download on first use. V7: a phone's conversation runs through
  the same canceller (see "The phone's echo" below), and `phone_record.rs` saves its
  runs for measuring that echo. V6: the wake word (`wake.rs`, on the keyword spotter
  `kws.rs`; see "Hey Duck" below).
- `src-tauri/src/remote/assistant.rs` (R1): the remote server's `/api/assistant`
  WebSocket carrying the Duck Protocol, `/api/assistant/audio` (a phone's speech,
  transcribed with V1's model) and `/api/assistant/tts/{id}` (a sentence the desktop
  made for the phone). The phone's PWA (R2) is `src/pwa/`, built into
  `src-tauri/src/remote/pwa/` (`duck.ts`; conversation mode's mic in `converse.ts`, Duck's
  voice in `duckSpeech.ts` and `speechQueue.ts`). The `Phone` surface in `assistant.rs`
  is a phone's conversation run: its socket, what it's playing and saying
  (`conv.playing`, `conv.said`), its echo reference and its recording. R3 made the PWA
  an app: see "The phone as an app" below.
- The dock's root has `isolation: isolate`, so dockview's layers (floating groups at
  z-index 999) stay under the drawer (z-index 60) while modals (100) stay above it.
- Start at login: `tauri-plugin-autostart` (pinned `~2.5.1`; later versions need Tauri
  2.12) registers the app with `--minimized`; `window::build_main` then builds the main
  window hidden, and a left click on the tray icon shows it (`window::show_main`).

### `duck.db` tables

- `assistant_usage`: one row per API call.
- `assistant_subscription_usage (ts, model, api_usd)`: one row per subscription-brain turn
  (M3), priced as the API would have; the spend line's "saved".
- `turn_timings (at, data)`: one row per turn you started (D3), the clock's JSON; 90 days.
- `mcp_tool_cache (key, tools, at)`: a hosted MCP server's tool list (B2), by a hash of
  its command line.
- `meta`: budget limits.
- `assistant_threads (id, title, mode, created, updated, keep)`; `keep` (L4) is the thread
  list's pin. `mode` is S1's `assistant`, `chat` or `duck`; S1's migration made every
  earlier thread (stored as `chat`, the column's default) `assistant`.
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
- `assistant_autopilots`: one autopilot record per session (P1).
- `meta` `assistant_summary:<instance>`: a session's last summary (W3).
- `meta` `reminder_seen:<id>`: a timed reminder announced, for which time (H8).
- `meta` `duck_timer:<id>`: a running timer, `{label, ends, length, threadId}` (H4).
- `meta` `reminder_action:<token>`: a push's Done and Snooze, `{id, exp}` (H4).
- A thread's compactions (A6) are `notice` rows in `assistant_messages`, so there is no
  table for them.
- The core memory (W4) isn't in `duck.db`: it's `memory/core.md` in Duck's workspace, a
  file you edit, and each thread keeps the copy it started with in its first system
  message.
- Long-term memory (L1) is files too, `memory/*.md` in the workspace; `duck.db` only
  indexes them: `memory_fts (body, path, line, entry JSON)` and `notes_fts (body, path,
  line, label)`, both FTS5 with the trigram tokenizer, and `memory_index_files (kind,
  path, mtime, size)`, which says what was read. `meta` `memory_index_root:<kind>` is the
  folder indexed; a different one rebuilds that table. A thread you asked Duck not to
  remember is a `memoryOff` notice in it.
- Step L2: `recall_log (at, thread_id, query, candidates, shown, used, self_recall, hits
  JSON)`, one row per automatic recall (not in a `memoryOff` thread), pruned after 90
  days. The consolidation's state is in `meta` under `memory_state:consolidation` (the
  last run: its local date, the window's end, the report), `memory_state:questions`
  (contradictions, asked or not) and `memory_state:skill_offers` (S2 marks one `offered`
  when it's handed out). The journal is a file,
  `memory/journal/<YYYY-MM>.md`, indexed like the rest.
- Step L3: `config_snapshots (hash, json)`, one per distinct set of prompts a thread
  started with, and `config_pins (thread_id, hash)`; `meta` `config_seed:<file>` (the
  hash of the default last written into a config file) and `memory_state:improve_offers`
  (changes to Duck the tidy may suggest, with when each was offered). The prompt files
  themselves are `config/*.md` in the workspace, committed like memory.
- Step L4: `routines (id, data JSON, updated_at)`, one record per routine with its
  schedule, action, thread, next and last run, and its job's memo (the backup's
  failing-since and what it told you; the housekeeping run's task, deleted threads and
  a branch waiting for your OK). `tasks/INDEX.md` is a file in the workspace.

The main `workbench.db` holds `worker_sessions (instance_id, effort, permission_mode,
strict_mcp, add_dir)`, which `pty_spawn` reads at each launch.

## The engine loop

One turn on a thread (`engine.ts`):

1. **Append the user message.** If the wanted effort differs from the one in force, also
   append a mid-conversation system message `{content: [], output_config: {effort}}`.
   This keeps the cache; a top-level effort change would invalidate it. The default is
   `medium`.
2. **Stream a reply** with `client.beta.messages.stream`:
   - Request settings: the model and effort from `routing.ts` (Sonnet 5.5 with
     `fallbacks: "default"`, or Haiku past the soft limit), adaptive thinking; a
     `routing` event tells the surfaces. The system prompt and the tools are the
     thread's mode's (S1).
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

**Compaction** (step A6, after the loop, still inside the turn): when the turn's
last request was past the `compactAt` setting (input tokens, cached included; 0 is
off), or the thread was asked to compact (`thread.compact`, or the `compact_thread`
tool, which waits for its reply to end), `compactionCut` picks where to cut: the
start of one of the last 2 turns that fit 30% of the threshold, else the end. The
thread's own model writes a summary over the thread up to the cut plus
`COMPACT_REQUEST` (same tools and system: the cache holds; purpose `compact`). It's
stored as a `compacted` notice `{summary, through}`. `toApiMessages` then drops
every message up to `through` and puts the summary (`compactedText`, in
`<thread_summary>`) in front of the first kept one. The stored messages stay; the
drawer draws the line at the cut. A parked turn compacts once answered; a stop
drops it; a failure is an error notice.

**Core memory** (step W4): a new thread's first message reads `core.md` (`deps.core`)
and, when it has facts, puts `coreText` first in the system message that goes with that
message (with the voice note, the brief, the effort). The system prompt stays the same,
and the thread's prefix keeps that copy for its life: a fact saved mid-thread reaches
the threads started after it, and this one through the tool's result. A read that fails
leaves the block out. After a compaction, `toApiMessages` puts the dropped block back
in front of the summary (`droppedCore`). In the drawer, settings → "Edit core.md" opens
the file in the workspace's "Duck" project editor (`openCore.ts`), making it first.

**Long-term memory** (step L1): each of your messages (not an event) is searched before
its request (`recallFor`), and what's worth recalling goes in a system message of its
own after the others in the opening, with `clear_at: "next_user_message"` (beta
`mid-conversation-system-clear-at-2026-08-21`). The model sees it for this reply; it
stays in the history and is sent back as stored, which the API renders as nothing once
a later user message exists, so the prefix never changes and it costs nothing after
its turn. A correction adds the line asking for a `lessons` entry. `toApiMessages`
keeps a system message followed by another system message (it looks past them to the
next message). The subscription brain gets the note in its `<duck_context>`, like the
other notes. Every write is a commit in the workspace's repo; core memory writes too
(`assistant_core_write` takes the message).

**Consolidation** (step L2): `index.ts` makes the consolidator over the thread store,
the task list and the memory commands, and gives the memory host its `question` and
`tidy`. The nightly run is one Haiku call and one commit. A contradiction isn't applied:
it becomes the `<memory_question>` in the recall note of your next message, in any
thread, once, and Duck fixes the memory with your answer through `forget` (its card)
and `remember`. After each turn with a recall, `logRecall` writes the row: what was
shown, what the reply seems to have used, and whether Duck searched itself.

**Prompts as data** (step L3): every request takes its system prompt from the thread's
pin (`promptsFor` → `deps.config.forThread`), and a spoken message's note from the same
pin; the compaction request and the subscription brain's spawn too. The built-in
prompts stand in when there's no config or it can't be read. A thread is pinned at its
first turn after L3, so an old thread keeps the built-in text it has been caching.

**The subscription brain** (step M3): each turn asks `brain/policy.ts` which brain
answers. On `subscription`, `brainLoop` replaces `loop`: the opening is stored as
usual, the thread's brain process starts if it isn't running (`BrainHost.spawn`, with
`mcpTools(registry.apiTools)`; at most 3 run, the one idle longest is stopped for a
fourth, and each stops after 30 minutes idle), and `brainTurn`'s text goes to it.
`brainRun` hears it until its `result`: text deltas are emitted, replies stored per
message id (`storedBlocks`, source `brain`), tool results stored as the brain's loop
adds them, and a call left without a result gets a "stopped" one, so the thread stays
a valid history for the API. A stop interrupts it and keeps what was said; a process
that ends mid-turn is an error notice, and the next message spawns it again (resuming
its session). Its tool calls come back as `brain-tool-call` (`brainCall`): `judge`
(the same validation, `prepare` and gate as `runBatch`) then `execute`; an `ask`
parks that one call as its own batch (`brain: true`), and the brain hears `ASKED` at
once. Confirming one runs it in `resumeBrain` and sends the outcome to the thread as a
Workbench event, which starts the brain's next turn. The card: a turn on the other
brain than the thread's last posts a `budget` notice (`switchCard`); back on the API
on Haiku, it says so instead of `HAIKU_CARD`. An API request that fails with "credit
balance is too low" (before any text) returns `"credits"` from `loop`; the engine
remembers it for the month and, if the policy allows, carries the same turn on to the
brain (`creditsLoop`), your message kept. `effort` is `medium` for the brain's whole
process; the drawer's spend line shows a "subscription" chip and the month's "saved".

**Deleting a thread** (`deleteThread`): refused while a reply runs (stop it first). A
parked thread is deleted with its batch, so its confirmations vanish; its queue is
dropped. Every surface gets `threadDeleted`. Spend rows are kept.

**Other rules:**
- **Queueing:** a message sent while a turn runs, or while one is parked, waits in a
  per-thread queue and runs next. It is never dropped.
- **History is append-only.** `toApiMessages` only filters what is sent: it drops notices
  (a `compacted` one replaces what it covers with its summary),
  and drops a system message that a failed turn left in front of a user message (the API
  needs a system message to be last or followed by an assistant turn).
- **Thread titles:** the first message of a new thread is named by the `title` primitive
  (Haiku, thinking off), fire and forget.

## Modes (step S1)

A thread has one mode for its life, stored in `assistant_threads.mode`, so its prompt and
tools never change midway and its cached prefix holds.

- **What a mode sets** (`modes.ts`): the system prompt (the assistant's is the pinned
  `config/system.md`; chat's and duck's are built in), the tools (`registry.toolsFor`;
  the assistant has all of them), the effort it starts at (`pickEffort`), and conversation
  mode's pauses at least (`patienceFor`).
- **The engine** reads the thread's mode for every request, compaction and subscription
  brain spawn. A call to a tool outside the mode fails at once with a pointer to
  `switch_mode`.
- **A new thread** starts in the mode sent with its first message (`send.mode`, from the
  drawer's picker); a split (`start_thread`) is the assistant's.
- **`switch_mode(mode, words, brief)`** is a move (A7) into a new thread of that mode:
  the user's words go there as their message, and the brief as a system note.
- **The voice**: while conversation mode runs, `voiceState.ts` sends the open thread's
  pauses (`voice_conversation_patience` → `Cmd::Patience` → `Machine::set_policy`) when
  the run starts listening and when you move threads. A phone keeps its own setting.
- **The drawer**: a mode picker on a new thread (`DuckState.newMode`, `setNewMode`, the
  `skills` event's `modes`) and a badge on each thread that isn't the assistant's
  (`ModeBadge`).
- **Thinking on the subscription** (step D3, an experiment): a mode can be set to think
  on M3's subscription brain (`thinksOnSession`): the built-in chat and duck by the
  `sessionModes` setting, yours by `backend: session` in the skill. Its threads' turns
  go there while the subscription is under its thresholds, on `sessionModel` and the
  mode's effort. `timings.ts` times every turn, so the drawer's "how they compare"
  can set both brains side by side.

## Skills (step S2)

A skill is `skills/<name>/SKILL.md` in Duck's workspace: frontmatter, then instructions.
You write one by hand, or Duck drafts it (`draft_skill`, a card with the file's diff).

- **Reading**: `skills.rs` lists them (cached, watched); `skills.ts` says what they mean.
  The engine reads the list for every request (`skillsOf`), so a new or edited skill
  works from the next request, with no restart.
- **The `<skills>` block**: a second system block after the system prompt, with its own
  1-hour breakpoint, so a changed skill rewrites the cache only from there. It lists the
  usable skills (on, no problems) by name and the modes they add. A mode without
  `load_skill` (one of yours with its own `tools:`) gets no block.
- **`load_skill`** returns the body. A skill's `tools:` narrows the rest of that turn
  (`narrowed`, cleared by the next message, kept through a confirmation): a call outside
  them fails at once with the reason. It can't add a tool the mode doesn't have.
- **`mode:`**: the skill is a mode instead, registered with `setUserModes` when the list
  is read (and before a new thread in it is made). Its prompt is the body inside the
  basics every mode has and the safety rules. A thread whose mode's skill is gone or off
  runs as the assistant (its badge says so). Editing the file changes the threads in it
  from their next request (unlike the assistant's pinned config).
- **Routines**: an action `{kind: "skill", skill}` tells its thread to run the skill.
- **Offers**: the nightly tidy's `skill_offers` (L2) seen three times or more are handed
  out one a week at most, in the recall note (`<skill_suggestion>`), never beside a
  change to Duck suggested the same turn.
- **The surfaces**: a `skills` event (on `sync` and after every change) with the skills
  and every mode; the skills settings tab turns them on or off through `settings.set`.

## The web (step B1)

Duck looks things up itself: the API's server tools `web_search` and `web_fetch`
(`tools/web.ts`), in the assistant's and the chat's tool lists (not the rubber duck's).

- **The server runs them inside the reply.** They have no `run` and never reach the
  gate: they only read, and a fetch can only open a URL already in the conversation, so
  a page can't make Duck send anything out. A reply that searches may stop with
  `pause_turn`, which the loop already resends. The reply is stored whole (the
  `server_tool_use` and result blocks with it), so the history goes back as it came.
- **What's quick and what's a worker**: the system prompt's routing rules. One fact, a
  release note, what one page says: Duck, a few searches at most, saying where it came
  from. Comparing sources, many pages, a report: `run_task`.
- **Cost**: the proxy's meter already counts `server_tool_use.web_search_requests` into
  `assistant_usage.searches` and prices them ($0.01 each); a fetch costs only its tokens,
  and `max_content_tokens` keeps a page from filling the thread.
- **The surfaces**: while a search runs the thread shows `tool`; the reply's chips and
  links come from `view.ts`, so the phone shows the same.
- **Not covered**: a skill's `tools:` doesn't narrow the server tools (they'd have to leave
  the request's tool list, which would break the cache), and the subscription brain has
  only its own tools (`mcpTools` sends those with an input schema).

## Your Firefox (step B2)

Duck acts in your real Firefox through the bridge Claude Code uses
(`mcp-bridge-for-firefox`), started as Duck's own process (`mcp_host.rs`), for quick
things from its thread; browser chores still go to a worker.

- **Opt-in:** Settings → skills → "From your Claude Code config" lists the stdio
  servers there; one turned on (`mcpHost`) lends its tools, deferred, as
  `<server>__*`. Its list is cached in `duck.db`, so nothing starts until a call.
- **Profiles:** each thread works in the agent profile (`claude-agent`, which Duck
  opens if it's closed) unless `use_personal_browser` or the login card moved it to
  yours. The model never selects a browser itself; the host does, before every call.
- **What asks:** the tiers in `tools/mcpHost.ts`. Clicking or submitting what looks
  like log in, pay or send trips the floor's `browser-account` entry; a password is
  never typed (`browser_login` hands it to you on a three-choice card).
- **Cards with choices:** a tool's `choices` show as buttons in place of "allow"; the
  one picked reaches `run` as `prepared.choice` (`engine.ts`'s `chosen`).
- **The subscription brain** gets the hosted tools too (`mcpTools` lists the registry
  as it is when the brain starts), so one turned on mid-conversation reaches it at its
  next start.

## Questions, plans and promotion (step T3)

T2 answers permission prompts; T3 handles a session's other two kinds of prompt, and
turns approvals Duck keeps repeating into fewer prompts.

- **Who handles which question.** An autopilot run settles its own (`autopilot.ts`),
  Duck's workers ask Duck (`tasks.ts`). Every other session's question and plan goes to
  `trust/delegate.ts`, if the session has a mandate.
- **Delegated sessions.** `create_session` takes `delegatedBy`, the user's words handing
  the session over, checked against their latest message (`quotes`). It's stored as
  `delegated` on the mandate (duck.db `meta`). There is no other way to set it.
- **Questions.**
  - In a delegated session, Sonnet's pick is answered (`answerChoice`). The row in the
    decision log (`delegated`, its reason), the line under the card and the notice in
    the starting thread are the rationale.
  - In any other session, the pick is a suggestion on the choice card.
  - A serious question, or one the card can't answer (several questions,
    multi-select), is always yours.
- **Plans.** The review always shows on the plan's card. `planApproval: "approve"` makes
  a passing plan approved with "Yes, manually approve edits", read off the screen by its
  label, so its edits still reach the permission prompts.
- **Trust.** Delegated answers and approvals happen only when trust isn't paused, the
  session's guard isn't tripped and the project is `live`. In `shadow` they're logged
  as what Duck would do, and in `off` Duck only advises.
- **Alerts.** The needs-you of a prompt Duck may answer waits for it (`hold`, through the
  trust watcher's `holdOther`). One Duck only advises on is told at once.
- **Promotion.**
  - The decisions view's "suggested" list comes from `createPromoter` (protocol
    `promotions`).
  - "add to Claude Code's allow list…" asks for a preview (`trust.promotion.preview`):
    `.claude/settings.local.json` before and after, as a diff. Writing it
    (`trust.promote`) goes over the text the preview read: the Rust command
    `claude_local_settings_write` refuses a stale write, and makes the file and its
    folder when missing.
  - "make it a Duck rule" adds a project allow rule.
  - Either action, or "dismiss", settles the offer (`settledPromotions`).
  - Only the project's local settings are written, never Claude Code's user-level ones.

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
4. Add it to `TOOLS` in `toolset.ts`. A chat or duck thread offers it only if its mode
   lists it (`modes.ts`); a skill can name it in `tools:`.

   Adding or changing a tool changes the cached prefix, so the next request in every
   thread re-writes the cache once.

## Tools that run elsewhere (step H1)

A tool's `host` says where it runs. `workbench` (the default) and `any` run in the
engine. A `pc` or `phone` tool is declared in the engine without `run`: its schema,
tier and `trust` stay here, so the gate decides on the engine's facts, and its call
goes to whichever host offers it (`hosts.ts`).

- **The messages:** a host says `hello {host, tools, version}`; the engine sends
  `device.call {id, tool, input}` and gets `device.result {id, ok, output}`; a stop or
  the tool's timeout sends `device.cancel {id}`. A host refuses a tool it didn't
  announce, and the engine ignores an announced tool it doesn't have for that host.
- **The cache:** host tools are always deferred, and the registry never changes with
  what's connected, so the request's tool list is the same with or without a host.
- **Transports:** the desktop's `pc` tools are served in process (`connectLocal` in
  `index.ts`, with H2's `pcHandlers`); the phone connects over its `/api/assistant`
  socket (`remoteBridge.ts`), which takes only `phone` as a host.
- **The PC's tools (H2):** Steam (`steam.rs`), the media sessions (`media.rs`) and
  `open_on_pc`, in `tools/pc.ts`. `weather` is `any`: it only needs the internet.
- **Music and video (H3):** `tools/media.ts` runs in the engine and plays by calling
  a host's own tool (`open_on_pc`, or `open_on_phone`, declared now and served by the
  phone from H5) through `ctx.hosts`. Where it plays is the device named, else where
  the user asked from (`ctx.surface`, `surfaceOf` in `engine.ts`).
- **Adding one:** `defineTool({…, host: "phone"})` with no `run` in `TOOLS`, and the
  handler on the host (`serveHost`).

## Reminders (step H8)

`reminders.json` at the root of Duck's repo holds them, one commit per change
(`reminders.rs`). The file is what you asked Duck to remember about your intentions,
so it lives with the memory: versioned, backed up, and moved with the repo. Whether a
timed one was announced is bookkeeping, in `duck.db` `meta`.

- **Writes:** every write is one record over what the writer saw (`put(id, before,
  after)`), so a hand edit or the phone between Duck's read and write makes it
  `stale:`. The tools then read again and redo it once; a chip's undo is refused.
- **They come up** (`reminders.ts`):
  - A project's, on each new session there: in `create_session`'s (or a code
    `run_task`'s) result, or, for one you start (`onSessionYouStarted`), one notice
    line in the thread the drawer shows.
  - General ones, as a turn-scoped system note (`clear_at`) on your first message
    in a new thread or after a quiet spell.
  - Timed ones once due, through the announcer (`report`), with a notice; late
    when they came due while the app was closed.
  - A reminder with a time comes up the first two ways only once it's due.
- **Every channel at once** (H4, `index.ts`): an announced reminder is a notice, the
  announcer's line (spoken with Speak on), the widget's pulse and a Web Push to the
  phones (`assistant_reminder_push`), with Done and Snooze buttons. The service worker
  (`sw.js`) can't sign in, so the push carries a one-use token, good for a day, that
  the buttons post to `POST /api/reminders/action`; Rust emits
  `duck-reminder-action`, and `index.ts` makes the same change the tools would
  (`change` with `closing` or `snoozing`, 10 minutes), with its chip in the thread.
- **Repeats** (H4) keep one record, whose `due` is the occurrence not yet done: done
  moves it on; left undone, each later occurrence is still announced, without a
  write. **Snooze** sets `snoozedUntil`, when it comes up instead; a new due or done
  clears it.
- **Timers** (H4) are `duck.db` rows, never the file: the clock rings each once and
  drops it, late when it ran out while the app was closed. They aren't in the widget.
- **The widget** follows the `reminders` event (on `sync` and every change; `pulse`
  when one comes up).

## Changing Duck itself (step L3)

Cheapest first, and always yours to approve:

1. **What Duck says or how it routes** is `config/system.md` (or `voice.md`). Duck reads
   it with `improve_duck` (scope `config`), drafts the smallest edits, and
   `propose_config_change` shows you the diff on a card (the floor: no rule allows it).
   Approved, it's written and committed, and threads started after it run on it. You can
   also edit the files yourself; one that drops the safety rules is ignored.
2. **A new tool or behavior** is code: `improve_duck` (scope `code`) starts a serious-tier
   worker in a worktree of the Workbench repo (`agent/<slug>`, the existing worktree
   path), briefed by `improveBrief`. When it finishes, its card in the thread shows the
   branch's files, a red "touches the safety layer" badge when `safetyFiles` finds one,
   and "open diff" (the Diff/Review panel), "ask for changes" (into the message box, for
   `task_followup`) and "merge…" (a message to Duck, which calls `merge_duck_change`).
3. **The merge** is on the floor: one card, two when the safety layer is touched. It
   merges into the repo's current branch and removes the worktree, as the rail does.
4. **Activation**: nothing hot-patches. `rebuild_duck` runs a dev build beside the app or a
   release build to restart into; threads, memory and tasks are in `duck.db` and the
   workspace, so they survive.
5. **Suggestions**: the nightly tidy may find a pattern (the same correction twice, a
   tool failing the same way); one a week at most rides in the recall note as a
   `<duck_suggestion>`, and Duck asks before starting anything.
6. **The monthly docs clean-up** (L4's built-in `docs` routine) is the same path: a
   `self` code task that brings this file and the plan's As-built notes in line with the
   code, reviewed and merged by you.

## Routines, backup and housekeeping (step L4)

- `index.ts` makes the routines and `housekeeping.ts` before the engine (their tools
  need them) and ticks them every minute, the first time 30 s after start, so a routine
  missed while the app was closed runs then, once.
- Duck's data repo is the workspace. All its git work is on the shared git queue
  (`gitqueue`), so a push waits behind the memory commits and nothing blocks a reply.
  The backup pushes hourly when there's something to push, and after each nightly tidy
  (`memory.tidy` and the tidy's tick call `runNow`).
- What needs judgment goes to a `quiet` worker in a worktree of the data repo (a code
  task in the "Duck" project). Duck reads its branch (`port.worktreeChanges`,
  `assistant_branch_review`) and merges it (`port.mergeWorktree`). You hear about it
  when it's blocked, or when its branch drops memory you'd want to see first.
- Deleting idle threads goes through `engine.deleteThread`, like `delete_thread`. A
  thread is never deleted while it's kept (●), open on a surface (`thread.view` within
  12 hours), running or parked on a card, watching a session, reported to by a task not
  closed, an autopilot or a routine, or talked in since the nightly tidy last read.

## The phone's echo (step V7)

Conversation mode on a phone runs on the desktop (`voice/conversation.rs`, fed the
phone's mic over Duck's socket). Before V7 the phone's echo was left to its browser, and
Duck cut itself off hearing its own voice. Now:

1. **The phone says what it starts playing**: each sentence, as it starts, goes up as
   `conv.said` (its words, and the desktop voice's audio id). Conversation mode on the
   phone always speaks in the desktop's voice, so there's audio for every sentence.
2. **The reference** (`aec::Feed`): the `Phone` surface places that sentence's audio
   (the TTS render, at 16 kHz) at the sample of the phone's stream it had received when
   `conv.said` came, so it's in the stream's own clock. The echo comes some 100-500 ms
   later (the phone's audio buffers, the page's framer holding quiet frames, the room).
   The feed measures that lag every 2 s of playback (the reference's and the mic's
   loudness per 10 ms, correlated over 0-0.8 s, used when the correlation is ≥ 0.5) and
   plays the reference 60 ms ahead of its echo, inside AEC3's window. A cut or playing
   off truncates what's placed.
3. **The canceller and the gate** (`aec::Canceller::for_feed`, `aec::Gate`): as on the
   desktop's speakers. The run's `Surface::reference` hands the feed over; the run then
   cancels from its start.
4. **The self-voice check** runs wherever Duck's voice can echo: speakers and phones.
5. **Without a reference** (a sentence in the phone's own voice: the feed is `unheard`),
   a barge-in must be words of yours (`BargeCheck`): at 9 frames of speech, then every
   8, the last 1.2 s is transcribed and cuts only when its words aren't mostly what Duck
   said in the last 10 s.
6. **The echo path** (the phone's settings): Duck's voice plays from its own audio
   context (`separate`, as before V7), from the mic's (`shared`), or through an `<audio>`
   element (`element`). It's for measuring which one the browser's own echo
   cancellation helps with; the desktop's canceller doesn't depend on it.

**Measuring it**: the voice setting "Save the phone's conversation audio"
(`voice.recordPhone`, `VoiceConfig.record_phone`) writes each phone run to
`~/repos/Duck/voice-eval/recordings/phone/<when>/` (`phone_record.rs`: the stream, the
sentences played, every event at its sample). `tools/voice-eval/score_phone.py` scores
them chain by chain, and the ignored test `barge_in_on_a_phone_recording` replays one
through the Rust chain.

## "Hey Duck" (step V6)

An experiment, off by default: with it on, the PC's microphone stays open and "Hey Duck"
/ «Эй, Дак» starts a request without the key.

- **The spotter** (`voice/kws.rs`): sherpa-onnx's keyword spotter ported to our ONNX
  Runtime, on its `kws-zipformer-zh-en-3M-2025-12-20` model (phones as tokens, so the
  phrases are given as their sounds, `KEYWORDS`). Kaldi's filterbank, the streaming
  zipformer (its cached states found by name: every input but `x`, fed back from
  `new_<input>`), and sherpa's keyword beam search over an Aho-Corasick graph. The
  model downloads on first use (`assets::fetch_kws`: sherpa's `.tar.bz2`, four files
  kept).
- **The ear** (`voice/wake.rs`, `Ear`): Silero VAD on every 32 ms frame; speech wakes the
  spotter, fed from half a second before it; a second of silence puts it back to sleep.
  A hit records from just before the phrase to 0.8 s of silence (`Heard::Clip`).
- **The verdict** (`confirm`): V1's engine transcribes the clip. The phrase near the
  start (exact spellings, the ones Parakeet writes included: "Hey Doc", «Эй, Даг»)
  with words after it sends those words as a transcript (`voice-transcript`, like
  push-to-talk); the phrase alone chimes, then starts conversation mode, or for the
  "one message" key a dictation that ends at a pause (`Ear::follow`). No phrase:
  logged, nothing sent.
- **Deaf** (`Hold`): while Duck speaks; with the microphone let go while conversation
  mode or a dictation has it (they take it at once), while another app uses it
  (`another_app_on_mic`: Windows' privacy store, this app skipped), a full-screen app is
  in front, or on battery.
- **The trigger log**: `<voice-eval data>/wake/triggers.jsonl` (when, the keyword, the
  score, the outcome; never the words), false triggers' audio beside it with the
  setting.
- **Measuring**: `wake_bench` (an ignored test) runs the ear over clips and long
  recordings; `kws_matches_sherpa` checks the port against sherpa-onnx's own hits.
- **The tray**: "Listen for "Hey Duck"" (`attention.rs`, `set_wake_check`); a click asks
  the webview to flip the setting (`wake-toggle`).

## The phone as an app (step R3)

The PWA installs on Android as an app (a WebAPK, from the https Funnel address), and
Duck is one tap from its icon.

- **Shortcuts** (the manifest's `shortcuts`, in `src-tauri/src/remote/pwa/`, with their
  icons): "Talk to Duck" (`/?duck=talk`), "Ask Duck" (`chat`), "New task" (`task`),
  "What needs me?" (`status`). `launch.ts` reads the query once (`takeLaunch`), and
  `duck.ts`'s `launchDuck` opens Duck for it:
  - talk: a big tap-to-talk button (the `tap` panel), since the mic needs a tap; it
    starts conversation mode;
  - chat: the composer; task: a new thread with "New task: " in the composer;
  - status: asks "What needs me right now?" in the open thread once the threads are in.
- **Sharing** (the manifest's `share_target`, POST multipart to `/share`): a navigation
  can't carry the token, so the service worker (`sw.js`, `takeShare`) takes the post,
  keeps title, text and link in its own `wb-share` cache, and sends the page to
  `/?duck=share`. The page opens a new thread with the share above the composer; one tap
  sends it with "summarize", "make a task of it" or "remember it", or with what you
  type. The message wraps it in `<shared>`, which the safety rules call data. Text and
  links only: files wait for G1. A share the worker missed lands on the server's
  `/share`, which sends the page to say so.
- **Start view and install**: Duck's settings on the phone have "the app opens on:
  dashboard / Duck" (`Prefs.openOn`) and "on the home screen" (how to install, the
  browser's install prompt when it offers one). Not installed, the chat shows a
  dismissible line about it.
- **Device keys** (`deviceKey.ts`, `net.ts`, `remote/auth.rs`, `remote/mod.rs`):
  - At pairing over https the page makes a P-256 key pair (private half not
    extractable, kept in IndexedDB) and sends the public half with the code
    (`remote_devices.public_key`).
  - Such a device's token opens nothing by itself: `checkAccess` gets a challenge
    (`GET /api/auth/challenge`), signs it, and trades token and signature for a session
    (`POST /api/auth/session`). The session, in the page's memory and the server's
    only, is the credential from then on. It ends after 4 hours unused, a day at most,
    a desktop restart, or a revoke. A refused session is renewed the same way (the
    sockets' reconnect asks, `api` retries once).
  - Paired over plain http (no WebCrypto), a device has no key and uses its token as
    before. The Remote Access menu says which devices are key-bound.
- **Pushes** were already deep links: a push names its thread, and tapping it opens Duck
  there (`#duck=<thread>`, or `open-duck` to an open page).

## The phone's app (steps R4, H5)

Duck's Android app, `duck-android/`: a Tauri 2 app whose webview opens the desktop's
own phone page, with a Kotlin plugin for what a page can't do. Sideloaded; built with
`node ../node_modules/@tauri-apps/cli/tauri.js android build` from `duck-android/` (the
CLI's `beforeBuildCommand` runs `npm run build:duck-android`).

- **The pages.** The APK carries one page, the loader (`duck-android/web/loader.ts`,
  built into `www/`): it keeps Workbench's address (the Funnel one, `*.ts.net`; with
  Tailscale on, MagicDNS sends the same name the short way) and opens the desktop's
  page there. Unreachable, it stays, and the phone's own recognizer and the fast path
  still run timers, alarms, the flashlight and media keys. The desktop's page is
  `src/pwa/` as before; the capability (`src-tauri/capabilities/default.json`) lets
  `https://*.ts.net` reach the plugin.
- **The plugin** (`gen/android/app/src/main/java/com/workbench/duck/`, registered in
  `src-tauri/src/lib.rs`; its commands listed for the ACL in `build.rs`). The page's
  side is `src/pwa/native.ts` (`inApp()`), and `duckApp.ts` for what Duck does more
  in the app:
  - `DuckPlugin.kt`: the commands; `run` checks permissions (asked on first use) and,
    over the lock screen with "require unlock" on, asks for an unlock first.
  - `PhoneTools.kt`: the `phone` tools (`NAMES` is what `hello` announces; a test
    checks it matches `tools/phone.ts`).
  - `Store.kt` (the address, the token sealed with a Keystore AES key, settings,
    Done / Snooze not yet sent), `DeviceKey.kt` (the device key in the Keystore,
    StrongBox if any; the same proof as `deviceKey.ts`, so `remote/auth.rs` didn't
    change).
  - `Assist.kt`: the assistant role (voice interaction service, session, and a
    recognition service that hands other apps' requests to the phone's recognizer);
    the session opens the app's own activity (one webview) and sends the screen's
    text as a `screen` launch.
  - `Surfaces.kt`: the tile (conversation mode on / off) and the widget (talk button,
    and the line the page last sent).
  - `ConversationService.kt` and `Mic.kt`: conversation mode with the screen off (a
    microphone + media-playback foreground service, a wake lock) and the native mic
    (16 kHz, voice-communication source, 32 ms frames over a channel).
  - `Notifications.kt` (the notification listener, also what lets the app see media
    sessions) and `ReminderAlarms.kt` (exact alarms, their notification with Done and
    Snooze, re-armed after a reboot).
- **In the page** (`duckApp.ts`, wired from `duck.ts`):
  - On connect it says `hello` as the phone and serves the calls (`serveHost`).
  - It arms `phone.reminders` and sends the taps kept.
  - A launch opens Duck: listening for one request from the gesture or the widget
    (sent when you stop talking), conversation mode from the tile.
  - The screen's text goes with the next message within two minutes, in `<shared>`.
  - The fast path (`fastPath.ts`) runs before any model.
  - In conversation mode the socket stays open with the screen off.
  - The mic is native (`mic.ts`, `converse.ts`'s `streamNative`).
  - The token and the device key are the app's (`net.ts` `loadToken`, `deviceKey.ts`).

## Where to change X

- **What Duck says, its routing rules and examples, the tool tiers' wording**: the files
  `config/system.md` / `voice.md` in Duck's workspace (no build), or their defaults in
  `prompt.ts` (a build; a file nobody edited follows it).
- **Which model and effort a turn runs at**: `routing.ts` (`pickEffort`, `route`), and
  `brain/policy.ts` for API versus the subscription brain (and D3's modes that think
  there: `thinksOnSession`, the `sessionModes` setting).
- **A worker's tier (model, effort)**: the settings' `tiers` (`settings.ts`
  `DEFAULT_TIERS`), editable in the drawer's settings.
- **A new tool**: "Adding a tool" above; register it in `toolset.ts` (`TOOLS`, and
  `DEFERRED` if rarely used), and in `modes.ts` for a mode that should offer it.
- **Tools from another MCP server**: an http server is X1's (`mcpServers`); a stdio one
  in your Claude Code config is turned on in the settings (B2, `mcpHost`). Its tiers
  are `hostedTools` in `tools/mcpHost.ts`; the browser's profiles are `browser.ts`.
- **A tool that runs on the PC or the phone**: `host` on its `defineTool`, its
  handler on the host ("Tools that run elsewhere" above, `hosts.ts`); a PC tool's
  handler goes in `pcHandlers` (`tools/pc.ts`), its Rust beside `steam.rs` / `media.rs`.
- **What the phone's app can do, or how it's opened**: the tool's declaration in
  `tools/phone.ts`, its Kotlin in `PhoneTools.kt` (and its name in `NAMES`); a new
  plugin command also goes in `build.rs`'s list and `native.ts`. What the page does
  with a launch: `duckApp.ts` and `listenOnce` / `talkFromApp` in `duck.ts`; the fast
  path's phrases: `fastPath.ts`.
- **When a reminder comes up** (the spell, a day's hour, what counts as due, a repeat's
  next time): `reminders.ts`; its record and checks: `reminders.rs` (and
  `ipc/reminders.ts`); how it reaches the phone and what its buttons do: the clock's
  `announce` and `onReminderAction` in `index.ts`, and `sw.js`.
- **Another music service**: a `MusicProvider` (`music/provider.ts`) passed as
  `music` to the engine in `index.ts`; the tools don't change.
- **A mode's prompt, tools, effort or pauses**: `modes.ts` for the built-in ones. A new
  mode with no code is a skill with `mode:` (`skills/<name>/SKILL.md`, "Skills" above).
- **A new behavior for a kind of request**: a skill (no build), by hand or with
  `draft_skill`.
- **Something Duck does in the app** (sessions, notes, git, panels, shells): a
  `WorkbenchPort` member in `port.ts`, implemented in `port.local.ts` (the only file that
  may touch the stores), faked in `fakePort.test-util.ts`.
- **What asks and what runs**: `trust/` (rules, floor, decide), `policy.ts`; a tool's own
  `trust()` facts. This is the safety layer. Sessions' questions and plans, and
  promotion to Claude Code's allow list: `trust/delegate.ts` and `trust/promote.ts`.
- **What surfaces can send or hear**: `protocol.ts`, handled in `index.ts`'s `endpoint`
  (and `remoteBridge.ts` for what a phone may do).
- **The drawer, cards and views**: `src/panels/Assistant/` (`Drawer.tsx`, `view.ts`,
  `duckState.ts`).
- **Worker tasks** (queueing, results, reports): `tasks.ts`; their tools in
  `tools/tasks.ts`; the workspace and task folders in `workspace.rs`.
- **Something on a schedule**: a routine (`routines.ts`; what it does in
  `housekeeping.ts`). A new built-in job is a `JOBS` entry, a `BUILT_IN` routine and a
  branch in `housekeeping.ts`'s `run`.
- **Duck's data repo** (backup, push, branch review, task retention): `gitlane.rs`,
  through `housekeeping.ts`.
- **Memory**: files and index in `memory.rs`; recall in `memory.ts`; the nightly tidy in
  `consolidate.ts` and its prompt in `PRIMITIVES.consolidate`; core memory in `core.ts`.
- **Voice**: `src-tauri/src/voice/` (speech in and out), `speakable.ts`, `replySpeech.ts`,
  `voiceState.ts`; announcements in `announce.ts`. The wake word: its phrases and their
  spellings in `kws.rs` (`KEYWORDS`) and `wake.rs` (`HEY`, `DUCK`), its timings at the top
  of `wake.rs`. A phone's echo: `aec.rs` (`Feed`),
  `conversation.rs` (`Surface::reference`, `BargeCheck`), the `Phone` surface in
  `remote/assistant.rs`, and the page's `conv.said` in `src/pwa/duck.ts`.
- **The phone app's shortcuts, sharing and start view**: the manifest
  (`src-tauri/src/remote/pwa/manifest.webmanifest`), `src/pwa/launch.ts`,
  `launchDuck` in `src/pwa/duck.ts`, and `takeShare` in `src/pwa/sw.js`. How a phone
  proves its key: `remote/auth.rs` (the rules), `remote/mod.rs` (`start_session`,
  `check_token`), and `src/pwa/deviceKey.ts` and `net.ts`.
- **Storage**: a table is a migration appended to `db.rs`'s list, never an edit of one.
- **Tests**: `npm run lint`, `npm test`, and `cargo test --lib` in `src-tauri` (with
  `CARGO_TARGET_DIR=target-test` while a dev build runs).

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

- The PC's tools (H2) live: Steam's library and the media sessions were read on this
  PC by hand (ignored tests), and the matching, handlers and weather are tested over
  fakes. Not yet tried by voice: a game launched and another installed by name, "what's
  playing" naming a YouTube Music tab and pausing it, the weather for home and a city.

- Music and video (H3) live: tested over a fake search and fake hosts; no YouTube key
  is stored yet (`duck/youtube-api-key`), so no real search has run. Playing on the
  phone waits for H5 (the phone serving `open_on_phone`). Not yet tried by voice: a song
  by name in YouTube Music on the PC and on the phone, a video on the named device.

- Reminders (H8) live: tested over a fake file and the engine. Not yet tried in the
  app: a reminder added and closed through Duck, a project's on new sessions from the
  rail and through Duck, one announced two minutes out (and one missed while closed),
  the widget, a hand-broken file. The phone shows the chips but has no widget yet.

- Repeats, snooze, timers and phone push (H4) live: tested over a fake file, fake
  timers and the Rust token store. Not yet tried: a reminder set from the drawer
  arriving on the phone as a push on time, one due while the app was closed arriving
  at the next start marked late, Snooze and Done from the notification, a timer by
  voice. Phone alarms that fire offline are H5's; a calendar mirror isn't built.

- The phone's app (R4, H5) built and run on an Android 16 emulator, not yet on the
  phone. Checked there: the loader and the desktop's Funnel page both reach the plugin;
  the Keystore key's proof verifies; the sealed token; a timer and an alarm set in the
  Clock app without it opening; volume, flashlight, media keys; notifications read; a
  reminder ringing in airplane mode with Done / Snooze (Snooze re-armed, the tap kept);
  the assist key opening Duck with the screen's text; the tile; the native mic in the
  foreground service, still streaming with the screen off. Not yet tried: any of it on
  the Nothing Phone (2a), pairing from the app, Nothing OS's assistant menus, a
  10-minute walk-and-talk and a 30-minute screen-off session, a Telegram reply, a call
  and a text, the widget on a home screen. Not built: switching to the tailnet's own
  address (MagicDNS covers it), the screenshot with the gesture (G1), Glyph lights,
  the widget polling by itself.

- The wake word (V6) live: built and measured on recordings (no spots in 6.3 h of
  speech without the phrase; 81 of 84 synthetic English and 9 of 15 Russian caught),
  not yet tried in your room: the TV test, real attempts in both languages, CPU over a
  day. Off by default until then.

- B2 live: the host is checked against your real bridge (an ignored test: it starts,
  lists, answers, and its tree dies on stop). Not yet tried in the app: GitHub
  notifications in the agent profile, the personal profile's card (the add-on isn't in
  your everyday profile yet), the login card, and the 10-minute idle stop.

- D3's experiment hasn't run: no real session-backed rubber duck yet, no numbers, no
  decision. Until then the setting is off, and an option only.

- T3 live:
  - Built and tested over the fake port: delegated answers, suggestions, plan reviews
    and approvals, promotion's preview and stale write.
  - Not yet seen in the app: a real delegated session's question, a plan review on a
    real plan card, and a promoted pattern no longer asking.
  - The phone's choice card doesn't show Duck's advice yet.
  - The daily digest isn't built (it was optional): today the decisions view and the
    autopilot's morning summary cover it.

- The web (B1) live: built and tested with scripted replies (a paused search sent back
  whole, chips, citations), not yet asked "what's new in the latest Tauri release?"
  in the app.

- The phone as an app (R3) on a real phone: built and tested in parts (the key's format
  across WebCrypto and Rust, challenges, sessions, the launch and share parsing), not
  yet tried installed: the shortcuts on a long-press, "Talk to Duck" pinned to the home
  screen, a page shared from Chrome summarized. Shared files and images wait for G1.

- Modes in the app (S1): built and tested with the scripted engine, not yet tried live
  (a duck thread asking instead of answering, the wrap-up note, a chat thread). Not
  built: a voice style per mode (Duck's voice is the same in every mode), modes on the
  phone (its new threads are the assistant's, and its list shows no badge), and starting
  conversation mode by asking for it ("let's talk").

- Duck answering Claude Code questions and plans, and promoting rules into Claude Code's
  own settings (T3).
- The phone's echo fix (V7) on a real phone: built, and tested on X0's laptop-speaker
  recording turned into a phone recording, not yet measured on the phone. The
  half-duplex fallback (tap or say "stop" to interrupt) waits for what that shows.
- Git writes from Duck to your projects (left out of W2 on purpose). Duck commits only its
  own memory files, in its workspace (L1), and pushes only its data repo to its own
  backup remote (L4).
- Routines, the backup and housekeeping in the app (L4): built and tested with fakes and
  temporary repos (the schedule, the push and its classification against a local bare
  remote, the branch review, task retention, the repair and housekeeping flows), not yet
  run in the app. No backup remote exists yet: `set_up_backup` (or the settings' button)
  runs `gh repo create`, so it waits for you. Skill actions wait for S2.
- Long-term memory in the app: built and tested (the index, the files and the commits in
  `memory.rs`, the recall note and the tools through the engine), not yet tried in a
  real thread, and the `clear_at` system message not yet sent to the real API. The
  consolidation (L2) is tested with a scripted answer; its Haiku call hasn't run against
  the API, and the hit rate needs two weeks of use before the embeddings decision.
- Skills in the app (S2): built and tested with fakes (the parsing, the block, a drafted
  mode used in the next request, the narrowing), not yet tried live: the morning
  briefing on "доброе утро", a draft allowed on the card, `mode: interviewer` in the
  picker, the watcher noticing a hand edit on Windows. Not built: skills on the phone
  (it gets the event and ignores it), sharing, and code in skills.
- Self-development in the app (L3): built and tested with fakes (the config files and
  pins, the diff card, the brief, the branch read, the two-card merge, the rebuild
  command), not yet run for real: no Opus worker has made a branch to Duck through it,
  and nothing has been merged or rebuilt that way.
- The subscription brain in the app: built and tested with a fake process, and the same
  flags tried by hand against a stand-in MCP server (M3's As built), not yet through
  Workbench itself.
- Running the morning routine's Google half against real Google: sign-in, the copy and the
  cell writes are built and tested with fakes only.
