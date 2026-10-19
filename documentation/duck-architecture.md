# Duck — architecture

How Duck (the D.U.C.K. assistant) is built, as it stands. The plan and the reasons
behind each decision are in `assistant-plan.md`. This file describes the code, and every
Duck step updates it as part of its Done when. Duck's self-development sessions (L3)
read it first.

Last updated: step A4 (2026-10-19).

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
| `index.ts` | `initAssistant()` (called from `App.tsx` with the other engines) builds the store, the registry and the engine; `getDuck()` returns the in-process transport. `endpoint()` maps protocol messages onto the engine and adds the spend (from a `SpendSource`: the ledger commands and `assistant-usage` events). |
| `protocol.ts` | The Duck Protocol, version 1: `ClientMessage` (send, stop, confirm, thread.new, thread.delete, sync, thread.open) and `DuckEvent` (threads, history, thread, threadDeleted, message, delta, tool, confirm, confirmed, turnState, spend, error). `createLocalTransport` stamps `v`. |
| `spend.ts` | `createTurnMeter()`: bills each metered `thread` call to the one turn that is calling (none if two are), giving each thread's latest turn cost for the `spend` event. |
| `engine.ts` | The loop. Pure helpers `toApiMessages`, `effectiveEffort` and `buildParams` are exported for tests. |
| `threads.ts` | `createThreadStore(backend)`: threads, messages (loaded per thread on first use) and parked tool batches, in memory and persisted. Appends to one thread are serialized so each gets the next `seq`. |
| `client.ts` | `getClient()` (the SDK at the proxy, with the launch token as its key), `purpose()`, `capMessage()`, `errorMessage()`, and `oneShot(name, input, {schema?})` for Haiku primitives. |
| `prompt.ts` | The frozen system prompt, `MAIN_MODEL` / `PRIMITIVE_MODEL`, and `PRIMITIVES` (one frozen prompt per Haiku job; the key is its `x-wb-purpose`). |
| `port.ts` / `port.local.ts` | `WorkbenchPort` and its one implementation over the stores. The only file under `src/assistant/` allowed to import `src/state/**` or `src/panels/**`. |
| `tools/registry.ts` | `defineTool({name, description, schema, tier, timeoutMs?, run})` and `createRegistry(tools)`: the API tool list sorted by name, built once; `tierOf(name)`. |
| `tools/getTime.ts` | The stub tool, `get_time` (read tier). |
| `tools/testConfirm.ts` | `test_confirm`, a consequential tool that does nothing, for trying the confirmation card. Registered in dev builds only. |

### Rust: `src-tauri/src/assistant/`

| File | What it is |
|---|---|
| `mod.rs` | `Assistant` state (the DB, the launch token, the HTTP client), `init`, and the Tauri commands. |
| `key.rs` | The API key in Windows Credential Manager (`duck/anthropic-api-key`, `duck-dev/…` for debug builds). |
| `proxy.rs` | `/anthropic/{*path}` on the hook server: token check, CORS for the app's origins, endpoint allow-list, budget check, key swap, streaming forward, usage tap. |
| `usage.rs` | The price table, the stream meter, and ledger rows. |
| `budget.rs` | Limits, month-to-date spend, and the cap rule (at the cap only Haiku with a purpose other than `thread` passes). |
| `threads.rs` | Threads, append-only messages and parked batches in `duck.db`; `delete` removes a thread with its messages and batches in one transaction. |
| `db.rs` | `duck.db` / `duck.dev.db` and its append-only migrations. |

### The desktop surface: `src/panels/Assistant/`

| File | What it is |
|---|---|
| `duckState.ts` | The desktop's one subscription to the protocol, an external store shared by the button and the drawer: threads, the open thread, loaded messages, streaming text, turn states, locally queued messages, confirmations, spend. Actions (`sendMessage`, `stopTurn`, `answer`, `openThread`, …) only send protocol messages. Persists `assistantDrawer` prefs (width, open thread, interrupt). |
| `view.ts` | `toItems(messages)`: stored messages → display items (user text, reply text, a tool chip with its result attached, notices; thinking and system messages hidden). `sessionLink()` reads `#session/<id>` links. |
| `DuckButton.tsx` | The title-bar button ("D.U.C.K.", the icon beside it): toggles the drawer, the acronym tooltip, a confirmation-count badge, an amber/red tint past the soft limit/cap. |
| `Drawer.tsx` | The drawer: header (thread list, new, settings, close), thread view (markdown replies, tool chips, queued bubbles), confirmation cards, spend line, composer (Enter / Shift+Enter / Esc, "think hard" = effort `high` for one message). Always mounted and only hidden, so the thread and scroll survive closing. |
| `DrawerSettings.tsx` | Queue-or-interrupt, and "start at login, minimized to the tray" (`@tauri-apps/plugin-autostart`; disabled in dev builds). |
| `DuckIcon.tsx` | The icon as a CSS mask in the accent colour; the eyeless version below 20 px. Images in `src/assets/duck/`. |

`src/panels/` is outside the boundary rule, so the drawer may use the stores directly
(it opens a `#session/<id>` link's console with `setActiveProject` + `openConsole` +
`activatePanel`). Everything it learns about Duck still comes through the protocol.

### Outside the Duck tree

- `src-tauri/src/window.rs` builds every webview (the main window and tear-offs) with
  one WebView2 profile, including the no-throttling args that keep the engine's timers
  running while the window is hidden. The debug build has its own profile folder.
- `src/App.tsx` calls `initAssistant()` and mounts the button and the drawer;
  `eslint.config.js` holds the boundary rule.
- `toggleAssistant` (default Ctrl+Shift+Space) is in `keyboard/keymap.ts`; the drawer
  registers its handler.
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
   - Each call is validated with its zod schema, then the gate decides:
     - `run` (default for the read and reversible tiers): runs now. All calls that may
       run do so in parallel, each within its time budget (default 10 s; a timeout
       becomes an `is_error` result and aborts the tool's signal).
     - `ask` (default for the consequential tier): the batch is **parked**, written to
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
3. Add it to `TOOLS` in `index.ts`.

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
- Real tools (W1, W2), the trust policy (T1, which replaces `tierGate`), and effort
  routing (M2).
- The WebSocket transport (R1).
