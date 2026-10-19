# Duck — architecture

How Duck (the D.U.C.K. assistant) is built, as it stands. The plan and the reasons
behind each decision are in `assistant-plan.md`. This file describes the code, and every
Duck step updates it as part of its Done when. Duck's self-development sessions (L3)
read it first.

Last updated: step A2 (2026-10-19).

## The shape

```
 surfaces ── Duck Protocol ──▶ engine (TS, main webview) ──▶ SDK ──▶ /anthropic proxy (Rust) ──▶ API
 (A3 drawer,  protocol.ts      engine.ts: the loop          client.ts   key, token, ledger, cap
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
| `index.ts` | `initAssistant()` (called from `App.tsx` with the other engines) builds the store, the registry and the engine; `getDuck()` returns the in-process transport. `endpoint()` maps protocol messages onto the engine. |
| `protocol.ts` | The Duck Protocol, version 1: `ClientMessage` (send, stop, confirm, thread.new, sync, thread.open) and `DuckEvent` (threads, history, thread, message, delta, tool, confirm, confirmed, turnState, error). `createLocalTransport` stamps `v`. |
| `engine.ts` | The loop. Pure helpers `toApiMessages`, `effectiveEffort` and `buildParams` are exported for tests. |
| `threads.ts` | `createThreadStore(backend)`: threads, messages (loaded per thread on first use) and parked tool batches, in memory and persisted. Appends to one thread are serialized so each gets the next `seq`. |
| `client.ts` | `getClient()` (the SDK at the proxy, with the launch token as its key), `purpose()`, `capMessage()`, `errorMessage()`, and `oneShot(name, input, {schema?})` for Haiku primitives. |
| `prompt.ts` | The frozen system prompt, `MAIN_MODEL` / `PRIMITIVE_MODEL`, and `PRIMITIVES` (one frozen prompt per Haiku job; the key is its `x-wb-purpose`). |
| `port.ts` / `port.local.ts` | `WorkbenchPort` and its one implementation over the stores. The only file under `src/assistant/` allowed to import `src/state/**` or `src/panels/**`. |
| `tools/registry.ts` | `defineTool({name, description, schema, tier, timeoutMs?, run})` and `createRegistry(tools)`: the API tool list sorted by name, built once; `tierOf(name)`. |
| `tools/getTime.ts` | The stub tool, `get_time` (read tier). |

### Rust: `src-tauri/src/assistant/`

| File | What it is |
|---|---|
| `mod.rs` | `Assistant` state (the DB, the launch token, the HTTP client), `init`, and the Tauri commands. |
| `key.rs` | The API key in Windows Credential Manager (`duck/anthropic-api-key`, `duck-dev/…` for debug builds). |
| `proxy.rs` | `/anthropic/{*path}` on the hook server: token check, CORS for the app's origins, endpoint allow-list, budget check, key swap, streaming forward, usage tap. |
| `usage.rs` | The price table, the stream meter, and ledger rows. |
| `budget.rs` | Limits, month-to-date spend, and the cap rule (at the cap only Haiku with a purpose other than `thread` passes). |
| `threads.rs` | Threads, append-only messages and parked batches in `duck.db`. |
| `db.rs` | `duck.db` / `duck.dev.db` and its append-only migrations. |

### Outside the Duck tree

- `src-tauri/src/window.rs` builds every webview (the main window and tear-offs) with
  one WebView2 profile, including the no-throttling args that keep the engine's timers
  running while the window is hidden. The debug build has its own profile folder.
- `src/App.tsx` calls `initAssistant()`; `eslint.config.js` holds the boundary rule.

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

## Not built yet

- The drawer (A3). Until then, the ◆ duck status-bar menu has a minimal "try duck" box
  (`src/panels/AssistantTry.tsx`) that speaks the protocol.
- Real tools (W1, W2), the trust policy (T1, which replaces `tierGate`), and effort
  routing (M2).
- The WebSocket transport (R1).
