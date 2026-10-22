# Duck — architecture

How Duck (the D.U.C.K. assistant) is built, as it stands. The plan and the reasons
behind each decision are in `assistant-plan.md`. This file describes the code, and every
Duck step updates it as part of its Done when. Duck's self-development sessions (L3)
read it first.

Last updated: step L3 (2026-10-22), which also audited it against the code. Since W5 it
also covers W6, D2, D4, P1, P2, M2, M3, A5, A6, A7, W4, L1, L2, R1, R2, V1 to V5, X1 and
the morning routine. A fresh session changing Duck: read "The shape", then "Where to
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
| `protocol.ts` | The Duck Protocol, version 1: `ClientMessage` (send, stop, confirm, thread.new, thread.delete, thread.compact, sync, thread.open, settings.set, trust.pause, trust.rule.add, trust.rule.remove, trust.mode, trust.floor, trust.decisions, trust.replay, task.close, task.rerun, task.diff (L3: open a change to Duck's branch in the Diff/Review panel), thread.memory (L1: "don't remember this conversation"), autopilot, reader, dnd, and V4's turn.commit / turn.withdraw for a `provisional` send) and `DuckEvent` (threads, history, thread, threadDeleted, message, delta, provisional, withdrawn, goThread, tool, confirm, confirmed, turnState, routing, spend, settings, trust, decisions, decision, tasks, autopilots, replay, reader, error). A `ConfirmRequest` carries the tool's `summary` and, for a file edit, `review` (each file's before and after, shown as diffs); a `note` notice carries a `NoteEdit` (before, after, revision) and a `plugins` notice a `PluginsEdit` (the plugin file and its scripts, before and after, and the new revision) and a `memory` notice a `MemoryEdit` (`core.md`'s path, before and after, W4) for the drawer's chips. Source `event` marks a follow-up from Workbench, not the user. `createLocalTransport` stamps `v`. |
| `settings.ts` | Duck's settings (pref `assistant`): `confirmPrompts` (ask before every prompt sent to a session), `codingModel` (what `create_session` uses for coding work) `answerSessionPrompts` (T2: off by default, which keeps the trust watcher in shadow mode for every project), `codingPermissionMode` (M4), the workers' `maxWorkers`, `headlessWorkers` (D4), `workspace`, `tiers` (D1: each tier's model and effort), `workerIdleStopMinutes` and `closeFinishedHours`, `summaryOnDone` (W3), `announce` and `dndUntil` (V5), `mcpServers` (X1), `compactAt` (A6: compact a thread past this many input tokens; 0 never), and `google` (the Desktop OAuth client id for Drive and Sheets; the first build's `morning.googleClientId` is taken over). Loaded at start, changed only through `settings.set`. |
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
| `tasks.ts` | Worker tasks (D1): `createTaskManager({port, backend, settings, tell})` keeps the records (`assistant_tasks`), starts queued tasks while `maxWorkers` allows (a start takes its slot synchronously), settles a task on its worker's turn end from a fresh `result.json` (one nudge, then the last reply), reports every outcome to the asking thread as a `<workbench_event>`, and handles follow-ups, closing and the records left running by a restart. `firstPrompt`, `briefText`, `tierOf`, `parseResult` are exported for tests. L3: a task marked `self` (a change to Duck, from `improve_duck`) has its branch read when it finishes (`port.worktreeChanges`, checked by `safetyFiles`) before the thread is told; the record keeps `changes` (branch, base, files, the uncommitted ones, the ones in the safety layer), and the report says them. |
| `apiWorker.ts` | The API worker (D2): a worker task run on Duck's API credits instead of a session when the subscription's limits are close (5-hour window at 70%, week at 80%; `tasks.ts` `route()`). A task marked `prep` (the morning routine's `prep_ahead`) never goes to the API: it waits until the window resets. One sub-loop on the tier's model with the server's web search and fetch and one tool of ours, `submit_result`, which writes the same `result.md` / `result.json`. Purpose `api-worker`. |
| `autopilot.ts` | Plan autopilot (P1, P2): Duck runs a session's "step → /compact → continue" loop. After each turn an `autopilot-review` call (Sonnet, low effort, structured) says `continue`, `needs_you` or `plan_done`. Unattended runs (P2) keep to a window or an end time, pause over a subscription limit (`AUTOPILOT_LIMITS`) and carry on after the reset, pause on the same step failing twice, and check in on a stalled turn. One per session, kept in `assistant_autopilots`. |
| `routing.ts` | Per-message routing (M2), no classifier call: effort `medium`, `high` for a rubber-duck thread, "think hard" (English, Russian, Spanish) and research, plan or comparison asks; the model is Sonnet, or Haiku for the rest of the month past the budget's soft limit, where "think hard" sends that one message on Sonnet. |
| `announce.ts` | Announcements (V5): Duck's reply to a `<workbench_event>` is the news, said at its producer's level (`info`, `report`, `needs_you`) on this PC when you're at it, else a phone with Duck open, else a push. Do Not Disturb, quiet hours, full-screen apps, the Speak switch, waiting for a gap, and batching are its etiquette (`AnnounceSettings`). |
| `speakable.ts` | Spoken replies' words (V2): `Sentences` cuts a stream into whole sentences, `toSpoken` makes one sayable, `langOf` picks Kokoro (English) or Silero (Russian), and a Russian sentence with digits or Latin letters gets the `speakable_ru` Haiku rewrite or `russianFallback`. |
| `reader.ts` | Read-aloud (V3): a source in sections, each made when its turn comes (narrated by Haiku first in `narrate` mode), played on the desktop or the phone that asked, after the reply is over; pause / resume / next / previous / stop, and a position kept per source for "continue reading". |
| `voiceNames.ts` | The name fixer (V1): project and session names and a term list, said in Russian and written in Cyrillic by Parakeet, put back in their own spelling with loose matching for longer names. |
| `remoteBridge.ts` | Duck on the phone (R1): the webview's half of the remote server's `/api/assistant` socket. Frames are checked against what a phone may do (no settings, no loosening trust, no replay, no thread delete); messages are stored as `phone` / `phone-voice`; spoken replies, reads and announcements go down as `tts` parts a sentence at a time; screenshots never go to the phone. |
| `spend.ts` | `createTurnMeter()`: bills each metered `thread` call to the one turn that is calling (none if two are), giving each thread's latest turn cost for the `spend` event. |
| `engine.ts` | The loop. Pure helpers `toApiMessages`, `effectiveEffort`, `buildParams` and `eventText` are exported for tests. Each tool call gets a `ToolContext` with the settings, `notice()` (a thread item the model never sees) and `later(text)` (a follow-up sent into the thread as a `<workbench_event>` user message with source `event`, which runs its own turn). A tool with `prepare` has it run first (a throw fails the call before any card); what it returns is kept on the call (`BatchCall.prepared`, persisted with a parked batch) and handed to `describe`, `review`, `trust` and `run` (`ctx.prepared`). The gate is asked with the call's own tier (`registry.callTier`), the card's summary and the tool's trust facts (`registry.trustFacts`). It answers run, ask, or deny with a reason, and an optional notice. |
| `threads.ts` | `createThreadStore(backend)`: threads, messages (loaded per thread on first use) and parked tool batches, in memory and persisted. Appends to one thread are serialized so each gets the next `seq`. |
| `client.ts` | `getClient()` (the SDK at the proxy, with the launch token as its key), `purpose()`, `capMessage()`, `errorMessage()`, `structured({model, system, input, schema?, purpose, …})` (one call, structured output parsed), and `oneShot(name, input, {schema?})` for Haiku primitives over it. |
| `prompt.ts` | The system prompt and the voice note as built in (L3: the defaults; what a thread runs with comes from `config.ts`), `MAIN_MODEL` / `PRIMITIVE_MODEL`, and `PRIMITIVES` (one frozen prompt per Haiku job; the key is its `x-wb-purpose`). |
| `config.ts` | Duck's prompts as data (L3): `config/system.md` and `config/voice.md` in the workspace (`CONFIG_FILES`). `createConfig(store)`: `current()` reads them, seeds a missing one with its default (recording the default's hash as the seed), lets a file untouched since its seed follow a new build's default, and falls back to the default for one `problemsWith` refuses (too short or long, or without `SAFETY_RULES` verbatim), saying why; `forThread(id)` returns the thread's pin, or pins it on the files now (`assistant_config_pin`), so a thread's system prompt never changes under its cache. `applyEdits` (each `find` exactly once), `hashOf`, `ipcConfigStore`. |
| `selfdev.ts` | Duck changing its own code (L3): `SAFETY_PATHS` / `safetyFiles` (the trust engine, `proxy`/`budget`/`key`/`trust.rs`, and `selfdev.ts`, `config.ts`, `tools/improve.ts`), `selfProject` (the project whose folder or name is "workbench", unless named), `improveBrief` (the request, the related `lessons` entries, where to read first, the allowed paths, the safety layer, the test commands, "commit on the branch, don't merge or push", and `result.md`'s contents), `REBUILD`. |
| `port.ts` / `port.local.ts` | `WorkbenchPort` and its one implementation over the stores. The only file under `src/assistant/` allowed to import `src/state/**` or `src/panels/**`. Members: projects, sessions (live phase, pending choice with its id, worktree, model, last activity), transcript paging, usage limits, a git snapshot of a directory, notes list/read, Duck's spend; and the W2 actions: `sendPrompt` (`state/promptOutbox.ts`: one prompt per turn, confirmed by `UserPromptSubmit`; a stopped session is resumed with the prompt on claude's command line), `createSession` (`startNewSession` from `state/remoteActions`, shared with the phone), start/resume/interrupt/stop/kill, `answerChoice` (refused unless the named prompt is still open), `openPanel`, note writes, `onPhase`; L3's `worktreeChanges` (`instanceDiff` against the project's current branch, and `gitStatusEntries` in the worktree for what isn't committed), `mergeWorktree` (`teardownWorktree` with a merge into the target `worktreeTeardownInfo` names: the rail's own path) and `runInShell` (`newShell`, `whenShellRunning`, then the command typed into the PTY); and W5's plugins: `listPlugins` (the parsed file, each plugin's field values as a run sends them, each action's last run), `pluginsText`, `checkPlugins`, `writePlugins`, `readScript` / `writeScript`, `previewPluginAction` (the argv and cwd the backend would spawn, and the confirm question filled in), `runPluginAction` (`startPluginRunFor` in `panels/pluginRun.ts`: no confirm question, refused while running, the project shown first because task panels are drawn for the shown project only) and `onTaskEnd` (from the tasks store; the last lines come from `terminalPool.readTail`); `startPluginsDraft` (`startNewSession` with `beforeLaunch`, which makes the draft and registers the session before its first launch), `readPluginsDraft`, `clearPluginsDraft`; and T2's: `choiceOf`, `onChoices`, `holdNeedsYou` (`state/promptHold.ts`; `onPhase` also waits on it for a fresh needs-you, and drops one Duck answered), `sessionContext` (the stored mandate, else the transcript's first prompt; the latest prompt; the home folder) and `noteSession` (`state/trustLines.ts`, the line under the card). `createSession` and `startPluginsDraft` store a `mandate` (memory and duck.db `meta`). |
| `fakePort.test-util.ts` | `fakePort(data)` and the `project()` / `session()` builders: a port over fixture data for the engine's and the tools' tests. Actions are recorded in `calls`, notes writes keep the revision check, `phase()` fires `onPhase`. `toolCtx(port)` is a tool context that records notices and follow-ups. Plugin files are kept as text with a revision counter (`fakeCheck` stands in for the parser), and `endTask()` ends a run. |
| `tools/registry.ts` | `defineTool({name, description, schema, tier, tierFor?, prepare?, describe?, review?, trust?, timeoutMs?, run})` and `createRegistry(tools)`: the API tool list sorted by name, built once; `tierOf(name)`, `callTier(name, input, port)` (a tier that depends on the input or state), `prepare(...)` (async work the card needs, before the gate; it gets the settings and the Google host too), `describe(...)` (the confirmation card's sentence), `review(...)` (the card's diffs), `trustFacts(...)` (the call's project, rule specifier, text for the floor, and `asks`). Tools in `index.ts`'s `DEFERRED` (M2: the plugin, autopilot and screen tools and a few rare ones) go out with `defer_loading` and are found with the server's regex tool search, which keeps the fixed prefix small. |
| `tools/getTime.ts` | `get_time` (read tier): the local date, time and zone. |
| `tools/read.ts` | The W1 read tools: `list_projects`, `list_sessions`, `get_pending_choice`, `read_session`, `usage_limits`, `git_overview`, `list_notes`, `read_note`, `duck_spend`. Compact JSON, empty fields left out; projects and sessions are named by id or name (`findProject` / `findSession`, which list the choices on a miss or an ambiguity). |
| `tools/act.ts` | The W2 action tools. Reversible: `send_prompt`, `create_session`, `start_session`, `open_panel`, `wait_for_session`, `create_note`, `append_note`, and `resume_session` on a stopped session. Consequential: `answer_choice`, `interrupt_session`, `stop_session`, `kill_session` (the rail's kill: removes the row; refused with a worktree or a remote tmux session), `write_note`, `delete_note`, and `resume_session` over a running session. Note writes leave a "Duck edited" chip. Each tool's `trust` names its project. `answer_choice`'s facts carry the prompt's kind as the specifier, the Claude Code call a "yes" would allow (for the floor), and `grantedBy` (never for a "don't ask again" option). `stop_session`, `kill_session`, `resume_session` and `delete_note` take `grantedBy` too: the user's words asking for that call. |
| `tools/plugins.ts` | The W5 toolbar tools. Read: `list_plugins` (fields with values, actions with their `run` template and last run), `read_plugins` (the raw file and its revision). Consequential: `run_plugin_action` and `write_plugins`, whose `prepare` works out the card. A run's card shows the argv after substitution and the cwd; its facts give the specifier `plugin:action`, the argv as a `Bash` call for the floor, `asks` when the file has a confirm question, and `grantedBy`. It is pinned to the file's revision and previewed again just before it starts; its end comes back through `later` with the exit code and last lines. An edit is checked (`plugins_check`) and its base revision compared in `prepare`, so problems come back at their JSON paths before a card; scripts go into `{data}/scripts/` before the file, and a `plugins` chip offers the diff and undo. `delegate_plugins_edit` hands a change that needs the code read to a drafting session (on the coding model, with the `workbench:plugins` skill, allowed to edit only its draft folder) and watches it; `apply_plugins_draft` reads the draft from disk and goes through the same card and write as `write_plugins`. |
| `summarize.ts` | Session summaries (W3): `createSummarizer({port, backend, call})` reads a session's transcript since its last summary (or a given time) with `readPlainText`'s `since`, makes one Haiku `summary` call, and keeps the last summary per session in duck.db `meta`. `newest` checks a transcript for activity without a call; `withReply` adds a turn's final reply the transcript doesn't have yet. |
| `tools/summaries.ts` | The W3 tools, over `ctx.summaries`: `summarize_session` and `summarize_activity` ("since I was away"). |
| `tools/tasks.ts` | The D1 tools, over `ctx.tasks`: `run_task` (reversible; posts the `task` notice that the thread shows as a live card), `task_status`, `task_followup`, `task_close`, `list_tasks`, and D2's `task_rerun` (deferred). `findTask` and `view` are shared with `tools/improve.ts`. |
| `tools/improve.ts` | L3: `improve_duck(request, scope, effort?)` (reversible): scope `config` returns the prompt files for Duck to draft from; scope `code` starts a `self` code task, tier serious (Opus, `medium` unless named), in a worktree of the Workbench repo, with `improveBrief`. `propose_config_change(file, edits, why)` (consequential, `asks`: always a card): `prepare` makes the edits on the file as it is and checks the result, the card shows the diff (`review`), `run` writes it over the text it was read as and commits it; new threads get it. `merge_duck_change(task, safetyConfirmed)` (consequential, `asks`; deferred): `prepare` reads the branch fresh and refuses an unfinished task, an empty branch or uncommitted files; a branch in the safety layer takes two cards, the second only after the first was confirmed (`firstConfirms`, in memory); then `port.mergeWorktree` and the task closes. `rebuild_duck(build)` (consequential; deferred): `npm run tauri:dev` or `tauri:build` in a new shell in the repo. |
| `tools/threads.ts` | Duck's own threads (A5, A7): `start_thread` (the user's own words, cut from their message, go in as its first message; with `go`, the surface moves there), `list_threads`, `go_to_thread` (the surface moves once this reply is over), and consequential `delete_thread`. |
| `tools/autopilot.ts` | The P1/P2 tools over `../autopilot.ts`, all reversible: `start_autopilot`, `autopilot_status`, `pause_autopilot`, `resume_autopilot`, `stop_autopilot`. |
| `tools/haikuTask.ts` | `haiku_task` (M2): a reading-heavy chore over transcripts and notes the tool fetches itself, done in one Haiku call so the long text never enters Duck's context (about 25k tokens a source, 100k in all). |
| `tools/screen.ts` | W6: `read_screen` (a session's console as untrusted text, with a hash) and consequential `press_keys`, refused when the screen changed since that hash or when you've typed there lately; keys into an open prompt are judged as `answer_choice`. |
| `tools/screenshot.ts` | V3: `screenshot` (downscaled PNG as image blocks, with the monitor list) and `save_screenshot`. |
| `tools/readAloud.ts` | V3: `read_aloud` resolves a source (a session's reply, a note, a summary, text) and hands it to the reader in `verbatim`, `narrate` or `summary` mode. |
| `tools/quiet.ts` | V5: `set_quiet`, Do Not Disturb and the Speak switch by voice or text. |
| `brain/policy.ts` | Which brain answers a turn (M3): `pickBackend` over the `brainPolicy` setting (`auto`, `api`, `subscription`), the API's soft limit, a "credit balance is too low" this month (`creditsGone`), and the subscription's windows (both under 70% / 80%, `SUBSCRIPTION_LIMITS`; no reading counts as room). `switchCard` words the card of a switch. |
| `brain/subscription.ts` | The subscription brain's engine side (M3): `BrainHost` (`createBrainHost` over `ipc/brain.ts`; L3: `spawn` takes the thread's system prompt), `brainPrompt(system)` / `BRAIN_PROMPT` (the system prompt plus what's different inside Claude Code), `mcpTools` (the registry's own definitions, so the two paths never drift), `toMcpResult`, `storedBlocks` / `storedResults` (a reply kept as API messages: no thinking, tool names without `mcp__duck__`, source `brain`), and the handoff: `brainTurn` puts what the session hasn't seen in front of your message (all of the thread for a new session, the compaction's summary for what it covers, the core memory; the turns since its last reply for a running or resumed one), `lastBrainSeq`, `unanswered`. `ASKED` is what a call parked on a card returns. |
| `core.ts` | Core memory (W4): `memory/core.md` in the workspace, four sections (`CORE_SECTIONS`: About you, Preferences, Standing instructions, Names & nicknames) of one-line bullets. `addFact` / `removeFact` (the fact named, else the one fact containing the words; several is ambiguous and removes nothing), `coreText` (the `<core_memory>` block, null without facts; it says a standing instruction never counts as `grantedBy`), `createCoreHost` over `assistant_core_read` / `assistant_core_write`. Capped at `CORE_MAX_CHARS` (8000, ~2k tokens). |
| `memory.ts` | Long-term memory, the engine's side (L1): `MemoryHost` (`createMemoryHost` over `ipc/memory.ts`), automatic recall (`recallFor`: the message searched, `worthRecalling` keeps up to `RECALL_K` = 3 hits, a memory entry holding two of its words or a note three; slower than `RECALL_MS` or failing, it's left out), `recallNote` (the `<recalled_memories>` block, plus the lesson line when `isCorrection` says the message corrects Duck, in English or Russian), `memoryOff` (a thread's latest `memoryOff` notice), `today`. L2: `recallFor` returns a `Recall` (the note, the query, the hits and how many the search found) and asks `host.question` for a contradiction to carry (`questionLine`, a `<memory_question>` block); `recallRow` makes the log row after the turn: `usedHit` counts a hit as used when the reply says two of its own words (`stems`, cut as the index cuts them, the message's words left out), and a `recall` call in the turn is `selfRecall`. `MemoryHost` gains `log`, `question` and `tidy`. L3: and `suggestion`, carried as a `<duck_suggestion>` block (`suggestionLine`: mention it once, offer `improve_duck`, start nothing unasked). |
| `consolidate.ts` | Memory consolidation (L2): `createConsolidator({threads, messages, tasks, list, apply, state, call, idleMs})`. `run` reads the window since the last run (`consolidationInput`: the memory with `[eN]` ids, your conversations newest first up to 60k characters, without events or threads with `memoryOff`, and the tasks that finished), makes one Haiku `consolidate` call (structured: `Consolidation`), and `planFrom` turns the answer into one `MemoryPlan` (contradictions first, whose entries are then kept out; merges of two or more real ids; retirements; new entries; ids made up or used twice dropped), applied as one commit whose message lists every change. Contradictions wait in the `questions` state for `question`; repeated requests go to `skill_offers` for S2. L3: the input also has `<tool_errors>` (`toolErrors`: tool calls that failed more than once in the window, by tool, not the ones you declined or stopped), and the answer's `improvements` (changes to Duck a pattern calls for) wait in `improve_offers`; `suggestion` hands out one a week at most, each once. No activity, no call. `tick` (every 5 minutes, from `index.ts`) runs it once per local date when you've been away `IDLE_MS` (an hour), or 10 minutes when the last run is over 36 h old; a failure waits an hour. |
| `tools/memory.ts` | W4: `remember_core(section, fact)` and `forget_core(fact)`, both reversible. Each edit is made on the file as read and written over that text; a save of yours in between makes it read again and redo the edit once; the commit message names the fact. L1: `remember(topic, fact, why, conf, tags)` (reversible; refused in a thread you asked it not to remember), `recall(query)` (read; memory and notes), `forget(query)` (consequential: `prepare` finds the entries holding every word, the card lists them, `run` removes them). L2: `tidy_memory` (reversible) runs the consolidation now. All loaded, none deferred. Every write leaves a `memory` chip with the diff and an undo. |
| `tools/testConfirm.ts` | `test_confirm`, a consequential tool that does nothing, for trying the confirmation card, and `test_announce`, for trying an announcement. Registered in dev builds only. |
| `mcp.ts` / `tools/mcp.ts` | External MCP servers (X1), from the settings' `mcpServers` (default: Quest Log at `http://127.0.0.1:7437/mcp`, no token). `createMcpHost(mcpRequest)` caches a server's `tools/list` for 5 minutes and turns a `tools/call` result into text. The tools are fixed, so a server that's down or changes never touches the cached prefix: `mcp_tools` (read: the servers, or one server's tools with their schemas and `readOnly`), `mcp_read` (read: only the tools named in the server's `readTools`), `mcp_call` (consequential: everything else; card summary `server: tool {args}`, specifier `server:tool` so a rule like `assistant:mcp_call(quest_log:create_entry)` can allow one tool, and `grantedBy`). Results come back in `<mcp_result … untrusted>`. The drawer's settings have an on/off and the URL per server. |
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
| `budget.rs` | Limits, month-to-date spend, and the cap rule (at the cap only Haiku with a purpose other than `thread` passes). `saved_usd`: this month's subscription-brain turns at their API price (`record_saved`, M3), never part of the spend. |
| `threads.rs` | Threads, append-only messages and parked batches in `duck.db`; `delete` removes a thread with its messages, batches and config pin in one transaction. |
| `summaries.rs` | The last summary per session (W3), JSON in `meta` under `assistant_summary:<instance>`. |
| `memory.rs` | Long-term memory (L1). The files: `memory/<topic>.md` (`decisions`, `preferences`, `people`, `goals`, `lessons`, `projects/<name>`; `journal/` is L2's), one bullet per entry, `- 2026-10-22 — fact. Why: … (src: thread:…, conf: high, tags: …)`; `parse_file` reads any bullet, with or without the date and the parenthesis. `write` (secrets refused by `secret_in`: key and token patterns, a password after `:`/`=` or in quotes, long random-looking strings; the same text already in the file isn't written again), `forget` (exact bullets), `restore` (an undo, over the expected text), `list`. The index: `ensure` rescans what changed (by size and time) in `memory/` and, read-only, the notes root, each marked dirty by a `notify` watcher (or rescanned on every search without one); `search` splits the query into `terms` (stop words and numbers dropped, a long word cut by a letter or two so inflections match), ORs them in FTS5 (trigram), and ranks by words matched, then rank; a note hit is labelled `note: <project> / <name>`. `matching` is the AND for `forget`. Git: `commit` queues `commit_now` on the git queue: `git init` on the first change, then a commit of just the files changed, as Duck, none when nothing changed. L2: `apply` makes a consolidation's `Apply` (removals, then additions through `write`, then the day's bullet in `journal/<YYYY-MM>.md`, `- 2026-10-21 — paragraph (src: tidy)`) and returns one edit per file from before the run to after it, plus what it skipped (a secret, too long, not a topic); `assistant_memory_apply` commits it once. `log_recall` and `recall_stats` keep and count `recall_log`. |
| `workspace.rs` | Duck's workspace (`prepare`, its `CLAUDE.md`, a `.gitignore` line for `data/`), task folders (`new_task`, `result`, both only under `tasks/`), the workers' registration (`register`: a settings file with the allow list in app data, and a `worker_sessions` row in the main DB) and `launch_args` for `pty_spawn`; the `assistant_tasks` records; the core memory (W4: `read_core`, and `write_core`, which refuses with "stale:" unless the file is still the text it was read as). |
| `headless.rs` | Headless workers (D4): a worker session as `claude -p` over stream-json both ways. Prompts and interrupts are messages, permission requests are answered as data (racing the `PermissionRequest` hook, the first answer winning); otherwise it is an ordinary session to the status engine, summaries, the trust watcher and the transcript view. |
| `subscription_brain.rs` | The subscription brain (M3): `brain_spawn` starts thread `t`'s `claude -p` (stream-json both ways, `--include-partial-messages`, `--model sonnet --effort medium`, `--tools ""`, `--strict-mcp-config` with only Duck's server and a per-process bearer token, `--permission-mode dontAsk --allowedTools mcp__duck`, `--setting-sources ""`, Duck's prompt by `--system-prompt-file`) in `<workspace>/brain`, with no `ANTHROPIC_*` or `WORKBENCH_INSTANCE_ID`, no CLAUDE.md, no auto-memory and no deferred tools. Session id = thread id, kept on disk, so a later spawn `--resume`s it. Emits `brain-event` (text deltas, `assistant` / `user` messages, `result`, init) and `brain-exited`; `rate_limit_event` goes to the usage meter (`statusline::ingest_rate_limit_info`), each `result` into the subscription ledger at its API price. `brain_send`, `brain_interrupt`, `brain_kill`, `brain_tool_result`; `kill_all` on exit. |
| `mcp_server.rs` | Duck's MCP server (M3) at `/duck/mcp` on the hook server, JSON-RPC by hand: `initialize`, `ping`, `tools/list` (the tools the brain was started with), `tools/call` (a `brain-tool-call` event to the webview, awaited up to 10 min). The bearer token picks the thread; anything else is 401, and a GET (the optional event stream) is 405. |
| `autopilot.rs` | Autopilot records (P1): one JSON row per session in `assistant_autopilots`, with its capped step log. |
| `replay.rs` | `scan(dir, days, max)`: the tool calls in the transcripts touched in the window, each with its outcome (`ran`, `rejected`, `denied`, `error`, `none`), the conversation's first prompt and the latest one before it, and the permission mode. Behind `assistant_replay_calls`, on a worker thread. |
| `trust.rs` | Rules, project modes, floor-off, the seeded flag, the kill switch (`meta` `assistant_trust_paused`), sessions' mandates (`meta` `assistant_mandate:<instance>`) and the decision log. `set_trust_paused` in `mod.rs` writes the flag, ticks the tray item (`attention::set_trust_check`) and emits `assistant-trust-paused`. |
| `mcp_client.rs` | `assistant_mcp_request(url, token_env, method, params)`: JSON-RPC to an MCP server over Streamable HTTP (X1). One session per URL (`initialize` + `notifications/initialized` on first use, `mcp-session-id` kept, a 404 retried once on a new session); JSON or SSE replies. In Rust because a local server sends no CORS headers, and so a bearer token is read from the environment variable `token_env` names and never reaches the webview. |
| `google.rs` | The morning routine's Google access: the installed-app OAuth flow (a loopback redirect, PKCE) for the user's own Desktop client and only `drive.readonly` + `drive.file`, so the token can't write to the original sheet. The refresh token is in Credential Manager (`duck/google-sheets-token`, `duck-dev/…` in debug), the client's secret, if any, in `duck/google-oauth-secret` (by `cmdkey`); access tokens stay in memory. `invalid_grant` forgets the token and fails with `google_expired: …`. Commands: `assistant_google_status`, `_connect(client_id)`, `_disconnect` (revokes). |
| `sheets.rs` | Google Sheets. Reads: `assistant_sheet_search` (sheets by name), `assistant_sheet_read` (a tab's non-empty cells, shown and as formulas, 150 rows by 26 columns, and its tabs), `assistant_sheet_cells` (given cells, up to 20) and `assistant_sheet_export` (the cells, plus the tab as CSV, the file as xlsx and a JSON sidecar in `<workspace>/data/invoices/`). Only Google Sheets files. The draft: `assistant_sheet_draft` refuses a second draft of a sheet for a month while the first is in Drive, re-reads the original against what the card showed, refuses a formula cell (in the original and the copy), makes the drafts folder once, copies with Drive's `files.copy` and falls back to uploading the xlsx export as a new Sheet, records the file, then sets the cells (`USER_ENTERED`, plain values only) and reads them back. `assistant_sheet_drafts` lists a month's drafts still in Drive. |
| `config.rs` | Duck's prompt files (L3): `read` (`config/system.md` and `config/voice.md` only, with each one's seed from `meta` `config_seed:<file>`), `write` (over the text it was read as, else "stale:"; records a seed when given; the caller commits), `pin` / `pinned` (a thread's prompts as JSON under their hash; a pinned thread keeps its pin). Commands `assistant_config_read`, `_write`, `_pin`, `_pinned`. |
| `db.rs` | `duck.db` / `duck.dev.db` and its append-only migrations; `assistant_google_files` records every Drive file Duck made (the drafts folder, each draft with its source sheet and month). |

### The desktop surface: `src/panels/Assistant/`

| File | What it is |
|---|---|
| `duckState.ts` | The desktop's one subscription to the protocol, an external store shared by the button and the drawer: threads, the open thread, loaded messages, streaming text, turn states, locally queued messages, confirmations, spend. Actions (`sendMessage`, `stopTurn`, `answer`, `openThread`, …) only send protocol messages. Persists `assistantDrawer` prefs (width, open thread, interrupt). |
| `view.ts` | `toItems(messages)`: stored messages → display items (user text, reply text, a tool chip with its result attached, edit chips for notes, the toolbar and the core memory, notices; thinking and system messages hidden). `sessionLink()` reads `#session/<id>` links. |
| `DuckButton.tsx` | The title-bar button ("D.U.C.K.", the icon beside it): toggles the drawer, the acronym tooltip, a confirmation-count badge, an amber/red tint past the soft limit/cap, ⏸ while trust is paused. |
| `TrustViews.tsx` | `TrustPanel` (kill switch, rules, project modes, the floor with a typed confirmation) and `DecisionsPanel` (the log with make-a-rule / always-ask, the rule from `suggestRule`; and the replay of the past week with its report). Opened from the settings popover; they take the thread's place. |
| `Drawer.tsx` | The drawer: header (thread list, new, memory, the trust pill that is the kill switch, settings, close), thread view (markdown replies, tool chips, queued bubbles), confirmation cards, spend line, composer (Enter / Shift+Enter / Esc, "think hard" = effort `high` for one message). A task card for a change to Duck (L3, `SelfChange`) adds its branch, the safety badge, and "open diff" / "ask for changes" (fills the composer, `fillComposer`) / "merge…". Always mounted and only hidden, so the thread and scroll survive closing. |
| `DrawerSettings.tsx` | Queue-or-interrupt, and "start at login, minimized to the tray" (`@tauri-apps/plugin-autostart`; disabled in dev builds); the workers' settings, with "Edit core.md" (W4) and which brain Duck answers on (M3). |
| `openCore.ts` | `openCoreMemory(workspace)` (W4): prepares the workspace, makes `core.md` with its empty sections if missing, and opens it in the "Duck" project's editor. |
| `MemoryView.tsx` | The Memory view (L1): the long-term memory by topic, a search over it and the notes, per entry "edit" (the file in the "Duck" project's editor) and "forget", and "don't remember this conversation" for the open thread (a `thread.memory` request, which posts a `memoryOff` notice). L2: the last tidy with what it changed, "tidy now" (`tidyMemory` from `index.ts`), and the past 14 days' recall numbers (`assistant_recall_stats`). |
| `TasksView.tsx` | The Tasks view (D2): worker tasks newest first, with headline, cost for an API worker, and ways on (open `result.md`, save to notes, open the console, go to the thread). |
| `OverviewView.tsx` | Every thread at a glance (A5): what each does, its news since you looked, its autopilots and tasks; no model call. |
| `AnnounceSettings.tsx` / `SpeechSettings.tsx` / `VoiceSettings.tsx` | Settings tabs for announcements (V5), spoken replies (V2: engine, voices, rate, Chirp fallback, downloads) and voice input (V1, V4: the key, microphone, speech-to-text, conversation mode, talking over Duck). |
| `GoogleSettings.tsx` | The "google auth" tab: the OAuth client id, connect/disconnect and the `cmdkey` hint for the client secret; and whether the Chirp speech key is stored, with this month's use (which voice to use stays in the voice tab). |
| `voiceState.ts` | Push-to-talk (V1) and conversation mode (V4, the key's default): voice prefs, the HUD, and where a transcript goes (names fixed, then sent to the open thread as `voice`, or into the composer). |
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
  overlay window. Models download on first use.
- `src-tauri/src/remote/assistant.rs` (R1): the remote server's `/api/assistant`
  WebSocket carrying the Duck Protocol, `/api/assistant/audio` (a phone's speech,
  transcribed with V1's model) and `/api/assistant/tts/{id}` (a sentence the desktop
  made for the phone). The phone's PWA (R2) is in `src-tauri/src/remote/pwa/`.
- The dock's root has `isolation: isolate`, so dockview's layers (floating groups at
  z-index 999) stay under the drawer (z-index 60) while modals (100) stay above it.
- Start at login: `tauri-plugin-autostart` (pinned `~2.5.1`; later versions need Tauri
  2.12) registers the app with `--minimized`; `window::build_main` then builds the main
  window hidden, and a left click on the tray icon shows it (`window::show_main`).

### `duck.db` tables

- `assistant_usage`: one row per API call.
- `assistant_subscription_usage (ts, model, api_usd)`: one row per subscription-brain turn
  (M3), priced as the API would have; the spend line's "saved".
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
- `assistant_autopilots`: one autopilot record per session (P1).
- `meta` `assistant_summary:<instance>`: a session's last summary (W3).
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
  (contradictions, asked or not) and `memory_state:skill_offers`. The journal is a file,
  `memory/journal/<YYYY-MM>.md`, indexed like the rest.
- Step L3: `config_snapshots (hash, json)`, one per distinct set of prompts a thread
  started with, and `config_pins (thread_id, hash)`; `meta` `config_seed:<file>` (the
  hash of the default last written into a config file) and `memory_state:improve_offers`
  (changes to Duck the tidy may suggest, with when each was offered). The prompt files
  themselves are `config/*.md` in the workspace, committed like memory.

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
     `routing` event tells the surfaces.
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

## Where to change X

- **What Duck says, its routing rules and examples, the tool tiers' wording**: the files
  `config/system.md` / `voice.md` in Duck's workspace (no build), or their defaults in
  `prompt.ts` (a build; a file nobody edited follows it).
- **Which model and effort a turn runs at**: `routing.ts` (`pickEffort`, `route`), and
  `brain/policy.ts` for API versus the subscription brain.
- **A worker's tier (model, effort)**: the settings' `tiers` (`settings.ts`
  `DEFAULT_TIERS`), editable in the drawer's settings.
- **A new tool**: "Adding a tool" above; register it in `index.ts` (`TOOLS`, and
  `DEFERRED` if rarely used).
- **Something Duck does in the app** (sessions, notes, git, panels, shells): a
  `WorkbenchPort` member in `port.ts`, implemented in `port.local.ts` (the only file that
  may touch the stores), faked in `fakePort.test-util.ts`.
- **What asks and what runs**: `trust/` (rules, floor, decide), `policy.ts`; a tool's own
  `trust()` facts. This is the safety layer.
- **What surfaces can send or hear**: `protocol.ts`, handled in `index.ts`'s `endpoint`
  (and `remoteBridge.ts` for what a phone may do).
- **The drawer, cards and views**: `src/panels/Assistant/` (`Drawer.tsx`, `view.ts`,
  `duckState.ts`).
- **Worker tasks** (queueing, results, reports): `tasks.ts`; their tools in
  `tools/tasks.ts`; the workspace and task folders in `workspace.rs`.
- **Memory**: files and index in `memory.rs`; recall in `memory.ts`; the nightly tidy in
  `consolidate.ts` and its prompt in `PRIMITIVES.consolidate`; core memory in `core.ts`.
- **Voice**: `src-tauri/src/voice/` (speech in and out), `speakable.ts`, `replySpeech.ts`,
  `voiceState.ts`; announcements in `announce.ts`.
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

- Duck answering Claude Code questions and plans, and promoting rules into Claude Code's
  own settings (T3).
- Git writes from Duck to your projects (left out of W2 on purpose). Duck commits only its
  own memory files, in its workspace (L1).
- Long-term memory in the app: built and tested (the index, the files and the commits in
  `memory.rs`, the recall note and the tools through the engine), not yet tried in a
  real thread, and the `clear_at` system message not yet sent to the real API. The
  consolidation (L2) is tested with a scripted answer; its Haiku call hasn't run against
  the API, and the hit rate needs two weeks of use before the embeddings decision.
- Skill offers: the consolidation queues them (`memory_state:skill_offers`); nothing
  offers them until S2.
- Self-development in the app (L3): built and tested with fakes (the config files and
  pins, the diff card, the brief, the branch read, the two-card merge, the rebuild
  command), not yet run for real: no Opus worker has made a branch to Duck through it,
  and nothing has been merged or rebuilt that way.
- The subscription brain in the app: built and tested with a fake process, and the same
  flags tried by hand against a stand-in MCP server (M3's As built), not yet through
  Workbench itself.
- Running the morning routine's Google half against real Google: sign-in, the copy and the
  cell writes are built and tested with fakes only.
