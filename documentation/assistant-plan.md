# Workbench — D.U.C.K. Assistant Plan

**Name (decided 2026-10-18): D.U.C.K.**, for *Dispatch, Understand, Coordinate, Keep watch*,
its four jobs. In the UI and speech it's "Duck" («Дак»). The rubber-duck mode is "talking to
the Duck". The rest of this document says "the Assistant", and code uses the generic
`assistant` module names, so the persona name lives only in the UI strings and the system
prompt.

A step-by-step plan for **the Assistant**: a personal AI assistant built into Workbench that
can operate the whole app (sessions, prompts, approvals, notes, git, panels), look things up
on the web, and use your real Firefox. It is reachable by **text or
voice**, on the **desktop and from the phone** through the existing remote. It runs on the
Claude API (the Max plan's $100/month of API credits, claimed into a linked Console
organization; they never draw on subscription limits, and when they run out requests stop
rather than bill the plan; verified against Anthropic's docs 2026-10-18): **Sonnet** is the main model you talk to,
**Haiku** does summaries and other primitive background jobs, and coding or other
professional work goes to a new **Workbench session running Opus**.

Companion to `claude-code-workbench-design.md` and `workbench-improvement-plan.md`. Same
working rules: **one step per session**, respect **Depends on**, honor the Definition of
Done, and append an **As built** note to a step when it lands.

Origin: research and design session, 2026-10-18, revised the same day after review
(natural TTS, the Firefox MCP already in use, GPU for speech, Discord dropped, a trust policy
so the Assistant can approve most things). The research findings (STT and TTS engines,
browser options, API surface) are condensed into §Design and §Research notes, so this
document stands on its own.

**Machine (measured 2026-10-18):** Ryzen AI 9 HX 370 (12 cores / 24 threads), 31 GB RAM,
NVIDIA RTX 4060 Laptop (8 GB VRAM) plus Radeon 890M iGPU. Languages: **you write and speak
English, Russian or Spanish (you're learning it); Duck always answers in English**, and
uses another language only when the conversation calls for it (a word being discussed or
translated, or an explicit request). Decided 2026-10-19, after Duck switched to Russian
mid-thread: the English voice is the better one, and a fixed reply language is predictable.

---

## Scope statement

**In scope**

| Track | What |
|---|---|
| **X — Spike** | Check the assumptions this plan depends on before building on them |
| **A — Core** | API key and local proxy, the agent loop, conversation storage, spend tracking, the Assistant drawer |
| **W — Workbench tools** | Tools that read and drive the app: sessions, prompts, approvals, transcripts, notes, git, panels; session summaries; memory |
| **D — Delegation to sessions** | Heavy work runs in Claude Code worker sessions on the subscription: briefs, a result-file contract, watching, follow-ups, usage-limit awareness |
| **T — Trust** | A configurable trust policy so the Assistant can approve most things itself, both its own actions and Claude Code permission prompts, with an audit log and a kill switch |
| **M — Models** | Per-session Claude Code model (`--model opus`); Sonnet main thread with per-message effort, Haiku workers, budget-aware degrade |
| **B — Web & browser** | Server-side web search/fetch; your real Firefox through the Firefox MCP bridge you already use |
| **V — Voice** | Push-to-talk dictation with local STT on the GPU; natural-sounding spoken replies (one voice on the desktop and the phone); read-aloud and screenshots; hands-free conversation mode with end-of-turn detection; proactive spoken updates when background work finishes |
| **L — Learning & self-development** | Long-term memory as readable files with a search index, daily consolidation, lessons from corrections; routines, a backed-up data repo and weekly housekeeping; Duck growing its own skills; improving its own prompts and code through Opus sessions, with you approving every merge |
| **P — Plan autopilot** | Duck runs your "step → `/compact` → continue" loop on a session and only comes back when something needs you; unattended runs with limits, windows, stall detection and a morning summary |
| **S — Modes & skills** | Chat and rubber-duck modes; user-defined skills and modes, so the Assistant can grow without code |
| **R — Remote** | The Assistant on the phone (chat + voice) through the existing remote server; the PWA as a real app (shortcuts, share target); later an Android companion app (assistant gesture, tile, widget, background conversation) |

**Out of scope (decided 2026-10-18):** an always-on wake word (opt-in later at most; see V1),
local LLMs, computer use (screenshots and clicks on the desktop), driving Claude Code agents
any way other than the PTY, cloud STT in v1 (left pluggable), **Discord** (dropped after
review: bots can't act for your account and self-bots are against Discord's ToS, so it
adds little over the phone remote), Playwright / Chrome browser automation (Firefox MCP
covers it), the system SAPI / `speechSynthesis` voices for spoken replies (tried in
Workbench; not natural enough).

**Supersedes:** `workbench-improvement-plan.md` listed *voice dictation* as out of scope
(2026-10-12). This plan brings it back in, but only as input to the Assistant (V1). Dictating
straight into a console stays out of scope; V1 makes it a one-line follow-up if wanted.

---

## Design

### What the Assistant is

**The founding principle** (reiterated 2026-10-18): **Duck is the front-facing session,
the one that faces you.** It is always there to talk to and to listen. It keeps the context,
makes the small calls, and **passes the work to background sessions whenever that makes
sense.** Everything else in this plan serves that:
- **Always available.**
  - Duck starts with Workbench. Workbench can start at login, minimized to the tray, so Duck
    is there whenever the PC is on.
  - It is reachable from the drawer, push-to-talk, conversation mode, and the phone (PWA,
    later the Android app).
- **Never busy.** Duck's own turns stay short. Anything that takes time is a background
  session (track D), an autopilot run (track P), or a background job (git lanes,
  consolidation). You can always talk to Duck while those run, and it tells you when they
  finish (V5).
- **Talks and listens:** text or voice in, text or voice out, your choice per moment
  (the Speak toggle, push-to-talk, hands-free).
- **Delegates by default:**
  - Heavy thinking, research, writing and code go to worker sessions on your subscription.
  - Primitive jobs go to Haiku.
  - Duck itself is for conversation, judgment, dispatch and reporting.

- One global assistant, not one per project. On the desktop, a **Duck button in the top-left
  corner** of the title bar opens a **drawer** over the dock (also toggled by a hotkey).
  Hovering the button shows a tooltip spelling out the acronym. On the phone it's an
  **Assistant tab**. Both views show the same thread.
- It does not write code itself. When a request is coding or other professional work, it
  starts or reuses a **Workbench session** (a real Claude Code console, Opus by default),
  writes that session's first prompt, and then reports on it. Status comes from the existing
  status engine and content from the transcript.
- The rest it handles itself: questions about what the agents are doing, summaries, approvals,
  queued prompts, notes, read-only git, web lookups and browser chores.
- **Goal for trust:** the Assistant approves most things itself, both its own actions and the
  permission prompts of the sessions it supervises. It does this under a policy you tune
  (track T), with every decision logged and one switch to pause it all.

### Where things run

The app's actions and live state all live in the **main webview** (TypeScript). Live status
exists only in `state/status.ts`; phone actions are carried out by `state/remoteActions.ts`;
consoles are spawned by the console panel. `Diff/reviewRun.ts` already drives an agent
end-to-end from TypeScript. So **the agent loop runs in TypeScript, in the main window**, and
its tools are plain function calls into the existing stores. A Rust loop would have to send
every tool call back to the webview anyway.

Rust owns what must stay out of JavaScript or needs native access: the API key, the
outbound proxy, spend accounting, audio capture, STT and TTS, MCP child processes
(Firefox bridge), and the remote endpoints.

```
 desktop drawer ──┐                       ┌── Rust ─────────────────────────────────────┐
 phone tab (WS) ──┼─▶ main webview (TS)   │ /anthropic proxy ── api.anthropic.com       │
 push-to-talk ────┘   assistant engine ──▶│   key from OS keychain, launch token,       │
   │                  (loop, tools,       │   usage → assistant_usage, budget cap       │
   │                   trust policy,      │ voice: cpal → STT (GPU, lazy)               │
   ▼                   threads)           │        TTS (GPU, lazy) → audio out          │
 STT (Rust) ── text ───────┘ ▲            │ MCP host (rmcp): Firefox bridge, lazy       │
                           │ │            │ remote: /api/assistant WS, /audio up/down   │
                           │ └ hook-event └─────────────────────────────────────────────┘
                           ▼   (PermissionRequest → trust policy)
        existing stores: registry, consoles, status, pendingChoice,
        promptDelivery/queue, remoteActions, transcript, notes, git, dock
```

### Separable, not separate (decided 2026-10-18)

**Question:** should Duck be split out of Workbench from the start, so it can later be
reached in other ways?

**Answer: build it inside Workbench now, behind boundaries that make extraction a
mechanical job later.** Splitting now would cost a lot for little gain:
- Duck's value is driving Workbench. Live status, pending choices, consoles and prompt
  delivery all live in Workbench's main webview. As a separate process, Duck would need a
  control API covering all of that, plus a second always-running app on a PC where RAM is
  scarce.
- Every way you'd reach Duck (desktop, phone, the Android app below) already goes through
  Workbench's remote server. A separate Duck process would sit behind the same server
  anyway.

**The four boundaries, enforced from step A2:**
1. **`WorkbenchPort`** (`src/assistant/port.ts`) is the *only* way Duck touches the app.
   - It is a typed interface: `listProjects`, `listSessions`, `liveStatus`, `onStatus`,
     `pendingChoice`, `createSession`, `sendPrompt`, `answerChoice`, `readTranscript`,
     `notes.*`, `git.*`, `ui.openPanel`, `usageLimits`, …
   - Today one implementation, `port.local.ts`, calls the existing stores.
   - An ESLint `no-restricted-imports` rule forbids anything else under `src/assistant/**`
     from importing `src/state/**` or `src/panels/**`.
   - Extracting Duck later means writing `port.remote.ts` over Workbench's remote API.
2. **Duck Protocol** (`src/assistant/protocol.ts`): one versioned message set (send, delta,
   tool, confirm, task, trust, tts, turnState, …) that **every surface** speaks. The desktop
   drawer uses an in-process transport, the PWA and the Android app a WebSocket. A new
   surface is just a new transport.
3. **Duck's own state:**
   - Its own SQLite file `duck.db` (`duck.dev.db`), with its own migrations, instead of
     tables in `workbench.db`. Workbench's DB gains only the `owner` column on instances.
   - Its own prefs file and keychain namespace (`duck/anthropic-api-key`,
     `duck/google-tts-key`; `duck-dev/…` for the debug build).
4. **Rust side in its own module trees**: `src-tauri/src/assistant/` (proxy, budget,
   threads, MCP host, workspace) and `src-tauri/src/voice/` (capture, STT, TTS, playback,
   screen). They depend on Workbench code only through a small trait, and can become their
   own crates in a cargo workspace when needed.

**When extraction would be worth it:** if you want Duck while Workbench isn't running, on
another machine, or controlling things beyond Workbench. The path then: Duck core runs
headless (a Node or Rust process), `WorkbenchPort` goes over the remote API, and Workbench
becomes one more Duck client.

### Calling the API without exposing the key

- The key is stored in the **OS keychain** (a Windows Credential Manager generic credential,
  read with `CredReadW`), never in prefs, SQLite, process env or JavaScript.
- The **hook server** (already `127.0.0.1`, axum) gets an `/anthropic/*` route that forwards
  to `api.anthropic.com`. It swaps the real key in and streams the SSE response back
  unchanged (`reqwest`, already in `Cargo.lock` through Tauri). It answers the CORS preflight
  for the webview origin.
- The webview uses the **official TS SDK** (`@anthropic-ai/sdk`) with
  `baseURL = http://127.0.0.1:<port>/anthropic` and `apiKey = <per-launch random token>`. The
  proxy accepts only that token, so no other local process can spend the credits.
- The proxy reads `usage` from the stream (`message_start`, `message_delta`) and records
  every call in `assistant_usage` (model, tokens by kind, server-tool counts, cost, purpose).
  This gives a single place to enforce the **monthly hard cap**: over the cap the proxy
  refuses, and the engine says so instead of failing silently.
- Rejected alternative: the key in prefs, sent from the webview with
  `dangerouslyAllowBrowser`. The webview renders untrusted transcript and web content, and a
  leaked billing key is expensive.
- **Guardrail:** the key must never reach a child process environment. If
  `ANTHROPIC_API_KEY` were inherited, Claude Code consoles would switch from the
  subscription to API billing.

### Models and routing

**Decided (2026-10-18): Sonnet is the main model.** It talks to you, interprets requests and
acts. Haiku does only the background "primitive" jobs, each a separate one-shot call with its
own prompt. Fewer misrouted commands and wrong actions matter more than the per-turn
saving, especially once the Assistant approves things on its own. (This replaces the earlier
Haiku-front-door design.)

| Role | Model | Settings | Why |
|---|---|---|---|
| **Heavy work**: research, analysis, comparisons, long writing, browser chores, code | **Worker session** (Claude Code console on your subscription): Sonnet for research and writing, Opus for code and professional deliverables | `--model` per task; runs in Duck's workspace or the target project | Moves the expensive tokens off the API credits. Duck only reads the result file. |
| **Main thread**: every request, voice or text; acting on the app; quick lookups; dispatching and judging workers; chat and rubber duck | `claude-sonnet-5-5` | adaptive thinking; effort **`medium`** by default (decided 2026-10-18 after X0 measured it no slower and no costlier than `low`), **`high`** for multi-step work and rubber duck (per-message effort, so the cache survives); `fallbacks: "default"` | Far more reliable tool use and judgment. One model on the thread means one prompt cache. |
| Session summaries, "what happened while I was away" | `claude-haiku-5-5` | effort `low`, one-shot | Reads a lot, writes little; needs no judgment |
| Read-aloud rewrites (narrate / summary), screenshot text extraction | `claude-haiku-5-5` | effort `low`, one-shot | Transformations, not decisions |
| Trust judge (rule-less permission prompts) | `claude-haiku-5-5` first; **Sonnet second opinion** when Haiku isn't sure (below) | structured output | Volume is high (hundreds a day); the floor and rules carry the safety; Sonnet only for the unclear minority |
| Coding or professional deliverables | Claude Code session with **Opus** | `claude --model opus` in a Workbench console | Uses Claude Code's own auth (the subscription when logged in that way), not the API credits |

- **Heavy work goes to Workbench sessions, not the API** (decided 2026-10-18; §Offloading
  heavy work to sessions, track D). Duck's own thread is for talking to you, deciding and
  dispatching. Research, analysis, long writing, browser chores and code run in Claude Code
  **worker sessions** on your subscription. Duck watches them and reports the result.
- Reading-heavy chores that are too small for a session ("summarize these 6 sessions") go to
  Haiku through a `haiku_task` tool, so long transcripts never enter the main context.
- **Effort carries the cost control, not model switching.**
  - Sonnet runs at `medium` effort by default. X0 measured it as fast as `low` (0.72 s to
    first output) and no costlier (~$0.005 a warm turn), with 20/20 correct tool picks.
  - The engine raises effort to `high` for a message that asks for research, planning or a
    browser task, and for rubber-duck threads. It uses the per-message effort system message
    (beta `mid-conversation-output-config-2026-07-01`), so the cached history isn't thrown
    away.
- **Two brains, one Duck: the API by default, the subscription as the fallback** (decided
  2026-10-18). The main thread runs behind a `Brain` interface with two backends:
  - **`ApiBrain`** (default): the SDK through the proxy, as described above. The API credits
    expire every month with no rollover, while subscription limits are what your coding
    sessions run on, so the credits are the right thing to spend first.
  - **`SubscriptionBrain`**: one persistent headless Claude Code process, `claude -p
    --input-format stream-json --output-format stream-json --model sonnet --effort medium
    --tools "" --strict-mcp-config --mcp-config <duck> --system-prompt-file <duck prompt>
    --permission-mode dontAsk --allowedTools mcp__duck --no-session-persistence`. It bills
    your subscription limits (allowed for headless use as of 2026-10; Anthropic paused moving
    it onto credits). Duck's tools reach it through a **Duck MCP server** on the loopback hook
    server (streamable HTTP, per-launch token), which forwards each call to the same tool
    registry in the webview, so the trust engine and the 10 s tool budget apply unchanged.
    `--bare` can't be used: it disables subscription (OAuth) auth.
  - **Switching** (in a new thread with a short handoff summary, since histories and caches
    don't carry over):
    - API spend reaches the **soft limit (80%)**, or the API answers "credit balance too
      low" → `SubscriptionBrain`, provided the subscription is below D2's thresholds (5-hour
      < 70%, weekly < 80%).
    - The subscription is over those thresholds too → a Haiku API thread, as before, with
      Sonnet available per message (a "Sonnet" toggle or "think hard") and the turn's cost
      shown.
    - At the **hard cap ($90)** the proxy refuses everything except Haiku primitives; the
      main thread stays on `SubscriptionBrain` if the subscription allows it, otherwise only
      primitives run.
    - The reverse also holds: while the subscription is near its limits, Duck never moves
      onto it.
  - The drawer shows which brain is answering ("on subscription" chip). X0 measured the
    subscription backend's latency and limit cost (see X0 As built).
- **Opus sessions** start when the output is code, a document or other professional work
  product.
- **API constraints** (as of 2026-10): no forced `tool_choice` on Sonnet 5.5, so use `auto`
  and steer from the prompt. Thinking can't be disabled on Sonnet 5.5; Haiku 5.5 runs adaptive
  by default. Always check `stop_reason` (`refusal`, `max_tokens`, `pause_turn`) before running
  tools. Keep history **append-only** (thinking blocks are bound to the conversation). Hold
  tools and the system prompt stable and byte-identical for caching.

### Spend

### Offloading heavy work to sessions

Duck is the **front of house**: it talks to you, keeps the context, makes the small decisions,
and dispatches. The thinking-heavy work runs in Claude Code **worker sessions**. These are
ordinary Workbench consoles driven through the PTY, so they run on your monthly
subscription, not the API credits. Duck already gets their status from the hooks and their
content from the transcripts, so it knows when a worker is done and can report back.

**When Duck offloads** (rules in its system prompt, with examples, tuned in X0):

| Do it directly (API) | Offload to a worker session |
|---|---|
| Status questions, app actions, approvals, notes | Research needing more than one or two lookups |
| One quick lookup (`web_fetch` one URL, one search) | Comparisons, analyses, plans, reviews |
| Summaries, read-aloud rewrites, screenshots → **Haiku** | Writing longer than a few paragraphs |
| Conversation, rubber duck, deciding what to do next | Browser chores (Claude Code already has your `firefox` MCP) |
| | Anything that produces code or a professional deliverable (Opus, in the real project) |

**How a worker task runs:**
1. **Brief.** Duck writes the task as a brief. A task folder is created:
   `<duck-workspace>/tasks/2026-10-18-tauri-v3-migration/brief.md`.
2. **Spawn.** `create_session` (W2) starts a console in **Duck's workspace** or, for code, in
   the target project's worktree.
   - The workspace is **`C:\Users\mrsha\repos\Duck`** (created 2026-10-18), registered as
     the Workbench project "Duck". The debug build uses the sibling `Duck.dev`, never a
     subfolder, because Claude Code would load the parent's `CLAUDE.md`.
   - The model and effort come from the task's **tier** (below), passed as
     `claude --model … --effort …` (both flags exist in Claude Code 2.1.302).
3. **Output contract.** The brief tells the worker to finish by writing `result.md` (headline,
   findings, sources, open questions, a suggested next step) and a tiny `result.json`
   (`{status: done|blocked|needs_decision, headline, question?}`). Duck reads those files,
   not the scrollback, which makes the hand-off reliable.
4. **Watching.**
   - `wait_for_session` (W2) fires on `done` / `needs_you`.
   - "How's it going?" gets a Haiku summary of the transcript so far.
   - The worker's questions (`AskUserQuestion`) go to **Duck first**. As the worker's
     "user", Duck answers from the conversation context, or brings the question to you.
   - Permission prompts go through the trust policy (T2).
5. **Report.**
   - Duck reads `result.json` / `result.md`, tells you the headline (spoken, if you asked by
     voice) and offers detail or read-aloud.
   - It can send **follow-ups to the same session** ("dig into option 2"); the worker keeps
     its context.
   - Once you're done with it, the console closes; the transcript and task folder stay, and
     the session can be resumed.

**Worker tiers.** Duck picks a tier per task (decided 2026-10-18):

| Tier | Worker | Use for |
|---|---|---|
| **standard** | Sonnet, effort `medium` | The default. Single-topic research, short write-ups, browser chores, gathering facts |
| **involved** | Sonnet, effort `high` | Multi-source comparisons with trade-offs, longer documents, analysis over several inputs |
| **serious** | Opus, effort `medium` | High-stakes decisions, architecture, anything you call important or "deep", code and professional deliverables |

- Duck states the tier on the task card ("Sonnet · high"), so you see the choice.
- Phrases override it: "quick" pushes one tier down; "thoroughly" / «подробно» one up;
  "this is serious" / «это важно» → serious. So does an explicit model or effort.
- If a standard worker's result comes back thin, Duck may offer to re-run it one tier up in
  the same session, as a follow-up prompt at a higher effort.
- Tiers are data (a table in Duck's settings), so their models and efforts can be retuned
  without code.

**Keeping workers quiet and safe:**
- Duck's workspace has its own `.claude/settings.json` **allow list**: WebSearch, WebFetch,
  Read/Write/Edit inside the workspace, and the read-only Firefox tools. So most worker
  prompts never appear. Anything else goes through the trust policy like any other session.
- Workers in the workspace run with `--permission-mode dontAsk`: exactly the allow list,
  everything else is a hard deny that the worker sees as a tool error. **Not `auto`:** in X0
  its classifier approved `git push --force origin main` and an `rm -rf` outside the folder.
  Workers in real projects use that project's normal mode and rules, with the trust floor
  applying under every mode.
- Workers owned by Duck **don't ping you** (notification and push). Their needs-you goes to
  Duck, which escalates only what it can't handle.
- They are grouped under the Duck project in the instance manager, labelled with their task,
  so you can open any of them and watch or take over.
- **At most 2 workers at once** by default (each Claude Code process costs a few hundred MB
  of RAM on an already busy PC). More are queued.

**Subscription limits are the new budget.** Offloaded work is free in API terms but counts
toward your Claude Code 5-hour and weekly limits, which your own coding sessions share.
- Duck reads them with the existing `usage_limits` command.
- Below 70% of the 5-hour window and 80% of the weekly one, it offloads freely.
- **Above that, it runs the task on the API instead, automatically** (decided 2026-10-18;
  expected to be rare). This is an **API worker**: the same brief and result contract, run
  as a Sonnet sub-loop with web tools at the tier's effort. Serious-tier tasks use Opus
  5.5. The task card says "API · over subscription limit" with the cost. It still respects
  Duck's API soft limit and cap.
- So it never quietly eats the limit your own sessions need, and never stalls waiting for a
  reset.

**Trade-offs:**
- **Latency:** a worker takes a few seconds to start and longer to finish. That's fine for
  heavy tasks; quick things stay on the API.
- **Per-task overhead:** Claude Code carries a large system prompt, which is why small
  things stay on the API.
- **Conversation itself** (chat, rubber duck) stays on the API by default for snappy turns.
  A *session-backed* rubber-duck mode, where a Sonnet/Opus session does the thinking and
  Duck relays voice in and out, is an optional experiment (D3).

**What a Sonnet main thread costs.** Prices: Sonnet 5.5 is $2 in / $10 out per MTok; cache
reads $0.10 (the pricing page, checked 2026-10-19); cache writes $2.50 (5-minute TTL) or $4 (1-hour TTL). Haiku 5.5 is $0.10 /
$0.50. A command turn is 2–3 rounds over a ~10k-token prefix (system + tools), plus ~1k
output tokens including thinking:

| Per command turn | Haiku | Sonnet (`medium` effort) |
|---|---|---|
| Warm cache | ~$0.002 | **~$0.02** |
| Cold cache (first turn after a break) | ~$0.004 | **~$0.05–0.08** |

So **Sonnet costs about 8–20× more per command.** (These are the pre-X0 estimates the table
below is built on. X0 measured warm one-turn requests at **$0.005 (Sonnet `medium`)**, $0.007
(`low`) and $0.0004 (Haiku) over a 4.3k-token prefix, so the totals below are conservative.) In money, a monthly estimate (30 days):

| Workload | Per unit | Moderate use | Heavy use |
|---|---|---|---|
| Sonnet command turns | ~$0.02–0.03 | 30/day → **~$25** | 80/day → **~$65** |
| Heavy tasks (research, browser, writing, code) | **worker sessions: $0 API**, counted against your subscription limits | 3/day | 8/day |
| Dispatch + reporting overhead per worker task (brief, reading `result.md`, follow-ups) | ~$0.02–0.04 | **~$3** | **~$10** |
| Quick API lookups (one search/fetch) | ~$0.02–0.03 | 5/day → **~$4** | 15/day → **~$12** |
| Chat / rubber duck on Sonnet | ~$0.005–0.01 per turn | 30 min/day → **~$7** | 1 h/day → **~$15** |
| Haiku primitives (summaries, narrate, screenshots, workers) | ~$0.001–0.003 | **~$5** | **~$10** |
| Trust judge (Haiku, plus Sonnet second opinions for ~15% of cases) | ~$0.0005 / ~$0.005 | **~$5** | **~$10** |
| TTS (local Kokoro + Silero; Chirp optional) | — | $0 | $0 |
| Opus coding sessions | API $0 (subscription) | — | — |
| **Total** | | **~$50 / month** | **~$130 / month**, so the soft limit trips in the last week |

**Verdict:** with heavy work offloaded to sessions, a Sonnet main thread **fits the $100
comfortably at moderate use.** What's left is mostly Duck's own command turns, so the levers
below matter most on heavy months:
- **Prompt caching done properly.**
  - A **1-hour cache TTL** on the system + tools prefix, so a gap between requests doesn't
    re-write the 10k prefix each time. That costs 2× on writes and saves most cold starts.
  - Automatic caching on the conversation tail.
  - A deterministic tool order, and no timestamps in the system prompt.
- **A small fixed prefix.** Browser and rarely used tools are `defer_loading` behind **tool
  search**. Old tool results are cleared by context editing (`clear_tool_uses`).
- **`medium` effort by default**, raised to `high` per message only when needed.
- **A Haiku worker for reading-heavy chores**, so Sonnet never ingests whole transcripts.
- **Degrade, don't stop**: past 80% (the soft limit) the main thread moves to the
  subscription brain (or a Haiku thread when the subscription is busy too), and only
  primitives use the API at the $90 cap.
- A spend meter in the drawer: today, this month, by model and by purpose, plus a
  **projection** ("on track for $74 this month").
- X0 and the first two weeks of use **measure real per-turn costs** from `assistant_usage`.
  If the averages run high, the effort defaults and caching are tuned before anything else.

### Tools

The tool surface is about 25 hand-written tools in `src/assistant/tools/`, all wrapping
existing store functions. Each tool declares a **default tier**, which only matters when no
trust rule matches:

| Tier | Examples | Default when no rule matches |
|---|---|---|
| **read** | list projects/sessions, live status, pending choice, transcript tail, usage limits, git status/log, read note | run |
| **in-app, reversible** | send or queue a prompt, start/resume a console, open panel/focus, create note, create session | run; logged as a chip, with an Undo where one exists |
| **consequential** | answer a permission prompt, interrupt or stop a session, write or delete a note, git commit/push, browser submit/purchase/login | the trust policy decides; with no rule, a **confirmation card** on the surface the request came from |

Every tool call and its outcome is stored in the thread, so "what did you do?" can be
answered from history.

### Trust policy

You want to trust the Assistant with most approvals. The safe way to get there is a policy
that is mostly **deterministic rules you can read**, with model judgment only for what the
rules don't cover. Every automatic decision is logged and reviewable, and gets tighter or
looser as you correct it.

**What it decides.** One engine (`src/assistant/trust/`) answers "allow, or ask a human?"
for two kinds of requests:
1. **The Assistant's own consequential tools**, keyed as `assistant:<tool>` with the tool's
   arguments.
2. **Claude Code permission prompts** in sessions. The `PermissionRequest` hook already
   carries `tool_name` and `tool_input` (they reach the frontend in `hook-event`), so the
   policy judges the structured call, not text read off the screen. On "allow" the engine
   answers through `answerChoice` (the existing keystroke module), choosing **"Yes" (once)**.
   It never chooses "don't ask again", which would write rules into Claude Code behind the
   policy's back.

**How it decides**, in order; the first step that answers wins:

| # | Layer | What | Can return |
|---|---|---|---|
| 1 | **Kill switch** | Global "Trust paused" (drawer, tray, phone, hotkey). Also trips by itself (row 6). | ask |
| 2 | **Floor** | A short built-in list that always asks, whatever the rules say (one named exception: Duck pushing its *own data repo* to its private remote, never forced; L4). Examples: `git push --force` and any push to `main`/`master`; deleting branches; `rm -rf` or writes outside the project or worktree; reading or writing `.env*`, `~/.ssh`, credential stores; `curl … \| sh`-style installs; `npm publish` / `cargo publish`; browser login, payment or purchase; anything that sends a message to a person. Editable, but changes need a deliberate confirm. | ask |
| 3 | **Rules** | Your rules, in Claude Code's own syntax so they read the same: `Bash(npm test:*)`, `Bash(cargo build:*)`, `Edit(src/**)`, `WebFetch(domain:docs.rs)`, `assistant:interrupt_session`, `assistant:write_note`. Scoped global or per project; `allow` / `ask` / `deny`. | allow / ask / deny |
| 4 | **Mandate** | A session the Assistant started records the request it came from ("fix the failing auth test in X"). Within that session, rule-less calls that plainly serve the mandate go to the judge with that context; calls outside it ask. | → judge / ask |
| 5 | **Judge** | One Haiku call with structured output: `{decision: allow \| ask, risk: low \| medium \| high, reason}`. Input: the project, the session's mandate or last user prompt, the tool call (wrapped as untrusted data), and the matching rules nearby. Only `allow` + `low` risk is accepted. The judge **cannot deny**, because denying interrupts the agent's work; uncertain means ask. Cost ≈ $0.0005 per call. | allow / ask |
| 6 | **Rate guard** | More than N automatic approvals for one session in 10 minutes (default 30), or 3 judge "high risk" verdicts in a row, pauses trust for that session and notifies you. | ask |

`deny` (from a rule) sends Esc. In practice you'd use it only for things the agent should
never try, for example `Bash(git push --force:*)`.

**Native rules where possible.** Claude Code's own permission settings (and permission
modes, see X0) stop a prompt from appearing at all, which is faster and more robust than
answering it with keystrokes. So the policy can **promote** a rule: after you've approved the
same pattern a few times, it offers to write it into the project's
`.claude/settings.local.json` `permissions.allow`. The Assistant's policy then handles only
the remainder.

**Questions and plans.** A Claude Code question (`AskUserQuestion`) is answered by the
Assistant only when the session has a mandate *and* you delegated decisions ("handle it, don't
ask me"). Otherwise it is forwarded to you with the Assistant's suggested answer. A plan
approval goes to a Sonnet review against the mandate first; the policy decides whether that
review is enough, or whether you see the plan with the review attached.

**Audit.** Every automatic decision goes into `assistant_decisions` (time, session, tool,
input, layer that decided, rule or judge reason). The drawer has a **Decisions** view
("auto-approved today: 23"). Each row has **Make a rule**, **Always ask for this** and
**Undo** where possible. A daily one-line digest is optional.

**Untrusted input.** Transcripts, tool inputs and web pages are data. They are wrapped and
labelled as such, and the system and judge prompts say they never carry instructions. The
**floor** is the real defense: injected text can sway the judge, but it cannot get past rows
1–2, and the judge cannot deny.

**Rollout.** Start in **shadow mode**: the policy decides and logs, but still asks you. The
Decisions view shows where it would have acted. Switch it to live per project once its calls
match yours.

### Voice

- **Desktop: push-to-talk**, a global hotkey (works when Workbench is not focused) through
  `tauri-plugin-global-shortcut`. No always-on mic.
- **Capture in Rust** with `cpal` (no WebView2 mic-permission flow, works with the window
  hidden), resampled to 16 kHz mono. Silero VAD trims silence and detects the end of an
  utterance in hands-free "conversation mode".
- **STT engine:** `transcribe-rs` (MIT, used in production by Handy, a Tauri v2 dictation
  app) running **NVIDIA Parakeet TDT 0.6B v3 (ONNX) on the RTX 4060**, with the CPU as
  fallback.
  - On your own recordings (X0): 3.4% WER in English and 0% in Russian.
  - On the GPU through ONNX Runtime's **CUDA** execution provider (`ort-cuda`): ~0.1 s per
    command (measured), almost no CPU. It measured 3.6 GB VRAM, which V1 brings down.
  - **DirectML** (`ort-directml`) is the fallback if the CUDA runtime DLLs are a problem; it
    needs no install, and it also runs on the Radeon iGPU.
  - The CPU path (int8, 3 threads: 0.4–0.8 s per command on the Ryzen AI 9 HX 370) stays as
    the fallback when the GPU isn't available.
- **Mixed-language speech.** Russian with English terms ("запусти тесты в backend-сессии") is
  how you'll actually talk to it. X0 compared Parakeet with Whisper large-v3-turbo on your
  recordings: **Parakeet won** (Whisper was worse in Russian and 5× slower), and both write
  English terms in Cyrillic («пул реквест»). Duck's model reads those fine; a name fixer maps
  your project and session names back (V1).
- **Spanish** (added 2026-10-19) is a supported input too. Parakeet v3 covers it, but X0
  recorded no Spanish, so V1 adds a few Spanish clips to its check. Replies stay English
  (see Languages above), so no Spanish voice is needed.
- **Resource rules (the GPU is a laptop dGPU):**
  - Nothing loads at startup. The model loads when the hotkey goes down, in parallel with
    recording; waking the sleeping dGPU (Optimus) adds ~0.6 s (X0).
  - It stays loaded while the drawer is open or conversation mode is on, and unloads after 3
    minutes idle. Unloading frees the VRAM and lets the dGPU go back to sleep (battery).
  - A pref "GPU for voice: always / on AC power only / never" (default: on AC only; on
    battery the CPU int8 path with 3 threads at below-normal priority).
  - Models download on first use, with progress, and are never bundled.
- **Phone:** the PWA records with WebAudio, downsamples to **16 kHz 16-bit PCM WAV** on the
  phone (30 s ≈ 1 MB), and uploads to the desktop, which runs the same engine.
  - This avoids Opus/WebM decoding in Rust entirely.
  - The mic needs a secure context, so it works over the Funnel/HTTPS address, not the plain
    tailnet IP.
  - The phone keyboard's own dictation also works in the text box, as a free fallback.

### Spoken replies (natural TTS)

The system voices (SAPI / `speechSynthesis`) are out: not natural enough. The research
(2026-10-18, details in §Research notes) found:

- **No single *local* open model is proven to sound natural in Russian as well as English.**
  - Kokoro-82M is the best small English model, but has no Russian.
  - Silero v5 Russian has real neural stress and intonation, but is PyTorch-only (a Python
    sidecar) and licensed **non-commercial** (fine for personal use).
  - Qwen3-TTS 0.6B does both languages in one voice under Apache-2.0 and streams, but its
    Russian stress quality is unverified and its Rust ports are experimental.
- **Mixed sentences break a two-engine split.** A Russian reply about `npm test` in the
  `backend` session goes wrong when routed sentence by sentence between an English and a
  Russian engine. A single multilingual voice handles it in one pass.
- **The best cloud voices are effectively free at this volume.** About 200 short replies a
  day is ≈ 0.9M characters a month.
  - Google **Chirp 3 HD** is free up to 1M characters a month (then $30 per 1M), with LLM-grade
    naturalness, ru-RU and en-US, and streaming.
  - Azure Neural has a free tier of 0.5M a month, and its *multilingual* voices switch EN/RU
    inside a sentence.
  - Cloud TTS uses 0 RAM, 0 VRAM and no model download, which suits a PC where resources are
    precious.

**Decided after X0's listening test (2026-10-19): local Kokoro for English, local Silero
(`kseniya`) for Russian, behind one `Speaker` trait** (step V2):

| Engine | Role | Where | Measured in X0 |
|---|---|---|---|
| **Kokoro v1.0, voice `af_heart`** | **default, English** (expected to be nearly all use) | CPU | first audio 0.18 s, real-time factor 0.19; won the listening test by a wide margin; reads digits, money, dates and versions correctly |
| **Silero v5_6_ru, speaker `kseniya`** | **default, Russian** (an occasional extra) | CPU, loaded only when a Russian sentence comes up | real-time factor 0.04; best Russian pronunciation and stress in the test; **silently drops anything non-Cyrillic, digits included**, so it only ever receives speakable text (below); licence CC BY-NC, fine for personal use |
| Google Chirp 3 HD | optional, off by default | cloud | ~1.1 s per reply, one voice in both languages; kept as a settings choice and as the fallback if the local runtime fails (key already in the keychain as `duck/google-tts-key`) |
| ~~Qwen3-TTS 0.6B~~ | dropped | GPU | first audio 15.8 s, slower than real time, no Russian voice at 0.6B |

- **Speakable text is mandatory for Russian.** Sentences routed to Silero must have numbers
  written out in words with the right case («в четырнадцать тридцать», «тысячу двести
  пятьдесят рублей») and English terms respelled in Cyrillic («бэкенд», «пулл реквест»).
  - When Speak is on, the voice-mode system note asks the model to write Russian replies
    in that form directly, which costs nothing extra and gets the grammar right where a
    rule-based converter wouldn't.
  - A safety pass in the sentence pipeline catches anything left (a digit or Latin letter
    in a Silero-bound sentence) with a one-sentence Haiku rewrite (~$0.0002), falling back
    to a rule-based pass (number-to-words plus a respelling dictionary) when offline.
  - English gets a light rule pass for the few things Kokoro reads oddly ("3.5" →
    "three point five", "PR #128" → "PR number 128").
- **Mixed sentences** (Russian with English terms) go to Silero after respelling; a sentence
  with no Cyrillic goes to Kokoro.
- **Resources:** both engines run on the CPU in one `uv`-managed Python sidecar (X0
  measured 1.4 GB RSS with both loaded; English-only is lighter because Silero loads lazily).
  The sidecar is killed after 5 minutes idle. Moving Kokoro in-process via `sherpa-onnx` is a
  later optimisation, not a requirement.
- The desktop speaks through Rust (`rodio`), sentence by sentence, starting on the first
  sentence while the rest is synthesized.
- **One voice everywhere:** the desktop synthesizes and the PWA plays it (`GET
  /api/assistant/tts/<id>`, compressed Opus/MP3, cached per message so a replay costs
  nothing). The phone's native TTS stays a per-surface alternative and the offline fallback.
- **Workbench's existing "speak selection"** (Ctrl+Shift+L, `src/util/speech.ts`, today
  `speechSynthesis`) moves to the same engine, so the app has one voice.
- When the input was voice, a system note tells the model to answer in one or two
  speakable sentences and keep detail in the text.

**Volume no longer matters.** With local engines there's no quota and no per-character cost,
so long read-aloud is free. Chirp, when chosen, still counts characters against its free
1M a month (≈ 18 hours) and never pays silently.
- Read-aloud still speaks a *speakable* version by default (below), not raw transcript text:
  code, diffs and tool output aren't worth hearing.

### Read-aloud and screen reading

New Assistant abilities (step V3):

- **`read_aloud(source, mode)`**
  - Sources: a session's last response or last N turns, a summary, a note, a web page
    (Firefox bridge or `web_fetch`), the current selection in the app, or text from the
    screen.
  - Modes:
    - **summary**: Haiku condenses first. The default for sessions.
    - **narrate**: a Haiku rewrite into speakable prose. Code becomes "it changed the login
      handler in auth.ts", paths and identifiers are spoken naturally, and tool calls are
      summarized ("ran the tests, 3 failed"). Cost ≈ $0.001.
    - **verbatim**: for notes and prose you want word for word.
  - Playback is interruptible (hotkey / Esc / phone button), with "pause", "skip to next
    section" and "slower". Position is remembered, so "continue reading" works.
- **`screenshot(target, question?)`**
  - Targets: the active window, a given monitor (you have several, including DisplayLink
    screens), a window by title, or all monitors.
  - Captured in Rust with the `xcap` crate (Windows Graphics Capture / GDI; multi-monitor
    and per-window). Downscaled to ≤ 1568 px on the long edge, and kept only in memory and
    the thread.
  - Sent to **Haiku as an image** (≈ 1.5–3k tokens ≈ $0.0003 each). Haiku answers the
    question ("what does this error say?") or extracts text for `read_aloud`.
  - For long, dense text where every word matters, the Windows built-in OCR
    (`Windows.Media.Ocr` through the `windows` crate) is a free local option. **Checked
    2026-10-18: `en-US` and `ru` recognizers are installed.** This is a different Windows
    component from the voices behind Workbench's "speak selection", which is TTS, not OCR.
  - Trust tier: **in-app**. You'll see a brief "screenshot taken (monitor 2)" toast every
    time. A trust rule can make it ask, for example when it wasn't your request in the same
    turn.
  - Combined: "take a screenshot of the right monitor and read me the error" →
    `screenshot` → `read_aloud(mode: verbatim)`.

### Hands-free conversation mode

Push-to-talk stays for quick commands. **Conversation mode** is the hands-free alternative,
for chatting and rubber-ducking: you just talk, and the Assistant works out when you've
started and when you've *finished*, not merely paused.

**How it decides you're done.** Three layers, all local:

| Layer | What | Cost |
|---|---|---|
| **1. VAD: are you speaking?** | **Silero VAD** (~2 MB ONNX) on 32 ms frames: detects the start of speech and each pause. The mic is open only while conversation mode is on. | well under 1% of one CPU core |
| **2. Turn detector: is this pause the end of your thought?** | **Smart Turn v3.2** (Pipecat, BSD-2-Clause, ~8 MB ONNX, 23 languages including Russian). It listens to the *audio* of the last few seconds (intonation, trailing-off, a mid-sentence "и…" or "so…") and returns P(turn complete). It runs only when the VAD sees a pause of 200–300 ms. | ~12–40 ms on CPU per pause |
| **3. Patience ceiling** | If the turn detector says "not done", keep listening. Send anyway only after a long silence that depends on the mode: assistant ~1.5 s, chat ~3 s, **rubber duck ~8 s** (configurable). | — |

**Measured in X0 on your thinking-aloud monologues:** Smart Turn calls most mid-thought
pauses "complete", so for thinking aloud *silence length* does the work. Rubber duck asks
Smart Turn only after ≥ 3 s of silence (threshold 0.8, ceiling 8 s): 1 false end in 11
minutes, replying ~3 s after you stop. Chat uses the patient policy (from 1.5 s, threshold
0.7): ~1 false end every 36 s, each absorbed by the grace window. The quick policies are for
short commands.

**What stops it cutting you off mid-thought:**
- **Mode-aware patience.** Rubber-duck mode expects long pauses and waits for the turn
  detector *and* a longer silence.
- **Grace window with merge.**
  - When it decides you're done, it plays a soft cue and starts STT + the model call at once
    (low latency).
  - If you start speaking again within ~2 s, it **cancels the in-flight reply** (aborts the
    API request) and **appends** your continuation to the same turn.
  - So a wrong guess costs a fraction of a cent, never a lost thought.
- **Verbal controls** (detected in the transcript, both languages):
  - "wait / подожди / hold on" keeps the turn open with no ceiling until you say "go on /
    давай" or tap.
  - "that's it / всё / over" ends the turn immediately.
- **Incremental STT for long monologues.** Each VAD segment is transcribed while you're still
  talking, on the GPU (the model stays loaded in conversation mode). End-of-turn latency
  stays under a second even after two minutes of thinking aloud.
- **A visible and audible state:** listening / thinking / speaking, in the drawer, the tray
  and on the phone.

**Talking over it (barge-in) and echo.** If you start speaking while the Assistant is
talking, it stops talking and listens. **Decided (2026-10-18): this must work on both
headphones and laptop speakers**, so echo handling is a requirement with acceptance numbers,
not a fallback. On speakers the mic hears the Assistant's own voice. The defense is layered,
and each layer catches what the previous one lets through:

| # | Layer | What it does |
|---|---|---|
| 1 | **Output-device awareness** | Read the active endpoint's form factor (headphones / headset / speakers, via `IMMDevice` `PKEY_AudioEndpoint_FormFactor`) and react when it changes. Headphones → light processing. Speakers → the full chain. |
| 2 | **Acoustic echo cancellation with a true reference** | **WebRTC AEC3** (`webrtc-audio-processing` crate) fed the exact PCM the app is playing. That's the advantage of doing playback ourselves in Rust (`rodio`): the reference is sample-accurate. Its delay estimator and the residual echo suppressor are on; noise suppression is light. |
| 3 | ~~OS voice processing as an alternative~~ | Not needed: in X0, AEC3 alone removed ~30 dB of echo on the laptop speakers, with no false barge-ins. Windows' communications-mode processing stays untested, as a fallback idea for a device where AEC3 falls short. Never stacked with AEC3. |
| 4 | **Barge-in gate** | While the Assistant is speaking, a barge-in needs speech that survives AEC, is clearly louder than the residual echo (an adaptive threshold learned from the playback level), and lasts ≥ 250–300 ms. A cough or a residual echo blip doesn't qualify. |
| 5 | **Self-voice check** | We know the exact text being spoken. If a would-be barge-in transcribes to words that match the sentence currently playing, it's echo: ignored, and the gate tightens. |
| 6 | **Last resort** | If the measured echo suppression on a device is still too low, that device drops to half-duplex (the hotkey or "stop" interrupts) and the drawer says why. It's a per-device result, not the plan. |

The phone browser uses its built-in echo cancellation
(`getUserMedia({echoCancellation: true})`) plus layers 4–5 on the desktop side.

**Starting and stopping:**
- Start with a hotkey toggle, a drawer or phone button, or by saying so in push-to-talk ("let's
  talk", "давай поговорим").
- It turns itself off after 5 minutes of silence (configurable) or on "that's all for now".
- It never runs in the background on its own: no wake word, by design.

**On the phone:**
- The PWA runs Silero VAD in the browser (`@ricky0123/vad-web`, onnxruntime-web) and sends
  only speech segments over the assistant WebSocket.
- The desktop runs the turn detector and STT on them.
- It needs the PWA in the foreground with the screen on (a mobile browser limitation).

### Modes and skills (growing the Assistant over time)

You want to extend what it can do as needs come up. The engine has three extension points,
in increasing effort.

**1. Modes.** A *mode* is a kind of thread with its own model, system prompt, tool set and
voice patience. Each mode is a separate thread, so prompt caches never mix.

| Mode | Model | Tools | Behavior |
|---|---|---|---|
| **Assistant** (default) | Sonnet 5.5 (`medium`, raised per message), Haiku workers | everything | concise; acts |
| **Chat** | Sonnet 5.5, effort `medium` | web, memory, read-aloud, screenshot | a general conversation partner; no app actions unless asked |
| **Rubber duck** | Sonnet 5.5, effort `medium` | read sessions/notes/git (read-only), memory, `create_note` | asks questions, reflects your reasoning back, points out gaps, and **doesn't solve unless you ask**. "Wrap up" writes a note: the problem, what you concluded, open questions, next steps. Optionally it hands those to an Opus session. |

- Switch modes by voice or text ("let's rubber-duck the sync bug"). The Assistant opens a
  duck thread with the context you named, such as a project or session.
- Cost: an hour of voice rubber-ducking on Sonnet (~60 turns, cached history) is about
  $0.30–0.60; the TTS is mostly short replies.

**2. Skills: new behaviors without code.**
- Each skill is a folder at `<appdata>/assistant/skills/<name>/SKILL.md`, with frontmatter
  (`name`, `description`, optional `mode`, `model`, `tools` allowlist) and a body of
  instructions. Examples: "morning briefing", "release checklist", "explain a diff to me
  like a reviewer".
- Only the **descriptions** sit in the system prompt (sorted, so the cache is stable). The
  body is loaded on demand by a `load_skill` tool; its result is appended, so the cache
  survives.
- A skill can declare a new **mode**, so new personas are just files.
- The Assistant can **write skills for you**: "make a skill that…" → it drafts `SKILL.md`, a
  card shows the draft, and you save it. Skills are the same shape as Claude Code skills, so
  they can be shared both ways.

**3. Tools: new capabilities.**
- **MCP servers:** any server in your Claude Code config can be opted in for the Assistant
  (the B2 host). That is the cheap path to new integrations.
- **Built-in tools** need app code. The plan's own workflow covers it: ask the Assistant, and
  it starts an Opus session on the Workbench repo with the tool spec.

All three go through the trust policy. A skill can't widen what a tool is allowed to do;
it can only use tools under their existing rules.

### Long-term memory, growth and self-development (track L)

Duck should get better the longer you use it in three ways: it **remembers** what matters,
it **accumulates** skills and tools, and it can **improve its own code** when you ask, using
Opus sessions.

**1. Long-term memory: files you can read, with an index Duck can search.**
- **Source of truth is plain markdown in the Duck workspace**,
  `C:\Users\mrsha\repos\Duck\memory\`, so you can read and edit it, git tracks every change
  (history and undo), and worker sessions can read it too, which gives them your context
  for free:
  - `core.md`: the always-loaded profile (W4).
  - `people.md`, `projects/<name>.md`, `decisions.md`, `preferences.md`, `goals.md`: topic
    files. Each entry is a short dated bullet with a source link (thread or task) and a
    confidence.
  - `journal/2026-10.md`: episodic memory. One paragraph per notable thread or task ("we
    decided X because Y; open: Z").
  - `lessons.md`: what Duck learned about working with you ("when I say 'the backend' I
    mean session X", "don't read code aloud"). These are corrections, captured as they
    happen.
- **Index:** `duck.db` keeps an SQLite **FTS5** index over all entries, using the trigram
  tokenizer, which works for Russian and English without stemmers. It is rebuilt
  incrementally by the existing file watcher.
- **Recall, in two ways:**
  - *Automatic:* each user message runs a quick FTS query (no model call). The top few
    entries above a relevance threshold are attached as a small "possibly relevant
    memories" system note, so the main thread sees them without searching.
  - *On purpose:* a `recall(query)` tool for deliberate lookups ("what did we decide about
    sync?").
- **Writing:**
  - During conversation, Duck calls `remember(topic, fact, why)` for things that matter:
    decisions, preferences, facts about projects and people, commitments. Each one shows a
    chip ("remembered: …") you can undo.
  - A **daily consolidation** pass (Haiku, on the first idle hour) reads the day's threads
    and task results. It proposes new entries, **merges duplicates, flags contradictions**
    ("you said Postgres in March, SQLite today — which holds?"), writes the journal
    paragraph, and retires entries that have gone stale. It commits all of this to the Duck
    repo as one commit per day.
- **What it never stores:** secrets, passwords, tokens or keys (a pattern filter plus a
  prompt rule), and anything you mark "don't remember". "Forget X" deletes from the files
  and the index, and the git history can be squashed on request.
- **If keyword search proves too weak** (L2 measures it), add a small local multilingual
  embedding model (e.g. `multilingual-e5-small`, ~120 MB ONNX, CPU, lazily loaded) for
  semantic recall. Not before.
- Cost: consolidation runs a few cents a day on Haiku; automatic recall is free (SQLite).

**2. Growing skills and tools on its own initiative.**
- Duck notices repetition. When the same multi-step request has come up about three times,
  it offers to turn it into a skill (S2's `draft_skill`).
- When a capability is missing ("I can't read your calendar"), it says so and suggests the
  path: an MCP server you could add, or a self-development task (below).
- Skills live in `C:\Users\mrsha\repos\Duck\skills\`, in the same git repo as memory, so they
  are versioned too.

**3. Self-development through Opus sessions** (decided 2026-10-18: on request).
- **What "improving Duck" can mean, cheapest first:**
  1. A **skill or mode** file. No code; Duck writes it itself (S2).
  2. **Prompts and tier tables**: Duck's system prompts, routing examples and tier table
     live as files in `C:\Users\mrsha\repos\Duck\config\`, loaded and hashed at thread
     start, so the cache stays stable within a thread. Duck can propose a diff to them; you
     approve; it takes effect on the next thread, with no rebuild.
  3. **Code**: a change to Duck itself, which lives in the Workbench repo.
- **Code changes run as a serious-tier worker** (Opus, `medium`, or `high` if you say so)
  in a **worktree of the Workbench repo**, on a branch `duck/<slug>`. The brief includes:
  - the request in your words, plus the relevant `lessons.md` entries;
  - this plan and **`documentation/duck-architecture.md`**: a living architecture doc
    that every Duck step keeps current, so a fresh Opus session can find its way around;
  - the guardrails section, verbatim;
  - "run `npm run lint`, `npm test` and `cargo test`; don't merge; write `result.md`
    with what changed and why".
- **Review:** Duck reports the result and opens the branch in Workbench's Diff/Review panel.
  You read it, and can ask for changes as follow-ups to the same session. **Merging is
  always yours:** merging or pushing Duck's own code is on the trust floor.
- **Activation:** Duck doesn't hot-patch itself. After a merge, it offers to build and
  restart (dev build first if you like). Threads, memory and tasks survive the restart.
- **Extra care for safety-critical code.** Changes that touch the trust engine, the floor,
  the API-key proxy or budget enforcement are flagged in the brief and on the result card
  ("touches the safety layer"), and need a second explicit confirm before merge.
- **Proposals, not surprises.** Duck can *suggest* improvements from its `lessons.md` and
  from tool errors it keeps hitting ("I misrouted 4 requests this week; want me to start an
  Opus session to fix the routing examples?"). It only starts a self-development task when
  you say yes.

**4. Two repos, and keeping Duck's data safe.**
- **Duck's code** lives in the Workbench repo and is committed and pushed like any of your
  work (L3 changes arrive as branches you merge).
- **Duck's data** (memory, skills, config, task folders) lives in its own git repo at
  `C:\Users\mrsha\repos\Duck`.
- **Your project notes are not Duck's data** (decided 2026-10-19). They stay in Workbench's
  notes folder and sync between machines through their own private repo (improvement plan
  N3), so they sync with Duck off, and Duck's automatic tidying can never reorganize them.
  Duck reads, searches and edits them through tools (W1, W2, L1).
- **Commits happen as things change:** every memory write, the daily consolidation, every
  approved config or skill change. Nothing piles up uncommitted for long.
- **All of Duck's git work runs in the background, in parallel with your conversation**
  (decided 2026-10-18). Nothing git-related ever blocks a reply. There are two lanes:
  - **Mechanical lane** (instant, free): commit-after-write and push. It runs on
    Workbench's shared background git queue (`src-tauri/src/gitqueue/`, also used by notes
    sync; `git` CLI through the existing `git_run` helpers, one repo lock, retries with
    backoff), so the conversation never waits.
  - **Judgment lane** (background Sonnet `medium` worker sessions): anything that needs
    thought. That covers the weekly housekeeping, a push rejected because the remote moved,
    a merge conflict, repo repair ("index.lock left behind", a detached HEAD), and
    restructuring memory files. The mechanical lane hands these over automatically.
  - A full Claude Code session for each one-line commit would cost 10–30 s, a few hundred MB
    of RAM and subscription usage for no gain. That's why the lanes are split; a pref can
    route everything to sessions if you ever want to.
- **Backup:** a **private GitHub repo** as the remote (created with `gh repo create --private`
  on setup, after you confirm). Duck pushes after each daily consolidation, and at most
  hourly otherwise.
  - This is a deliberate exception to the trust floor's "no pushes" rule: *only* this repo,
    *only* its configured private remote, *never* force.
  - Memory is personal, so it stays private; the repo's README says so.
  - Without a remote it works locally, and Duck reminds you once a week that it isn't backed
    up.
- **Housekeeping routine** (step L4): a scheduled **Sonnet `medium` worker session** in the
  Duck workspace, weekly by default. It:
  - Checks repo hygiene: no uncommitted leftovers, the push is up to date, `git gc`.
  - Applies the task-folder retention policy (keep results, compress old transcripts into
    `tasks/INDEX.md`).
  - Cleans up memory: restructures topic files, merges near-duplicates across files,
    tightens wording, checks every entry still has a source.
  - Lints skills: valid frontmatter, unused ones flagged.
  - Writes `result.md` and commits on a branch `housekeeping/<date>`. Duck fast-forwards
    `main` if the diff is only tidying; larger restructures wait for your OK.
- **Docs cleanup for Duck's code docs** (`duck-architecture.md`, this plan's As-built notes)
  happens monthly, through the L3 path (an Opus or Sonnet branch in the Workbench repo, which
  you merge), because it touches the code repo.

### Proactive updates: Duck speaks up when there's news

Background work takes time, so Duck doesn't wait to be asked: when a worker finishes, a
session needs you, or an autopilot run stops, **Duck tells you**, on the right surface and
at the right moment.

**Urgency levels:**

| Level | Examples | What Duck does |
|---|---|---|
| **info** | a housekeeping run finished, memory consolidated | badge on the Duck button only; included in "what's new?" |
| **report** | a research task you asked for is done, an autopilot step finished | posted to the thread, plus a **short spoken headline** if you're around, otherwise a push |
| **needs you** | a decision only you can make, a trust card, an autopilot stopped on a problem | spoken (if you're around) **and** a push. It repeats once after 10 minutes if unanswered. |

**"Are you around?", and where:**
- **Desktop:** recent keyboard or mouse activity on the PC (`GetLastInputInfo`, within the
  last 2 minutes) and the workstation unlocked.
- **Phone:** the PWA or Android app is in the foreground, or the Android app's conversation
  mode is on.
- **Otherwise:** push to the phone. The Android app (R4) can show a notification with a
  "Listen" action that plays the spoken summary.

**The Speak toggle comes first** (decided 2026-10-18). A master **Speak** switch decides
whether Duck uses its voice at all: spoken replies, announcements and the reply window.
- It's one click on a speaker icon next to the Duck button, also in the drawer header, the
  tray menu, the phone tab, a hotkey and by voice ("Duck, stop talking" / «Дак, молчи»).
- **Speak off** means text only: announcements arrive as a badge, drawer messages and
  pushes. Voice *input* (push-to-talk, conversation mode) is separate and unaffected.
- Starting conversation mode can turn Speak on for its duration (pref).

**Etiquette: everything configurable** (decided 2026-10-18), under Duck settings →
Announcements:

| Setting | Default |
|---|---|
| Speak (master) | off until you turn it on the first time |
| Speak for each level: info / report / needs you | never / when around / when around |
| Wait for a conversation gap before speaking | on |
| **Do not disturb**: a manual toggle with "for 1 h", "until I turn it off" or "until morning"; also by voice ("Duck, quiet" / «Дак, тихо») | off |
| Follow Windows Focus / Do Not Disturb | on |
| Quiet hours | **off** (optional; manual DND is the main control) |
| Stay quiet over full-screen apps, except *needs you* | on |
| Batch window for updates arriving together | 20 s |
| Repeat unanswered *needs you* | after 10 min, once |
| Reply window after speaking | on, 8 s |
| "Around" means input within | 2 min |
| Push to the phone when not around | on |

- During DND, nothing is spoken. Updates still collect in the drawer, and *needs you* still
  goes to the phone as a silent push (a pref).
- When DND ends, Duck gives one short catch-up.
- It never talks over you or itself.
- Several updates arriving together are **batched** into one announcement ("Two things: the
  auth research is done, and the backend session needs you").
- **After speaking, it listens briefly:** for ~8 s it accepts a short reply without the
  hotkey ("yes, read it", «потом», "start the next step"). Then the mic closes. It's
  conversation mode in miniature, using the same VAD, turn detection and echo
  cancellation (V4).

### Plan autopilot: following a plan step by step

Your usual loop is this: write a thorough plan, then repeatedly let the agent do a step,
`/compact`, and queue "continue the implementation". Duck can **run that loop for a session
and only come back to you when something needs you.**

**How it runs** (step P1). You say "run the assistant plan on the workbench session on
autopilot", or use the instance card's menu → *Autopilot*. Duck then repeats:
1. **The session finishes a turn** (status `done`, from the hooks).
2. **Duck reviews the turn** with Sonnet at `low` effort, about $0.01–0.02 per step. It reads
   the last response, the transcript of the turn and the plan file, and gives a structured
   verdict:
   - **`continue`**: the step is complete; the plan's tracker was ticked or an As built note
     was added, if the plan uses them; tests were reported passing; no open question.
   - **`needs_you`**: a question or decision only you can make, failing tests the agent gave
     up on, the agent asking for direction, a step that deviated from the plan, or
     "Done when" not met.
   - **`plan_done`**: the last step has landed.
3. **On `continue`:**
   - **Compaction is decided per step**, the way you judge it (decided 2026-10-18):
     - Compaction happens only **after a finished step**, never during a job. Claude Code's
       own automatic compaction, when the context is truly full, is the only mid-job one.
     - By default it compacts after every finished step. The review returns `compact:
       yes|no` with a reason, and says *no* when the next step directly continues this
       one's context (a fix-up of the same step, or "now wire up what you just built").
     - It sends `/compact`, optionally with a focus line ("keep the plan path and the step
       just finished"), and waits for compaction to end (`onCompactionEnd`, already in
       `status.ts`).
   - **Then the continue prompt:**
     - By default one of your phrasings: "continue the implementation" or "proceed to the
       next step".
     - When the situation calls for it, the review **writes a situational prompt** instead,
       for example "proceed to the next step (T2); note the flaky test in `queue.test.ts`
       from the last step", or "finish the As built note for W3, then proceed".
     - It is sent through the existing queue, and shown in the step log.
     - A pref picks "always your fixed phrasing" or "situational allowed" (default).
4. **On `needs_you` or `plan_done`:** autopilot pauses, and Duck tells you (proactive update,
   *needs you* or *report*) with a summary of what happened and the exact question. You
   answer by voice or text. Duck relays it into the session, and autopilot resumes if you
   say so.

**While the agent works:**
- Its permission prompts go through the trust policy (T2): the project must be in *live*
  mode for autopilot to keep moving.
- Its questions go through Duck as in D2: answered when the plan or your earlier answers
  settle them, otherwise a stop.

**Guard rails for unattended runs** (step P2):
- **Stops on its own** after N steps (default 5; or "until the plan is done") or at a time
  window's end ("overnight only").
- It also stops when the same step fails twice, when a step takes far longer than the
  previous ones (a stall), or when the session ends or crashes.
- **Subscription limits:** near the 5-hour or weekly threshold it **pauses and resumes by
  itself** after `resetsAt`, with no API fallback here, since this *is* your subscription
  work.
- **A checklist per plan** of what "step done" must include: tests ran, tracker ticked, As
  built written, commit made. The review uses it.
- **Visible state:** the instance card shows "Autopilot · step 7 of 18 · next: T2",
  with Pause, Stop and "step log": each step's verdict and a one-line summary. The same is on
  the phone.
- **Morning summary** after an overnight run: steps done, where it stopped and why, and what
  needs you first.

This is the D-track idea applied to *your* sessions, not just Duck's workers. Duck supplies
the judgment between steps; the sessions do the work on your subscription.

### Remote

- The phone talks to the same engine. The remote server gets `GET /api/assistant` (WS) for
  streaming and `POST /api/assistant/audio`. Both are authenticated like every other route,
  and the audio route raises the body limit.
- Rust forwards input to the webview as an event (the `remote-action` pattern). The engine
  streams deltas, tool chips and confirmation cards back through a command that broadcasts
  to the connected sockets (the snapshot pattern).
- The trust policy's cards, Decisions view and kill switch are on the phone too. A push
  notification arrives when a card is waiting and no surface is open.

### Reaching Duck from your Android phone, conveniently

The goal is to reach Duck in one gesture, without opening the Funnel site in a browser and
tapping around. Two stages.

**Stage 1: the PWA as a real app** (step R3; cheap; uses what exists):
- **Installed PWA.** On Android, Chrome installs it as a WebAPK: its own launcher icon, its
  own window, no browser UI. Duck becomes the default start view (pref), or gets its own
  icon (next bullet).
- **App shortcuts** (manifest `shortcuts`). Long-press the icon for "Talk to Duck", "New
  task" and "What needs me?". Each shortcut can be **dragged to the home screen as its own
  icon**, so one tap opens straight into conversation mode. (A browser still needs one tap
  inside the page to start the mic.)
- **Share to Duck** (manifest `share_target`). Share a link, text or screenshot from any app →
  Duck: "read this", "summarize", "make a task of it".
- **Push** (already works over Funnel) deep-links into the reply or card that needs you.
- **Limits:** the mic only works in the foreground with the screen on; no lock-screen or
  hardware-button access.

**Stage 2: a small Android companion app** (step R4), for the things a browser can't do:
- **Duck as your phone's assistant.** It registers as the Android **digital assistant**
  (`VoiceInteractionService`, the assistant role). The system assistant gesture (long-press
  power, or a corner swipe) then opens Duck **already listening**, even from the lock screen.
- **Quick Settings tile** "Duck": tap to start conversation mode from anywhere.
- **Home-screen widget:** a talk button, plus a one-line status ("2 sessions need you · task
  done").
- **Background conversation.** A foreground service keeps the mic and playback running with
  the screen off: a real hands-free walk-and-talk rubber duck.
- **Connection: public (Funnel) by default, Tailscale when it happens to be on** (decided
  2026-10-18). Why not require Tailscale:
  - **Safety is about the same either way.** The Funnel endpoint is *already* public, since
    Web Push needs it, so the app adds no new exposure. The real protection is the auth layer
    (pairing code, desktop approval, revocable device tokens), plus a new **device-bound
    key** for the native app (below).
  - **Experience is slightly better on Tailscale, not decisively.** A direct WireGuard path
    skips the Funnel ingress relay, which shaves some tens of milliseconds and avoids the
    relay's bandwidth limits; small next to STT + model + TTS time. Funnel's own
    latency and limits aren't documented in detail, so R4 measures both.
  - **Cost of always-on Tailscale:** Android allows one VPN at a time, and the tunnel uses a
    little battery. Not worth it for a small latency gain.
  - So the app connects to the Funnel URL. When Android reports a VPN up and the desktop's
    tailnet address answers within ~300 ms, it switches to that, and back again when
    Tailscale drops, without losing the conversation.
- **Device-bound key (makes public access safer).** At pairing the app creates a
  non-exportable key pair in the **Android Keystore** (StrongBox where available) and
  registers the public key with the desktop. Every connection then answers a signed
  challenge, so a copied bearer token alone is useless. The PWA can get the same with a
  non-extractable WebCrypto key in IndexedDB (R3).
- **Built with Tauri 2 mobile** (the same stack as the desktop app). The UI reuses the PWA's
  TypeScript; a Kotlin plugin provides the assistant service, tile, widget, foreground
  service and Keystore token storage. Pairing works like the PWA's (code → approved device
  token).
- **Notifications** stay with the installed PWA's Web Push at first. Native push would need
  Firebase; a WebSocket kept open by the foreground service covers conversation time.
- **It only makes sense if stage 1 proves Duck is something you reach for from the phone
  often.** That's the "if it proves good" gate you described.

### Browser and web

- **Looking things up:** Anthropic's server-side `web_search` ($10 per 1,000 searches plus
  tokens) and `web_fetch` (tokens only), on the Sonnet main thread. Nothing runs locally,
  and answers come with citations.
- **Doing things in your browser:** the **Firefox MCP bridge you already use**
  (`mcp-bridge-for-firefox`, registered in Claude Code as `firefox`, run with `uvx` over
  stdio, pinned to a commit).
  - It drives your everyday Firefox with its sign-ins and open tabs, not an automation
    browser, through an add-on that connects to a local server.
  - **Several clients at once are supported:** each MCP server process takes the next free
    port from 8765 and the add-on connects to all of them. So the Assistant runs its own
    instance next to any Claude Code session using the browser, without conflict.
  - **Profiles:**
    - It works in a separate **agent** Firefox profile by default, as upstream recommends.
      Log into the sites it needs there once, and the sign-ins persist.
    - Your **personal** profile (your tabs and logins) is used when a task needs it. The
      switch is an explicit, reasoned trust request ("ask" by default; rules can allow it per
      site).
    - On a login wall it asks you to log in, or to allow the personal profile. It never
      types credentials.
  - The Assistant reads the server definition **from your Claude Code MCP config** (the app
    already lists it through `mcp_list`) instead of keeping a second copy. Upgrading the
    pinned commit in one place updates both.
  - It is reached through a small **MCP host in Rust** (`rmcp`, the official Rust SDK). The
    host spawns the server **only when a browser tool is first used** and kills it after 10
    minutes idle.
  - Browser tools sit behind tool search (`defer_loading`), so their schemas load only when a
    browser task comes up and the fixed prefix stays small.
    The generic host can attach other MCP servers you've registered later, opt-in per server.

### Storage

- **SQLite: Duck's own `duck.db`** (`duck.dev.db` for the debug build; its own append-only
  migrations; see §Separable, not separate). Workbench's `workbench.db` only gains
  `instances.owner`.
  - `assistant_threads` (id, title, created, mode).
  - `assistant_tasks` (worker tasks: instance id, folder, tier, backend, state).
  - `assistant_messages` (thread id, seq, role, content blocks as JSON, source = desktop /
    phone / voice). Append-only, matching the API's preserved-thinking rule.
  - `assistant_usage` (per API call).
  - `assistant_pending` (open confirmation cards, so a reload doesn't lose them).
  - `assistant_decisions` (the trust audit log) and `assistant_rules` (trust rules,
    floor overrides, per-project live / shadow mode).
- **Context hygiene:** keep one rolling thread with a "new thread" button. Old tool results
  are cleared with context editing (`clear_tool_uses`). Very long threads use server-side
  compaction. A small **memory** file (preferences, project nicknames such as "the game" =
  project X) is injected as a mid-conversation system message, not by editing `system`.
- **Prefs:** hotkeys, voice settings, budget limits, default Opus model, auto-summary on/off.
  The key lives in the keychain, not here.

---

## Current state (audit, 2026-10-18)

| Where | Finding |
|---|---|
| `src-tauri/Cargo.toml` | No Anthropic client, no keychain, no audio. Outbound HTTP is Web Push only (`ureq`); the comment says nothing else makes outbound requests. `reqwest` is in `Cargo.lock` through Tauri. |
| `src/state/status.ts:44`, `:245` | `StatusPhase` idle/working/needs_you/done/ended plus `compacting`/`subagents`; `onStatusTransition(cb)` is the hook for "tell me when X finishes". |
| `src/state/pendingChoice.ts:337` | `getPendingChoice` gives permission/question/plan options (labels read off the screen, the one approved exception). |
| `src/state/remoteActions.ts:29-85` | prompt / approve / deny / interrupt / start / stop / create / choose; `answerChoice`. **The keystroke module the Assistant must reuse.** |
| `src/panels/promptDelivery.ts:16`, `src/state/queue.ts` | `sendOrQueue()`: send now if at rest, else queue until `done`. One queued prompt per instance. |
| `src/state/remoteCreate.ts` | Idempotent create-session-with-first-prompt, waiting for `promptBoxReady`. |
| `src/panels/Diff/reviewRun.ts` | The full "spawn an agent, prompt it, wait, read the answer" flow, already in TS. |
| `src-tauri/src/pty/mod.rs:995-1026` | `claude_command` passes only `--session-id`/`--resume`. **No model selection**; `Instance` has no model field (`registry/mod.rs:64-200`). |
| `src/transcript/feed.ts:185` | `readLastResponse`. There is no "last N messages as plain text" helper; it needs `readTranscriptBack` + `createTranscript().prepend()` + serialize. |
| `src-tauri/src/remote/server.rs:80-107` | Routes; `authed()` :265, `ws_authed()` :285. No `DefaultBodyLimit`, so axum's 2 MB default applies. |
| `src-tauri/src/hooks/server.rs`, `hooks/mod.rs:75` | Loopback axum server with a persisted port. The natural home for the `/anthropic` proxy. |
| `src/keyboard/keymap.ts:36-98`, `bus.ts` | `CommandId` union + `registerCommand`; the palette lists commands automatically. |
| `src/util/speech.ts` | TTS via `speechSynthesis`; notes WebView2 has **no** speech recognition. |
| `tauri.conf.json` | CSP is `null`. Webview fetch to loopback is not blocked. |
| `workbench-improvement-plan.md` Track M | "Run summary on done, as a Claude Code mod". **Check its As-built before W3** so there aren't two summary mechanisms. |

---

## Guardrails (settled — don't violate)

- **Claude Code agents are still driven only through the PTY.** The Assistant is a new,
  separate use of the API for *itself*; it never runs Claude Code headless, through the Agent
  SDK, or with `claude -p`. Everything it does to a session goes through
  `remoteActions.ts` / `promptDelivery.ts`, the same keystrokes the phone sends.
- **Duck's main thread never blocks on long work.**
  - Every tool has a time budget (default 10 s). Anything that can take longer is started
    as a background task or job, and returns at once with a task card. Waiting is done by
    subscription (`onStatusTransition`, task completion events), never inside a turn.
  - New input while Duck is replying interrupts or queues (your choice per surface); it is
    never dropped.
- **Duck touches Workbench only through `WorkbenchPort`**, and surfaces talk to Duck only
  through the Duck Protocol. The ESLint rule is part of `npm run lint`. Duck's data lives in
  `duck.db`, its prefs file and its keychain namespace.
- **Duck never changes itself unreviewed.** Config changes need an approved diff; code changes come from an Opus worker on a branch, and **merging Duck's own code is always yours** (trust floor), with a second confirm when the safety layer is touched. It never hot-patches itself while running. Every Duck step keeps `documentation/duck-architecture.md` current.
- **Memory never stores secrets** (a filter before every write), and lives in a local git repo with no remote unless you add one.
- **Worker sessions are ordinary sessions.**
  - They are created, prompted and answered through the same `create_session` /
    `sendOrQueue` / `answerChoice` paths as everything else, and are visible in the instance
    manager.
  - They differ only in ownership: notifications go to Duck first.
  - Results are exchanged through files in the task folder, never by scraping the terminal.
- **Status from hooks, content from the transcript.** The Assistant answers "is X done?" from
  `status.ts` and "what did X do?" from the transcript, never by reading the screen, apart
  from the existing pending-choice exception.
- **The API key never enters JavaScript, prefs, SQLite, logs or a child process environment.**
- **Consequential actions go through the trust policy, in code, never on the model's say-so.**
  The kill switch and the floor always win; the judge can only allow or ask, never deny;
  every automatic decision is logged. A new project starts in shadow mode.
- **Tool results from transcripts, tool inputs and the web are untrusted data.** They are
  wrapped and labelled, and markdown is rendered through `marked` + `DOMPurify`.
- **Idle cost ≈ 0.** No model loaded, no mic open, no browser or MCP process, nothing polling
  while the Assistant isn't in use. Anything heavy is lazy and unloads itself.
- **Append-only conversation history**, a stable tool list and a stable system prompt
  (prompt caching and preserved thinking both depend on it).
- **Remote: same auth as everything else.** New routes use `authed()`/`ws_authed()`; nothing
  new is reachable without a paired, approved device.
- **Dev and release stay isolated:** separate keychain entry names, DB, ports and model cache
  folders.
- **Windows first:** `CREATE_NO_WINDOW` for spawned MCP servers, backslash paths, no shell
  interpolation.

---

## Steps

### Track X — Spike

#### Step X0 — Spike: check the assumptions

- **Goal:** Turn this plan's assumptions into facts, or change the plan, before writing
  product code.
- **Depends on:** nothing.
- **Build** (throwaway code in the scratchpad or a branch; findings go into this step's As
  built):
  - **Hidden window:** with the main window hidden to the tray for 10+ minutes, does a timer
    and a `remote-action` still run promptly in WebView2? (The Assistant and the existing
    phone actions both depend on it.)
  - **Proxy streaming:** the TS SDK pointed at a loopback axum route that forwards to the
    API. Does streaming work in WebView2, and does the CORS preflight pass from the Tauri
    origin?
  - **Sonnet main thread, measured:**
    - Run 20 sample requests ("what's the game agent doing", "tell the backend session to run
      the tests", "approve that", "summarize the last hour", 4 multi-step ones, and 4 in
      Russian) against stub tools.
    - Use Sonnet 5.5 at `low` and at `medium`, plus Haiku 5.5 (the degraded mode).
    - Measure correct tool picks, latency to first token, and **real cost per turn** from
      `usage`: warm cache, cold cache, and after a 20-minute gap with the 1-hour TTL.
    - Expected: Sonnet `low` ≈ $0.02 warm. If the measured average is above $0.04, the
      prefix size, caching and effort defaults get tuned before A2.
  - **Tool versions:** confirm the current `web_search` / `web_fetch` type strings and which
    models take them (Haiku included?). Use the Models API `capabilities` field.
  - **Claude Code:**
    - Does `claude --model opus --session-id …` work with the hooks?
    - Which auth do the consoles use here (subscription vs API key)? Confirm the child env has
      no `ANTHROPIC_API_KEY`.
    - Which **permission modes** does the installed version offer (e.g. an automatic /
      classifier-based mode, `acceptEdits`), and how much of T2's work would they do natively?
      How do `permissions.allow` rules in `.claude/settings.local.json` interact with them?
  - **Worker sessions (inputs for D1/D2):** run 3 real tasks as Claude Code sessions in a
    scratch "Duck" folder with the planned allow list: a web research comparison, a long
    write-up, and a Firefox chore.
    - Measure time to start, time to `done`, and how often the worker writes
      `result.md` / `result.json` correctly on the first try.
    - Measure prompts that still appeared, RSS per Claude Code process, and the **5-hour /
      weekly usage delta** per task (`usage_limits` before and after).
    - Note whether Claude Code's built-in WebSearch and the `firefox` MCP work there without
      prompts.
    - Run one task per tier (`--model sonnet --effort medium`, `--model sonnet --effort
      high`, `--model opus --effort medium`) and compare result quality against the usage
      delta.
    - Try `--permission-mode auto` against the allow list alone. (`--model`, `--effort` and
      `--permission-mode` were confirmed present in Claude Code 2.1.302 on 2026-10-18.)
  - **Presence signals (inputs for V5):** can the Windows Focus / Do Not Disturb state be
    read reliably on this build? Check that `GetLastInputInfo` and the session-lock events
    work from the Tauri process.
  - **Autopilot mechanics (inputs for P1):** on a real plan session, check by hand that
    `/compact <focus>` followed by a queued "continue" prompt lands correctly (the
    `ca1304c` queue fix). Check whether the context-usage figure is available per instance
    to drive the "compact only above N%" policy.
  - **PermissionRequest payload:** for 10 real prompts (Bash, Edit, WebFetch, MCP), log
    `tool_name` / `tool_input` and the `pendingChoice` option labels. These are the inputs
    T1's rule matcher and T2's label lookup are built on.
  - **Firefox bridge:** with a Claude Code session connected, spawn a second
    `mcp-bridge-for-firefox --stdio` from Rust (`rmcp` example). Do both get tools? Check how
    long the add-on takes to reconnect, the peak RSS of the `uvx` process, and whether the
    local port is protected from other processes (`SECURITY.md`).
  - **STT, on your own recordings:** 20 utterances: 8 English, 8 Russian, and 4 **mixed**
    (Russian with English terms and project names).
    - Compare Parakeet v3 (`transcribe-rs`, `ort-cuda`, then `ort-directml`) with Whisper
      large-v3-turbo (`whisper-rs`, CUDA).
    - Measure WER by eye, latency for 3 s / 10 s clips, VRAM, cold-load time including
      **waking the dGPU**, and the CPU int8 fallback latency under a typical load.
    - Pick the default engine and record why.
  - **TTS listening test** (inputs for V2): the same 12 test replies through each candidate.
    - Replies: 4 English, 4 Russian with homographs, numbers and rare words (замок/замок,
      "в 14:30", "рефакторинг"), and 4 mixed ("Сессия backend закончила, `npm test`
      прошёл").
    - Candidates: Google Chirp 3 HD (one ru-RU and one en-US voice), Azure multilingual
      neural, Qwen3-TTS 0.6B (local GPU, Python), Kokoro (EN) + Silero v5 (RU).
    - Record time to first audio, VRAM/RAM, and **your ranking**. Use a throwaway Python
      notebook; nothing ships.
    - Also play the same replies **on the phone**, through the phone's native TTS and as
      Chirp audio, to settle the "one voice everywhere" question.
  - **End-of-turn detection** (inputs for V4):
    - Record 10 "thinking aloud" monologues of 30–90 s, in Russian, English and mixed, with
      deliberate long pauses mid-thought.
    - Run Silero VAD + Smart Turn v3.2 (ONNX, CPU) over them offline. Count false
      end-of-turns at the default thresholds and at the rubber-duck patience; measure CPU
      while listening.
  - **Echo (must pass on speakers and headphones):** play 10 minutes of mixed RU/EN TTS on
    the laptop speakers at your normal volume, with the mic open.
    - Compare: (a) raw, (b) AEC3 with the playback reference, (c) Windows communications-mode
      processing, (d) the better of b/c plus the barge-in gate and the self-voice check.
    - Measure echo suppression (ERLE, in dB), false barge-ins per 10 minutes, and the
      true-barge-in detection time when you interrupt 10 times.
    - Repeat on headphones and on the phone.
    - Record which chain wins per device.
    - Confirm Chirp 3 HD's and Azure's free quotas and overage prices on the official pages
      or billing SKUs, and whether a free quota needs billing enabled.
  - **Screen:**
    - Does `xcap` capture each monitor, including the DisplayLink screens, and a single
      window?
    - What does Haiku read correctly from a dense screenshot at 1568 px?
    - Are the `Windows.Media.Ocr` en-US / ru-RU recognizers available?
- **Done when:** every bullet has a measured answer in As built, and the Open questions table
  is updated.
- **Out of scope:** any UI.
- **As built (2026-10-18 – 2026-10-19).** The throwaway code and raw data were in a
  temporary session scratchpad (`x0/`: `rust/`, `api/`, `workers/`, `voice/`, each with a
  `FINDINGS.md`); everything that matters is summarized here. The voice scripts were kept in
  `tools/voice-eval/`, with their data (your recordings) in `~/repos/Duck/voice-eval`. Machine:
  Ryzen AI 9 HX 370 (12 cores / 24 threads, Zen 5), 31 GB RAM, RTX 4060 Laptop 8 GB (Optimus) +
  Radeon 890M; Claude Code 2.1.303; WebView2 155.
  - **Hidden window:** no throttling after 12.9 minutes with `window.hide()` or `minimize()`:
    773/773 timer ticks, Rust events handled within 2 ms. `document.visibilityState` stays
    "visible", so use Tauri window events to know. Hiding the *webview itself*
    (`SetIsVisible(false)`) throttles timers to one per minute unless WebView2 gets
    `--disable-background-timer-throttling --disable-renderer-backgrounding
    --disable-backgrounding-occluded-windows`. `backgroundThrottling` is unsupported on
    Windows. **Decision:** always hide the window, never the webview; add the three browser
    args anyway (A2).
  - **Proxy streaming:** works with no buffering (SDK `messages.stream()` text lag 1–2 ms,
    11 ms worst). The preflight passes from `http://tauri.localhost` and
    `http://localhost:1431`. Requirements found:
    - The allow-headers list must cover every `x-stainless-*` header the SDK sends.
    - Strip `accept-encoding`, so the SSE stays uncompressed for the usage tee.
    - Use `reqwest` with `default-features = false` + `stream`, `native-tls`, `http2` (the
      default rustls pulls a C build of aws-lc-sys).
    - The key is read with `CredReadW` from the generic credential `duck/anthropic-api-key`
      (UTF-16LE, as `cmdkey` writes it). JS only ever gets `{baseUrl, token}`.
    - An unknown origin's preflight gets 403; a bad token gets 401. Upstream never sees the
      launch token or an Origin header.
  - **Main thread, measured** (20 samples, 18 stub tools, a 4.3k-token system + tools prefix,
    1-hour cache):

    | Config | Correct first tool | Warm avg / max per turn | First token (median) |
    |---|---|---|---|
    | Sonnet `low` | 20/20 | $0.0072 / $0.015 | 0.73 s |
    | **Sonnet `medium`** | **20/20** | **$0.0049 / $0.011** | **0.72 s** |
    | Sonnet `low`, thinking between tools | 20/20 | $0.0080 / $0.018 | 1.13 s |
    | Haiku `low` | 19/20 | $0.0004 / $0.0007 | 0.57 s |

    - Medium is *cheaper* than low (fewer, better-aimed rounds), so it became the default.
    - A cold cache costs ~$0.021 per turn on Sonnet. Changing effort keeps the cache;
      changing the thinking type breaks it. After a 20-minute gap, the cache was fully read
      (the 1-hour TTL works).
    - A 10-turn conversation averaged $0.007 per turn, growing ~1.5k cached tokens per turn
      from the repeated state snapshot. So: small, diffed snapshots and context editing (A2).
    - Haiku's slips: it refused a requested PR citing Duck's own push rule, put English inside
      a Russian reply, and answered from a stale result. That's fine for its jobs, not as the
      main thread.
    - Sonnet writes markdown even in replies meant to be spoken: a prompt rule, plus stripping
      before TTS (V2).
    - Total X0 API spend ≈ $1.20.
  - **Tool versions** (Models API `capabilities`): Sonnet 5.5 and Haiku 5.5 both take
    `web_search_20260209` / `20250305` and `web_fetch_20260209` / `20250910`. The dynamic-
    filtering versions add code-execution rounds (Sonnet search: 8.4 s and $0.042 vs 2.7 s
    and $0.030), so B1 uses the basic versions for quick lookups. Sonnet 5.5 thinking is
    `adaptive` or `between_tools` only (`disabled` → 400); Haiku 5.5 takes `adaptive` or
    `disabled`.
  - **Billing (verified 2026-10-18):** the Max API credits are live and stop when exhausted,
    never billing the plan; see the intro. The pause announced in June concerned moving Agent
    SDK / `claude -p` usage off subscription limits; those still use subscription limits.
  - **Subscription brain** (inputs for M3): one persistent `claude -p` with stream-json in and
    out, Duck's 18 tools served over MCP (flags in M3).
    - 17/20 correct first tools; the misses were harmless (refreshing a list before
      answering) except one, which checked a session instead of queuing the prompt.
    - First output after a median 1.64 s (API: 0.72 s); a whole turn 3.3 s (API: 2.2 s).
    - Cost: about 1 point of the 5-hour window for 20 turns ($0.176 API-equivalent;
      `total_cost_usd` is cumulative per session).
    - `--bare` is unusable: it disables OAuth.
  - **Claude Code:**
    - `--model` / `--effort` alongside `--session-id` are safe: hooks key on `session_id`,
      and every hook carries `effort.level`. Without explicit flags, a worker inherits your
      defaults (Opus, `xhigh`, `auto`), so D1 always passes them.
    - Consoles authenticate with the subscription (`apiKeySource: none`). Children inherit
      Workbench's environment, so **an `ANTHROPIC_API_KEY` in Workbench's environment would
      switch every console to API billing**. A1 keeps the key out of the environment, and
      `claude_command` removes that variable defensively.
    - The trust dialog for a new folder defaults to "No, exit": D1 pre-trusts the Duck folder.
  - **Permission modes** (10 calls each, with prompts disabled):
    - `dontAsk` + allow list = exactly the allow list; everything else is a hard deny. Denials
      reach the model as tool errors and are listed in `result.permission_denials[]`.
    - **`auto` is not a floor.** Its classifier accepted `git push --force origin main` and
      `rm -rf ../outside-junk` (which it deleted) when framed as a scratch-folder test.
      **Decision:** workers run `dontAsk` + allow list (D1); the trust floor applies under
      every mode.
    - Allow rules behave the same from `--settings` and `settings.local.json`. Under `auto`, a
      matching rule skips the classifier (which takes 0.2–2.5 s).
    - Read-only Bash (`git status`, `wc -w`) is auto-allowed everywhere; PowerShell is not.
  - **Worker sessions** (research at Sonnet `high`, a ~1,500-word write-up at Opus `medium`, a
    Firefox chore at Sonnet `medium`):
    - First event after 2.4–2.9 s; done in 63 s, 138 s and 17 s.
    - `result.md` / `result.json` correct on the first try in 3/3 (the chore correctly
      reported `blocked`: the add-on wasn't connected).
    - Peak RSS 420–441 MB per worker process tree. The user-scoped Firefox MCP spawns a
      bridge (~140 MB) in every worker, so non-browser workers get `--strict-mcp-config` with
      a minimal config.
    - Usage: research ≈ 1 point of the 5-hour window, the Opus write-up ≈ 2, the chore ≈ 0
      (shared account, so upper bounds). Live limits come from the stream-json
      `rate_limit_event`: `rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization`.
  - **PermissionRequest payloads** (10 captured: Bash, Edit, Write, WebFetch, firefox MCP,
    Read outside the folder, WebSearch, PowerShell):
    - `tool_name` + `tool_input` (+ `mcp_server.name`) are enough for T1's matcher.
    - `permission_suggestions` names the rule Claude Code would add, so T3 can use it.
    - Option 1 is always labelled "Yes". There are 2–4 options, and option 2 may be a mode
      switch, so T2 answers by the "Yes" label, never by position 2.
  - **Presence:** `GetLastInputInfo` works. Do Not Disturb is readable from WNF state
    `0x0D83063EA3BF1C75` (1 = on, 0 = off), verified both ways. `QueryUserNotificationState`
    does *not* reflect it.
  - **Autopilot mechanics:**
    - Manual `/compact <focus>` followed by a queued prompt works (checked by you, both views).
      Hook order: PreCompact → ~9 s → SessionStart{source: compact} → 150 ms → PostCompact.
    - **Probable bug, not reproduced:** the reducer's `to("idle")` on SessionStart{compact}
      clears `compacting` before PostCompact. During a mid-turn *auto*-compaction, that would
      show a working session as idle and could deliver a queued prompt mid-turn. Fix:
      SessionStart{compact} only clears `compacting` and keeps the phase.
    - Sending `/compact` and then queueing "continue" races (the card is at rest until
      PreCompact): use `setQueued`, or wait for PreCompact.
    - The statusline POST carries `context_window.used_percentage` per session, but
      `statusline::ingest` drops it. P1 keeps it per instance.
  - **Firefox bridge (FoxMCP 3.4.9):**
    - A second `--stdio` bridge spawned from Rust (`rmcp`) gets all 51 tools; the first
      keeps working. The second moves to port 8766.
    - The tool definitions are ~12k tokens, so they stay behind `defer_loading`.
    - ~145 MB per bridge (launching the venv's python directly saves ~50 MB).
    - With the `claude-agent` profile open, the add-on connects in 4.7 s, a second bridge in
      14.9 s, and a reconnect takes 1.4 s.
    - **The add-on is only in the `claude-agent` profile**, which Firefox's new profile
      switcher doesn't show. Duck starts that profile on demand
      (`firefox.exe -P claude-agent --no-remote`) when a browser task needs it (B2).
    - Ports don't authenticate local processes (accepted upstream for single-user machines).
  - **STT, on your recordings** (laptop mic; 8 English, 8 Russian, 4 mixed). Word error rate,
    case and punctuation ignored:

    | Engine | English | Russian | Mixed | Per command |
    |---|---|---|---|---|
    | **Parakeet v3, CUDA** | 3.4% | **0.0%** | 38% | **~0.1 s** |
    | Whisper turbo, CUDA | 3.4% | 9.4% | 29% | ~0.55 s |
    | Parakeet v3 int8, CPU | (see below) | 3.1% | 38% | 0.4–0.8 s |
    | Whisper turbo, CPU | 3.4% | 9.4% | 29% | 10–20 s (unusable) |

    - **Parakeet is the engine; Whisper is dropped.** On your voice it beats Whisper in
      Russian too (the public FLEURS set had said the opposite: 5.0% vs 3.0%), and Whisper
      writes numbers as digits ("14.30").
    - **Mixed sentences:** both engines write English terms in Cyrillic («пул реквест для
      воркбенч», «колод код», «юс сешн»). Duck's model understands them. The name fixer (V1)
      maps known names back; code identifiers are better typed.
    - **The int8 CPU model sometimes returns empty text** when there's ~1 s of silence before
      the speech. The same audio, trimmed or shifted by 0.5 s, transcribes correctly; fp32
      never fails. V1 trims at the VAD bounds, and retries once in fp32 on an empty result.
    - GPU: warm 0.1–0.23 s from Rust (`transcribe-rs` 0.3.12; pin `ort = 2.0.0-rc.12` with
      `load-dynamic`), but **3.6 GB VRAM** (to reduce before V1: an fp16 export or an arena
      cap). Waking the sleeping dGPU adds 0.57 s. DirectML picks the iGPU and is slower.
      The Rust path is 2.5–3× slower than Python's `onnx-asr` (worth a look in V1).
  - **TTS** (decided by your listening test 2026-10-19; details in §Spoken replies):
    - Kokoro `af_heart` for English and Silero `kseniya` for Russian, both local on the CPU.
      First audio in 0.18 s, ~1.4 GB RAM with both loaded.
    - Qwen3-TTS is dropped: slower than real time, no Russian voice at 0.6B.
    - Silero drops all non-Cyrillic text, digits included, so a speakable rewrite is
      mandatory. Kokoro reads English numbers well, apart from small slips ("3.5", "#128")
      that a rule pass handles.
    - Chirp 3 HD stays optional. The free-quota question no longer matters, so it wasn't
      re-checked.
  - **End of turn** (your 10 thinking-aloud monologues, ~11 minutes; Silero VAD v6.2.3 +
    Smart Turn v3.2 on the CPU; listening costs 3.8% of one core):

    | Policy | False end-of-turns | Wait after you finish |
    |---|---|---|
    | Pipecat default / plan's assistant / chat | 97 / 112 / 99 | 0.2–0.3 s |
    | Patient (Smart Turn ≥ 0.7 from 1.5 s, ceiling 8 s) | 18 (you resumed within 2 s each time) | 1.5 s |
    | **Strict (Smart Turn ≥ 0.8 only from 3 s, ceiling 8 s)** | **1** | **~3 s** |

    Smart Turn rates mid-thought pauses as "complete" with ~0.98 confidence, so for thinking
    aloud the silence length does the work. **Rubber duck uses the strict policy**, chat the
    patient one; the quick policies are for short commands only (V4).
  - **Echo** (record + score scripts: `voice/record_echo.py`, `voice/score_echo.py`; AEC3 run
    offline through livekit's WebRTC `AudioProcessingModule`):
    - **Laptop speakers**, normal volume, laptop mic: the echo reaches the mic at -32 dBFS.
      **AEC3 with the playback reference removes ~30 dB.** No false barge-ins in 3 minutes
      (raw: one every ~2 s). Every one of your interruptions fired ~0.29 s after you started
      speaking (you reacted to the on-screen cue in 1.1–1.5 s). Playback → mic delay ~165 ms,
      tracked by AEC3's own estimator.
    - **Headphones** (BlackShark V3 Pro over Bluetooth): the echo at the mic is -66 dBFS,
      i.e. none, with no false barge-ins. The interruption timing of that run is unusable: the
      recorder's output position fell ~1 minute behind its cues, though playback sounded
      clean throughout, so it's a recorder timing quirk on Bluetooth. With no echo it isn't
      needed.
    - The barge-in gate and the self-voice check had nothing left to catch on these runs.
      They stay as insurance for louder volumes and other rooms.
    - **Windows' communications-mode processing wasn't needed, so it isn't compared.** The
      phone run waits for R2.
    - Laptop mic notes: in exclusive mode the mic array opens only with its 4 native channels
      (1 channel fails as "invalid device"). The recordings went through shared mode,
      including the Realtek driver's effects, which didn't hurt.
    - The BlackShark's Bluetooth hands-free mic gates speech (drops to silence, then fades
      back in), so it's a poor mic for Duck.
  - **Screen:**
    - `xcap` captures both monitors, including the DisplayLink ARZOPA screen (WGC ~31 ms),
      and single windows (26–34 ms). Minimized windows can't be captured, so Duck says
      "it's minimized".
    - Haiku read a dense 1568×843 Workbench screenshot nearly verbatim (2 tiny slips), in
      7.2 s for $0.0011 at `low`.
    - `Windows.Media.Ocr` has `en-US` and `ru` installed.

### Track A — Core

#### Step A1 — API key in the keychain + loopback proxy + usage ledger

- **Goal:** The webview can call the Claude API with streaming, without ever holding the key,
  and every call is metered.
- **Depends on:** X0.
- **Build:**
  - New module `src-tauri/src/assistant/` with:
    - `key.rs`: the Windows generic credential `duck/anthropic-api-key`
      (`duck-dev/anthropic-api-key` for the debug build). Both were stored with `cmdkey` on
      2026-10-19, the dev one as a separate Console key.
      - Read with `CredReadW` and decoded as UTF-16LE, the way `cmdkey` writes it (X0's
        spike code). Use the `windows` crate directly rather than `keyring`, so the
        encoding matches what `cmdkey` stores.
      - Commands `assistant_key_set`, `assistant_key_status` (present / absent, never the
        value), `assistant_key_clear`. `assistant_key_set` writes the same format, and the
        recommended way to enter a key stays `cmdkey` in your own terminal.
    - `proxy.rs`: an axum route `/anthropic/{*path}` merged into the hook server router.
      - Checks `x-api-key == launch token` (32 random bytes, minted at startup, handed out by
        `assistant_proxy_info` → `{baseUrl, token}`).
      - Swaps the key in and forwards with `reqwest`, streaming the body both ways.
      - Answers `OPTIONS` with CORS for the Tauri origin only.
      - Forwards the `anthropic-version` and `anthropic-beta` headers.
    - `usage.rs`: tees the SSE stream and parses `message_start.usage` +
      `message_delta.usage` (+ `server_tool_use` counts).
      - Prices come from a table in code (model → $/MTok for input / output / cache write /
        cache read).
      - Inserts into `assistant_usage(ts, model, purpose, in, out, cache_w, cache_r,
        searches, cost_usd)`. `purpose` comes from an `x-wb-purpose` request header, which
        is stripped before forwarding.
    - `budget.rs`: month-to-date sum. Above the hard cap → `402`-style JSON error the engine
      recognizes. Command `assistant_spend` → today / month / by model.
  - `db.rs`: open Duck's own `duck.db` (`duck.dev.db`) next to `workbench.db`, with its own
    append-only `MIGRATIONS` (the same pattern as `src-tauri/src/db/mod.rs`). First
    migration: `assistant_usage`.
  - Settings: an "Assistant" section in the existing settings/appearance UI with a key field,
    a test button (a one-token Haiku call) and budget limits.
- **Key files:** `src-tauri/src/assistant/*`, `src-tauri/src/hooks/server.rs`,
  `src-tauri/src/db/mod.rs`, `src-tauri/src/lib.rs`, `Cargo.toml` (`reqwest` with
  `stream`; the `windows` crate's credential API).
- **Done when:**
  - A test call streams through the proxy and lands in `assistant_usage` with the right cost.
  - A request with a wrong token is rejected.
  - The key isn't in prefs, the DB or logs (checked with `grep`).
  - Consoles spawned afterwards have no `ANTHROPIC_*` in their environment.
- **Out of scope:** the agent loop.
- **As built (2026-10-19):**
  - `src-tauri/src/assistant/{mod,key,proxy,usage,budget,db}.rs`. `crate::db::run_migrations`
    is now shared by `workbench.db` and `duck.db`.
  - **Key:** read with `CredReadW` on every proxied request (not cached), so a `cmdkey`
    change applies at once. `assistant_key_set` writes UTF-16LE, `CRED_PERSIST_LOCAL_MACHINE`
    (not roamed). With no key, the proxy answers `401` with the `cmdkey` line to run.
  - **Proxy:** on the hook server's port; `assistant_proxy_info` → `{baseUrl, token}`.
    - Forwards only `POST v1/messages`, `POST v1/messages/count_tokens` and `GET v1/models[/id]`.
      Batches, files and the rest are refused, since their usage would bypass the ledger.
    - Body limit 32 MB (axum's default of 2 MB is too small for screenshots).
    - Browser origins other than `http(s)://tauri.localhost` and the vite dev server get
      `403`; callers with no origin still need the token.
    - `reqwest` 0.13 with `native-tls` (Schannel) + `http2` + `stream`; `accept-encoding` is
      dropped so the meter reads plain bytes.
  - **Ledger:** a meter rides the response stream and writes the row when the body ends or
    the caller hangs up (a cancelled turn's tokens are billed too), then emits
    `assistant-usage`.
    - It reads `message_start.usage` + `message_delta.usage` (cumulative), or a JSON
      message's `usage`.
    - Prices are from the pricing page (2026-10-19), matched by model prefix. Cache writes
      are priced by TTL (`cache_creation.ephemeral_5m/1h`); web search is $0.01 each;
      Haiku 5.5's >100k-token prompt tier is applied; an unknown model is priced like
      Fable (the most expensive) so the budget errs early.
    - `purpose` comes from `x-wb-purpose`, sanitized to `[a-z0-9_-]`, `other` if absent.
      **The main thread must send `thread`** (A2): it's what the cap tells apart from
      primitives.
  - **Budget:** limits in `duck.db`'s `meta` (`{hardCapUsd: 90, softRatio: 0.8}`), months
    in local time. At the cap: `402` with `error.type = "budget_exceeded"`, except Haiku with
    any purpose but `thread`. `assistant_spend` also returns `byPurpose`, `softReached` and
    `capReached`.
  - **UI:** a **◆ duck** status-bar menu (next to remote / notifications) instead of a
    section in the appearance menu: key present/absent + the `cmdkey` line, an optional
    password field, the test button, spend by model and purpose, and the budget fields.
    The test is a plain streamed `fetch` (Haiku, `max_tokens: 1`, thinking off); the SDK
    arrives in A2.
  - **Verified:** the test call streamed through and landed as `claude-haiku-5-5 / test`,
    8 in / 1 out, $0.0000013 (8 × $0.10 + 1 × $0.50 per MTok). A wrong token got `401`, a
    foreign origin `403`. The key was found in none of 2,389 files (app data, both DBs,
    the dev log). Nothing in the backend sets `ANTHROPIC_*`, and consoles inherit the
    app's environment, which has none.

#### Step A2 — Assistant engine: loop, tool registry, threads

- **Goal:** A headless TS engine that runs a conversation with tools, streams events, and
  persists everything.
- **Depends on:** A1.
- **Build:**
  - `npm i @anthropic-ai/sdk zod`. Client:
    `new Anthropic({ baseURL, apiKey: token, dangerouslyAllowBrowser: true })`, built from
    `assistant_proxy_info`.
  - The main window gets WebView2 args `--disable-background-timer-throttling
    --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (X0: with
    them, timers keep running even if a webview is hidden). Hiding to the tray stays
    `window.hide()`, never hiding the webview itself.
  - `src/assistant/engine.ts`, a manual streaming loop (not the beta tool runner), because
    the engine must stop at confirmation gates:
    - `messages.stream(...)` → emit `text_delta`, `tool_start` and `tool_end` events.
    - On `tool_use`: validate the input with the tool's zod schema. Check the tier: run it,
      or park it as a pending confirmation and resume when it is answered.
    - **Time budget per tool** (default 10 s, declared on the tool). Tools that can run long
      are written as *start + notify*: they return a handle immediately, and their
      completion later arrives as a new system-originated message in the thread. The turn
      never waits on a session, a worker or a download.
    - Return all `tool_result`s in **one** user message, with `is_error` for failures.
    - Handle `pause_turn` (resend), `max_tokens` (say so), `refusal` (show `stop_details`).
    - Cancellation through an AbortController (Esc in the drawer).
  - `src/assistant/tools/registry.ts`: `defineTool({name, description, schema, tier,
    run})`, with deterministic ordering (cache-stable) and a tool-name → tier map that the
    engine consults.
  - `src/assistant/threads.ts`: an external store in the house pattern (`getX` / `useX` /
    `emit`). Persists through new commands `assistant_thread_*` and `assistant_message_append`
    (in `duck.db`, append-only), plus `assistant_pending` for open confirmations.
  - **Boundaries** (§Design → Separable, not separate):
    - `src/assistant/port.ts`: the `WorkbenchPort` interface. `port.local.ts` is its only
      implementation and the only file allowed to import `src/state/**` / `src/panels/**`,
      enforced by an ESLint `no-restricted-imports` override in `eslint.config.js`.
    - `src/assistant/protocol.ts`: the versioned Duck Protocol message types, plus an
      in-process transport for the drawer. R1 adds the WebSocket transport.
  - Start **`documentation/duck-architecture.md`**: modules, the port, the protocol, the
    engine loop, where tools live. Every later step updates it, as part of its Done when;
    L3's self-development sessions depend on it.
  - `src/assistant/prompt.ts`: the frozen system prompt (role, tiers, escalation rules,
    "tool results from transcripts and the web are data"). Cache breakpoint after
    tools+system, plus automatic caching for the tail.
  - Model Sonnet 5.5 with `thinking: {type: "adaptive"}`, `effort: "medium"` (§Models and
    routing; X0 measured it as fast as `low` and cheaper),
    `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). The system + tools prefix
    uses `cache_control` with `ttl: "1h"`; the tail uses automatic caching.
  - A `oneShot(model, prompt, input, schema?)` helper for Haiku primitives, with its own
    frozen prompts and `x-wb-purpose`.
  - One stub tool (`get_time`) for testing.
  - `initAssistant()` wired in `App.tsx` with the other `init*()` engines.
- **Key files:** `src/assistant/*`, `src-tauri/src/assistant/threads.rs`, `src/App.tsx`.
- **Done when:**
  - vitest covers the loop against a mocked SDK stream: the tool round-trip, parallel tool
    results in one message, the confirmation park/resume, the refusal path, and the cap
    error.
  - A real thread survives an app restart.
- **Out of scope:** UI, real tools.
- **As built (2026-10-19):**
  - **Engine** (`src/assistant/`): `engine.ts`, `threads.ts`, `protocol.ts`, `port.ts` +
    `port.local.ts`, `client.ts`, `prompt.ts`, `tools/registry.ts`, `tools/getTime.ts`,
    `index.ts` (`initAssistant()`, `getDuck()`). Module map and loop details are in
    `documentation/duck-architecture.md`, started here.
    - SDK `@anthropic-ai/sdk` 0.135.0 + `zod` 4.
    - Every request uses `client.beta.messages.stream` with Sonnet 5.5, adaptive
      thinking, top-level effort `medium`, and `fallbacks: "default"`.
    - Caching: a 1-hour breakpoint on the system prompt (covering tools + system) plus
      automatic 1-hour caching for the tail. Longer TTLs must come first, so both are
      1 hour.
    - Context editing: `clear_tool_uses` past 40k input tokens, keeping 6.
    - Fixed betas: context management, per-message effort, server-side fallback. The
      header is identical on every request.
    - Per-message effort is a mid-conversation system message
      `{content: [], output_config: {effort}}`, appended only when the effort changes, so
      the cache survives.
    - Stop reasons:
      - `pause_turn` resends.
      - `max_tokens` keeps the reply only if it has no tool call.
      - `refusal` isn't kept and shows `stop_details.explanation`.
      - `model_context_window_exceeded` shows a notice.
      - More than 25 rounds stops the turn.
    - Tools: validated with zod, then gated by tier (`tierGate`: consequential → ask; T1
      replaces it).
      - Runnable calls run in parallel, each within its time budget. A timeout aborts the
        tool's signal and becomes an `is_error` result.
      - All results go back in one user message.
      - A batch with an ask is parked in `assistant_pending` (results so far included).
        `confirm()` resumes it once every ask is answered; a denied call is sent back as
        an error.
    - Stop:
      - Mid-stream, the reply's text is kept, and thinking and half-made tool calls are
        dropped.
      - Mid-tools, the results are stored and the unfinished ones become "stopped".
      - While parked, every ask is answered "stopped".
    - Messages that arrive mid-turn or while parked are queued per thread, never dropped.
    - Notices (`role: notice`: stopped, cap, refusal, max_tokens, context, error, rounds)
      are shown and never sent. `toApiMessages` filters them out, and also drops a system
      message a failed turn left in front of a user message.
    - The first message names the thread through the `title` primitive (Haiku, thinking
      off) via `oneShot`, purpose `title`.
  - **Storage:** `duck.db` migration v2 adds `assistant_threads`, `assistant_messages`
    (append-only; a trigger refuses UPDATE, and `append` refuses any `seq` but the next)
    and `assistant_pending`. Commands:
    - `assistant_thread_create` / `_list` / `_messages` / `_title`;
    - `assistant_message_append`;
    - `assistant_pending_put` / `_list` / `_clear`.
  - **Boundaries:**
    - The ESLint `no-restricted-imports` override is checked: a probe import of
      `../state/…` and `../../panels/…` fails, and `port.local.ts` is exempt.
    - Protocol v1 has `sync` / `thread.open` for a surface connecting, and
      `threads` / `history` / `error` events. There are no React hooks on the store;
      surfaces read through the protocol.
  - **WebView2 profile** (`src-tauri/src/window.rs`):
    - The three no-throttling args (plus wry's defaults, which they replace) go on every
      webview.
    - **The main window is now built in Rust** (`create: false` in `tauri.conf.json`), and
      tear-offs go through a `window_open_torn` command. The frontend lost
      `core:webview:allow-create-webview-window`.
    - Why: WebView2 refuses a second webview on a data folder in use with different args.
      Found live: the dev build stayed blank next to the installed release, which shares
      `%LOCALAPPDATA%\com.workbench.app\EBWebView`. The tear-offs also share
      `localStorage` (composer drafts) with the main window.
    - Debug builds now use their own folder (`…\com.workbench.app\dev`), so dev and
      release no longer share webview storage.
  - **UI stand-in:** a "try duck" box in the ◆ duck menu (`src/panels/AssistantTry.tsx`)
    speaks the protocol until the drawer (A3) replaces it.
  - **Verified:**
    - 13 vitest cases against a scripted SDK stream: the tool round trip and request
      shape, parallel results with failures, park → restart → confirm → resume, decline
      plus a queued message, queueing, refusal, the cap's `402`, stop mid-stream,
      `max_tokens` with a tool call, `pause_turn`, per-message effort, and byte-identical
      params whatever the tool order.
    - 2 Rust tests on threads.
    - Live: "what time is it in Bangkok?" called `get_time` and answered. Two Sonnet
      rounds: $0.0031 cold, then $0.0015 reading 1,143 cached tokens. The Haiku title
      ("Bangkok Local Time Query") cost $0.00002.
    - After an app restart the thread came back with its 4 messages, and a console
      tear-off still worked on the new profile (both checked by you).

#### Step A3 — The Assistant drawer (desktop UI)

- **Goal:** Talk to the Assistant from anywhere in the app.
- **Depends on:** A2.
- **Build:**
  - **The Duck button** goes at the far left of `TitleBar` (`src/App.tsx:334`). That spot is
    empty today; the bar's centre holds the project name and its right side holds the
    palette, templates and presets buttons.
    - Styled like `PaletteButton` (mono, uppercase, accent glyph) with a duck glyph and
      "DUCK".
    - Clicking it runs `toggleAssistant`.
    - **Hover tooltip** (a styled popover, not a bare `title`, so the letters can be
      emphasised):
      **D**ispatch · **U**nderstand · **C**oordinate · **K**eep watch, then the shortcut on a
      second line, e.g. "Ctrl+Space · hold Ctrl+Alt+Space to talk". `aria-label` carries the
      same text.
    - The button doubles as a status light:
      - a dot for open confirmation cards (with count);
      - a "trust paused" marker (T1);
      - the voice state when listening / thinking / speaking (V1/V4);
      - a warning tint near the budget cap.
  - `src/panels/Assistant/` is a **left-side drawer** anchored under the button, over the dock;
    not a dock panel, since the Assistant isn't per project. It is resizable, and its width is
    saved in prefs.
    - It is toggled by a new `CommandId` `toggleAssistant` (default Ctrl+Space; check for
      conflicts in `keymap.ts`) and listed in the palette.
  - Thread view:
    - Markdown through `marked` + `DOMPurify`, streaming text.
    - Tool chips (collapsed: name + one-line summary; expandable to input and output).
    - **Confirmation cards** (Allow / Deny, showing exactly what will happen).
    - A "Sonnet" toggle for the next message.
    - A spend line (this turn's cost; month-to-date / cap).
  - Composer: Enter sends, Shift+Enter makes a newline, Esc stops. "New thread" and a thread
    list.
    - Typing while Duck is mid-reply queues the message, shown as pending; a pref switches
      this to "interrupt and answer this instead".
  - **Always available:** a pref "Start Workbench at login, minimized to tray"
    (`tauri-plugin-autostart`, a new dependency). Duck's engine initializes with the app,
    not when the drawer first opens.
  - Clicking an instance mentioned in a reply focuses that console (`dock.activatePanel`).
- **Key files:** `src/panels/Assistant/*`, `src/keyboard/keymap.ts`,
  `src/keyboard/commands.ts`, `src/App.tsx`, theme tokens.
- **Done when:**
  - You can chat with the stub tool, stop a reply mid-stream, approve a stub
    "consequential" call, and see the cost.
  - The drawer works over any layout, and reopening it restores the thread and scroll
    position.
- **Out of scope:** voice, the phone.
- **As built (2026-10-19):**
  - **Button:** `DuckButton` at the far left of the title bar, labelled "D.U.C.K.", with
    your duck icon just right of it, outside the button (a CSS mask in the theme's
    accent; the eyeless version below 20 px, the one with the eye in the drawer header). The tooltip spells out the acronym and shows the bound shortcut.
    Status light: a red badge counting open confirmations (any thread), and an amber/red
    tint past the soft limit/cap.
  - **Hotkey:** `toggleAssistant` defaults to **Ctrl+Shift+Space**, not Ctrl+Space:
    Ctrl+Space is a terminal control code (NUL), PowerShell's MenuComplete, and fails the
    keymap's own global-safety rule. `Space` became a mappable key.
  - **Drawer** (`src/panels/Assistant/`): left side, over the rail and the dock, resizable,
    width in prefs. Always mounted, only hidden, so closing and reopening keeps the thread
    and its scroll; the open thread is restored after a restart. The dock's root got
    `isolation: isolate`, so floating dock groups stay under the drawer and modals above.
    - Thread view: markdown replies (`renderMarkdown`: marked + DOMPurify) streaming in,
      tool chips (name + one-line input, expanding to input and output), notices.
    - Confirmation cards (Allow / Deny with the exact input); a confirmation in another
      thread shows as a line that opens it.
    - Spend line: this turn's cost, month / cap. The protocol gained a `spend` event
      (on `sync` and after every metered call); `spend.ts` bills each `thread` call to the
      one turn that is calling.
    - Composer: Enter sends, Shift+Enter is a newline, Esc stops a running reply (and
      closes the drawer when idle). A message sent mid-reply shows as a dashed "queued"
      bubble; the ⚙ setting makes it interrupt instead.
    - Thread list (▾ on the title) and "+ new" (the thread is created by its first
      message).
    - **"think hard" instead of "Sonnet":** the main thread is already Sonnet, so the
      toggle raises the next message's effort to `high`. The Sonnet toggle waits for M2's
      Haiku thread.
  - **Session links:** the system prompt asks Duck to link a session it names as
    `[name](#session/<id>)`; clicking one opens that console (`setActiveProject` +
    `openConsole` + `activatePanel`) and closes the drawer. Live only once W1 gives Duck
    session ids.
  - **Start at login, minimized to the tray:** `tauri-plugin-autostart` **pinned
    `~2.5.1`** (2.6+ needs Tauri 2.12, which would have pulled a wry upgrade into this
    step), launched with `--minimized`; `window::build_main` then builds the main window
    hidden. The tray icon had no click action, so a left click now shows the window. The
    setting is disabled in dev builds (it would register the debug binary).
  - **Stub:** `test_confirm`, a consequential tool that does nothing, in dev builds only.
  - **Language rule** (from the first live test, where Duck switched to Russian
    mid-thread): Duck always answers in English; you may write English, Russian or
    Spanish. Titles are English too. See Languages at the top.
  - The ◆ duck status-bar menu lost its "try duck" box (`AssistantTry.tsx` deleted).
  - **Verified:** vitest 223 (6 new: the turn meter, `toItems`, links), cargo 169,
    clippy and tsc clean. Live, by you: chat with `get_time`, stop mid-stream, an
    approved `test_confirm`, the spend line, threads, close/reopen and restart keeping
    the thread and scroll, the icon and tooltip.

#### Step A4 — Deleting threads

- **Goal:** Clear out threads you don't want to keep (asked for after A3, 2026-10-19).
- **Depends on:** A3.
- **Build:**
  - `assistant_thread_delete(thread_id)`: one transaction removing the thread, its messages
    and its parked batches from `duck.db`. Messages stay append-only while a thread exists;
    the trigger refuses UPDATE only, so a whole-thread DELETE is allowed.
  - Protocol: a `thread.delete` client message and a `threadDeleted` event, so every
    surface drops it. The engine refuses while the thread has a turn running (stop it
    first) and drops its queue and any open confirmations.
  - Drawer: a delete control on each row of the thread list (and for the open thread),
    with an inline "delete? yes / no" confirm; deleting the open thread opens the next
    most recent one, or a new thread.
  - Spend rows in `assistant_usage` stay: they are the month's record, not the thread's.
  - Later steps that derive data from threads (memory in W4/L) say what a delete does to
    it; until then a delete simply removes the conversation.
- **Key files:** `src-tauri/src/assistant/threads.rs`, `src/assistant/threads.ts`,
  `engine.ts`, `protocol.ts`, `index.ts`, `src/panels/Assistant/*`.
- **Done when:** a thread deleted in the drawer is gone after a restart, its parked
  confirmation is gone from the button's badge, and a test covers the store, the
  engine's refusal mid-turn, and the Rust delete.
- **Out of scope:** archiving, bulk delete, undo.
- **As built (2026-10-19):**
  - Rust `threads::delete` + `assistant_thread_delete`; the store's `remove()` waits for
    any append in flight first. The engine's `deleteThread` refuses a running reply,
    drops a parked batch and the queue, and emits `threadDeleted`.
  - Drawer: a ✕ on each thread-list row (on hover, always on the open thread), then
    "delete “title”? yes / no". Disabled while that thread's reply runs. The drawer also
    shows Duck's errors now (A3 stored them but never displayed them), e.g. a refused
    delete.
  - Verified: 2 engine tests (refusal mid-reply then delete; a parked thread's
    confirmation, queue and batch go), 1 Rust test (only that thread's rows go; the id
    can be reused).

### Track W — Workbench tools

#### Step W1 — Read tools

- **Goal:** The Assistant can answer "what's going on?" accurately.
- **Depends on:** A2.
- **Build:**
  - `list_projects`: id, name, path, group.
  - `list_sessions(projectId?)`: instance id, title, project, live phase from
    `getLiveStatuses()`, pending choice summary, worktree, model (after M1), last activity.
  - `get_pending_choice(instanceId)`: the kind, question and options from `pendingChoice.ts`.
  - `read_session(instanceId, maxMessages=20)`: a new helper
    `src/transcript/plainText.ts` (page back with `readTranscriptBack`, fold with
    `createTranscript().prepend`, serialize user / assistant / tool-summary items to text,
    cap the characters). The output is wrapped as `<transcript … untrusted>`.
  - `usage_limits`: from `usage_limits` (5-hour and weekly) for the Claude Code
    subscription.
  - `git_overview(projectId)`: branch, ahead/behind, changed files, last 10 commits (wrapping
    the existing git commands). Read only.
  - `list_notes(projectId)` and `read_note(projectId, name)`, through the Workbench notes
    module (improvement plan N1). `read_note` returns the revision that Duck's writes must
    name. Notes are your writing, but they are returned as data, never instructions: a
    note can't grant Duck a permission.
  - `assistant_spend`.
  - Tool descriptions say *when* to use each one. Each output is a compact JSON summary,
    never raw dumps.
- **Key files:** `src/assistant/tools/read.ts`, `src/transcript/plainText.ts` (+ test).
- **Done when:** "which sessions need me?", "what is the backend agent doing right now?" and
  "what changed in project X today?" are answered correctly against live sessions, and each
  tool has a unit test with fixture stores.
- **Out of scope:** anything that writes.
- **As built (2026-10-19):**
  - Nine tools in `src/assistant/tools/read.ts`, all read tier: `list_projects` (with
    session and needs-you counts), `list_sessions(project?)`, `get_pending_choice`,
    `read_session(session, maxItems=20)`, `usage_limits`, `git_overview(project,
    session?, since?, commits?)`, `list_notes`, `read_note`, and `duck_spend` (named for
    Duck rather than `assistant_spend`, so the model reads it as its own cost).
  - Projects and sessions can be named by id **or name** (a session title must be unique,
    or come with its project), so "what is the backend one doing?" needs no lookup round.
    A miss or an ambiguity lists the candidates in the error.
  - `git_overview` also reads a session's worktree (`session`), lists the agent branches
    checked out in worktrees, and takes git's `since` syntax ("midnight") for "what
    changed today". A remote (SSH) project is refused: its repo isn't on this machine.
  - `read_session` uses the new `src/transcript/plainText.ts`: it pages back until it
    has enough items, writes one line per item (tool calls as `tool Bash: npm test
    [error]`, with a failure's reason or a subagent's report under it), and caps at
    12,000 characters from the oldest end. The tool-summary helpers moved from
    `render.ts` to `src/transcript/summary.ts` so both share them. The output is wrapped
    `<transcript … untrusted>` and a `</transcript>` inside is defused.
  - The model column came with M1. The port grew the members these tools need; tests
    use `fakePort` (`src/assistant/fakePort.test-util.ts`), and the engine test moved to it.
  - The system prompt gained one line: re-read session state with the tools, since earlier
    results in the thread go stale.
  - **Verified:** 14 new vitest cases (9 tools over fixture stores, including the
    wrapper that can't be closed from inside; 5 for `plainText` over the T0 session),
    tsc and eslint clean.

#### Step W2 — Action tools + the confirmation policy

- **Goal:** The Assistant can drive sessions the way you do from the phone.
- **Depends on:** W1, A3.
- **Build** (every action goes through the existing modules; no new keystroke code):
  - `send_prompt(instanceId, text)`: `sendOrQueue()`. Reports "sent" or "queued until done".
    Tier: in-app.
  - `create_session(projectId, title?, prompt, worktree?, model?)`: the `remoteCreate.ts`
    path. Tier: in-app.
  - `start_session` / `resume_session(instanceId, sessionId?)`: `openConsole` /
    `resumeConsole`. Tier: in-app.
  - `answer_choice(instanceId, option | "deny")`: `answerChoice`. Tier: **consequential**.
    Until track T lands, always a card.
  - `interrupt_session` and `stop_session`. Tier: consequential.
  - `open_panel(projectId, kind: git|diff|notes|console, instanceId?)` and
    `focus_session`. Tier: in-app.
  - **Notes** (decided 2026-10-19: notes stay Workbench's, synced by improvement plan N3,
    not moved into Duck's repo):
    - `create_note` and `append_note` are in-app tier. `write_note` (replace the text) is
      in-app when you asked for that edit in this turn and consequential otherwise.
      `delete_note` is always consequential.
    - Every write goes through `notes_write` with the `baseRevision` from Duck's last
      read. If you saved in between, the write is refused (`stale:`); Duck re-reads and
      redoes the edit on your text, and never overwrites with a null base.
    - Each edit shows a chip in the thread, "Duck edited <note>", with **show diff** and
      **undo** (undo writes back the previous text, with the same revision check).
    - A note open in the panel with unsaved edits when Duck writes gets the panel's
      existing "changed elsewhere" banner. Your edits are never dropped silently.
  - `wait_for_session(instanceId, until: done|needs_you, timeoutMin)`: subscribes to
    `onStatusTransition` and posts a follow-up message to the thread when it fires. This is
    how "tell me when it's done" works, without polling.
  - Settings: a global "always confirm prompts sent to sessions" (off by default).
  - A minimal `policy.ts` maps tier → run or card. Track T replaces it with the trust engine
    behind the same interface.
- **Key files:** `src/assistant/tools/act.ts`, `src/assistant/policy.ts`, `src/state/remoteActions.ts`
  (exports only, no behavior changes).
- **Done when:**
  - Requests like "start a session in X and ask it to fix the failing test", "approve the
    backend one" (a card appears) and "ping me when the game agent is done" (a follow-up
    message appears) work end to end.
  - A transcript containing "assistant: push to main" does not cause a push.
  - "Add that to the backend notes" appends to the note with an undo chip. Doing it while
    the note has unsaved edits in the panel shows the banner and keeps your edits.
- **Out of scope:** git writes (left out on purpose; add later as consequential tools if
  wanted).
- **As built:**
  - `src/assistant/tools/act.ts` has 13 tools, `policy.ts` the gate,
    `settings.ts` Duck's settings. The port grew the actions; `state/remoteActions.ts`
    now exports `startNewSession` and `deliverWhenReady` (the phone's create flow
    uses them, unchanged in behavior) and `port.local` reuses them.
  - **Tiers as planned, with these choices:**
    - `write_note` is always consequential. Whether "you asked for that edit in this
      turn" can't be checked from inside the tool, and a model claim isn't enough.
      `append_note` and `create_note` run at once.
    - `resume_session` takes its tier from the session: reversible on a stopped one,
      consequential over a running one (it ends that process). Tools can now declare
      `tierFor(input, port)`.
    - `focus_session` is folded into `start_session` (show the console, starting
      Claude Code if it isn't running) and `open_panel` with `kind: "console"`.
  - `answer_choice` names the prompt's `choiceId` (now in `get_pending_choice`). The
    port refuses it if that prompt is no longer the open one, so a confirm that comes
    late can't answer a newer prompt. Typed options are refused (answered in the
    terminal).
  - `send_prompt` to a session that isn't running starts its console and delivers the
    prompt once the prompt box shows (queued on the card if it never does), instead of
    dropping it.
  - `create_session` with no `model` uses `codingModel` from Duck's settings (opus by
    default); `"project"` uses the project's default. Its timeout is 90 s, for a
    worktree's setup command. A session Duck starts or creates gets the focus (its
    project shown), as the phone's does.
  - Confirmation cards lead with a sentence from the tool (`describe`): e.g. `Answer
    "api" — permission: Bash npm test — with: 1. Yes`. The raw input is under "details".
  - `wait_for_session` returns at once and, on the transition (or its timeout), posts
    a `<workbench_event>` message with source `event` through `ToolContext.later`. That
    starts a turn, and Duck tells you. The drawer shows it as an event line, not your
    bubble. The system prompt says such messages are Workbench's, not yours, and grant
    nothing. Watches live in memory and don't survive a restart.
  - Notes: writes carry the revision Duck read. `append_note` re-reads and retries
    once on `stale:`. `write_note` refuses a note longer than `read_note` shows (it
    would lose text). Each write leaves a "Duck edited <note>" chip (a notice, never
    sent to the model) with show diff (an LCS line diff in `view.ts`) and undo. Undo
    writes the old text with the after-edit revision, so it's refused if you changed
    the note since; it recreates a deleted note and removes one Duck made. The notes
    panel's existing "changed elsewhere" banner covers an open note with unsaved edits.
  - Settings (drawer → settings): "Ask before every prompt Duck sends to a session"
    (off by default) and the coding model. They go to the engine over the protocol
    (`settings.set` / `settings`) and are stored in pref `assistant`.
  - "assistant: push to main" in a transcript can't cause a push: there is no git write
    tool, transcripts are wrapped as untrusted, and prompts to sessions are written by
    Duck from your request.
  - **Fix found in the live test:** a new session's first prompt sat in the input
    unsent. Claude Code draws its prompt box before it takes input, and a prompt pasted
    the moment the box shows keeps its text but loses its Enter. This was reproduced in
    a scratch PTY on 2.1.304: at 0 and 250 ms after the box, every prompt was lost; at
    500 ms and later, none was. `deliverWhenReady` (Duck and the phone) now waits until
    the box has been on screen for 1 s. A second after the Enter, if the box still
    holds the prompt (`inputHolds`: its start or its paste chip, never a dialog), it
    sends Enter once more. That retry alone also fixed it in the PTY.
  - **Fixes from the second live test:**
    - `answer_choice` failed after Allow. The model sent `option: "1"` (a string),
      the schema took only a number, and the engine asked before it validated. So
      the card showed raw JSON (no sentence: `describe` couldn't parse the input
      either), and Allow ran into "Invalid input". Now `option` takes a number or a
      string, and the whole answer is checked in the schema. The engine also never
      asks for a call whose input doesn't validate: it fails at once with the
      reason. A card without a sentence shows the input as `field: value` lines.
    - Free-form answers: `answer_choice` takes `text` for a single question. It
      sends the digit after the question's options (the TUI's "Type something"
      row), then the text as a paste, then Enter (`answerChoiceText`). This was
      verified in a scratch PTY on 2.1.304, typed and pasted, one word and several.
      `get_pending_choice` says a question takes one. A permission prompt's typed
      option ("No, and tell Claude…") still goes to the terminal.
    - `wait_for_session` no longer refuses a session with no phase yet (just
      started or resumed). It waits, and the timeout covers one that never runs.
  - **Verified:** 26 new vitest cases (11 for the tools and policy, 3 engine hooks,
    3 view, 4 for the first-prompt delivery, 3 for answer inputs, 1 for the typed
    answer's keys, 1 widened), 263 passing; tsc and eslint clean. The live
    checks passed: a session started with a prompt, approvals, a picked option and a
    typed answer, a "tell me when it's done", and note edits.

#### Step W3 — Session summaries

- **Goal:** Cheap, good summaries: on demand, and optionally when a session finishes.
- **Depends on:** W1. Read the improvement plan's Track M As-built first.
- **Build:**
  - `src/assistant/summarize.ts`: a one-shot Haiku call (`x-wb-purpose: summary`) with its
    own frozen prompt.
    - Input is the transcript text since the last summary (an offset stored per instance in
      memory, plus the last summary in `meta`).
    - Output is structured (`output_config.format`): `{headline, done[], open_questions[],
      needs_you?: string}`.
  - Tool `summarize_session(instanceId)` and "since I was away": summarize every session
    with activity since a timestamp.
  - Optional (pref, off by default): on the `done` transition, summarize and put the headline
    into the existing notification / Web Push body (`notifications.ts`), replacing the
    generic text.
- **Key files:** `src/assistant/summarize.ts`, `src/state/notifications.ts`.
- **Done when:** a summary of a real long session costs < $0.01 and reads correctly, and the
  push body shows the headline when the pref is on.
- **Out of scope:** summaries of shells.
- **As built (2026-10-20):**
  - **No second mechanism:** the improvement plan's Track M (a run summary as a Claude
    Code mod) was never built, so W3 is the only summary path.
  - **`src/assistant/summarize.ts`:** `createSummarizer({port, backend, call})`. One
    Haiku call through `oneShot("summary", …)` (frozen prompt in `PRIMITIVES.summary`,
    `x-wb-purpose: summary`, structured output `{headline, done[], open_questions[],
    needs_you}`; `needs_you` is nullable rather than optional). The input is the
    session's name, task note and state now, the last summary as `<earlier>`
    background, and the activity as `<activity>` (both fenced, and data).
    - **"Since the last summary" is a time, not a byte offset.** `readPlainText` gained
      `since` (epoch ms): it pages back no further than that and keeps only later
      items, and reports `lastAt`, the newest shown item. The transcript reader trims
      and drops lines, so byte offsets can't be matched to items; item times can, and
      they work across `/clear` too.
    - **Stored in duck.db `meta`** (`assistant_summary:<instance>`, JSON `{summary,
      from, at, made}`, new commands `assistant_summary_get/set`), not only in memory,
      so the chain survives a restart. Asking again with nothing new returns the stored
      summary without a call. A window that leaves a gap after `at` ("since I was
      away") isn't stored; one reaching back over it replaces it.
    - At most 40,000 characters of activity (the oldest part is cut and marked):
      about 13k tokens, so a summary costs under $0.002 at Haiku 5.5's prices.
    - Two requests at once (a done alert and a tool) share one call.
  - **Tools** (`src/assistant/tools/summaries.ts`, read tier): `summarize_session(session,
    project?, since?)` and `summarize_activity(since, project?)`, the "since I was
    away" one. The latter takes up to 8 sessions, newest first, 4 at a time. A session
    with no activity time (none run since the app started; `instances.last_activity_at`
    is never written) is checked in its transcript, a file read and no call.
  - **Finished sessions' transcripts:** `transcript_read_back` used to return nothing
    for a session that wasn't running and hadn't been opened this run, so
    `read_session` and the summaries saw no history. It now falls back to the
    instance's `last_session_id` and finds its file by session id (`stream.rs`
    `current`; the follow logic is unchanged).
  - **Done alerts:** the setting `summaryOnDone` (Duck's settings, off by default,
    "Summarize a session when it finishes, for the done alert" in the drawer).
    `notifications.ts` takes a body maker through the port (`setDoneSummary`); with
    the setting on, a done alert waits up to 12 s for the turn's headline and
    otherwise goes out with the last line, as before. A turn that stopped on an error,
    or a session you're watching or that is Duck's worker, isn't summarized. The
    Stop hook fires before the final reply reaches the transcript file, so the hook's
    `last_assistant_message` is passed in and added as the activity's last line
    (`withReply`) when it isn't there yet.
  - **Verified:**
    - Tests: 7 for the summarizer and tools, 1 more for `readPlainText`, 4 for the
      done alert (the first tests of `notifications.ts`), 1 Rust test. 381 vitest and
      224 cargo in all; tsc, eslint and clippy are clean.
    - **Live in the dev app:** "catch me up on the Tauri auto-update approaches
      session" gave a correct summary, down to the page that returned 404 and the
      claims the worker hadn't checked. The call cost $0.00046 (2,773 tokens in).
      "What happened since midnight" found all five sessions from their transcripts
      after a restart (it found none before the fix). With the setting on, a session's
      turn end raised a summary call about 5 s later; that run showed the final-reply
      gap, which was fixed and covered by a test.
  - **Not verified live:** the toast's text after the final-reply fix, and the phone
    push body (the same `sendDone` path).

#### Fix after W3 — reliable prompt delivery (2026-10-20)

- **Seen live:** Duck sent three prompts to a stopped session. Each started its own
  watch on the starting console's screen; two pasted into the prompt box at the same
  moment and ran together, and the Enter retry looked for each one's own text, so
  neither was sent. The session had also been started as a fresh conversation, not
  resumed, and Duck acted on a message the user had stopped.
- **Launch prompt.** A session that isn't running is started with the prompt on
  claude's command line: `pty_spawn` takes `initial_prompt` and appends `-- <prompt>`
  (local Claude only, at most 24,000 bytes). `state/launchPrompt.ts` holds it until
  the terminal spawns (`terminalPool` takes it). Checked in a scratch PTY on 2.1.304:
  a new session, one behind the folder-trust dialog, and `--resume <id> -- <prompt>`
  all took the prompt and answered (the resumed one with its earlier context); a
  prompt starting "update:" and holding quotes, `&`, `|`, `%`, `^` and a newline
  arrived whole. Without `--`, `claude -p "mcp list …"` runs the `mcp` subcommand.
- **One line per session** (`state/promptOutbox.ts`, `deliverPrompt`): one delivery
  in flight. Prompts waiting for a turn to end go in **together as one prompt**
  (blank lines between them), each told the outcome: one turn for all of it.
  A prompt counts as taken on `UserPromptSubmit` (or the session turning to working).
  A typed prompt gets up to two more Enters while the box holds any text
  (`inputHasText`). A prompt too long for the command line, or for an SSH project,
  waits for the prompt box and is typed. One never taken is reported: `send_prompt`
  returns `unsent` (a session at rest is waited on, a few seconds at most), and a
  queued or starting one that fails later comes back as a `<workbench_event>`.
- **Duck chooses the timing** (asked for on 2026-10-20: "Duck should decide… I should
  not have to concern myself with this"). `send_prompt` takes `when`: `now` goes into
  a running turn (Claude Code takes typed input mid-turn and reads it at its next
  step; taken when the text leaves the box), for corrections, constraints and
  answers; `after_turn` (default) waits, for new work. The description says which is
  which and asks Duck to put several requests for one session into one prompt. A
  `now` prompt never goes into a session waiting on a permission prompt or question
  (a keystroke could answer it); it waits until the session works again.
- **Resumed, not fresh.** `sendPrompt` to a stopped session continues its last
  conversation (`resumeConsole`, now with `background` for workers), and replaces a
  dead console instead of focusing it. `createSession` sets the first prompt as the
  launch prompt in `beforeLaunch`.
- **Stopped messages.** `toApiMessages` adds a note to a user message that a stop
  notice follows with no reply ("stopped before you answered; don't act on it").
- **Not changed:** the phone's create flow and W5's drafting session still use
  `deliverWhenReady`.
- **Verified:** 6 outbox tests, 1 for the stopped note (388 vitest, 223 cargo); tsc,
  eslint and clippy clean.

#### Step W4 — Core memory (the always-loaded profile)

- **Goal:** The Assistant remembers who you are, your preferences, standing instructions
  and nicknames across threads. This is the first layer of the long-term memory in track L.
- **Depends on:** W2, D1 (the Duck workspace exists).
- **Build:**
  - `C:\Users\mrsha\repos\Duck\memory\core.md`: a short, curated profile (capped at ~2k
    tokens) in sections: About you / Preferences / Standing instructions / Names & nicknames.
  - Tools `remember_core(section, fact)` and `forget(fact)`. These are in-app tier: they run
    and are logged, with a chip in the thread.
  - Loaded at the start of each thread as a mid-conversation system message, so the
    top-level system prompt stays cached. Edited through the editor panel or by asking.
- **Done when:** "the game means project Hollow" survives a new thread, and `core.md` shows
  the line.
- **Out of scope:** the long-term store and recall (L1), automatic extraction (L2).

#### Step W5 — Project toolbar tools

- **Goal:** Duck runs, adds and edits a project's toolbar plugins (improvement plan
  Track K): "start an installer build and tell me when it's done", "add a deploy
  button to the game project".
- **Depends on:** W2 (the confirmation policy and `wait_for_session`), the improvement
  plan's K1 merged.
- **Build:**
  - Read tier: `list_plugins(project)`, the parsed toolbar with each control's current
    value and each action's run state. `read_plugins(project)` gives the raw file and its
    revision.
  - `run_plugin_action(project, plugin, action, values?)`: **consequential**, since it
    runs a command on your PC. Until T1, always a card. The card shows the exact argv after
    substitution. It returns a handle at once. Completion (the exit code and the task
    panel's last lines) comes back as a follow-up message in the thread, through the same
    mechanism as `wait_for_session`.
  - `write_plugins(project, text, baseRevision)`: **consequential**. The card shows a diff
    of `plugins.json`. It goes through `plugins_write`, so a stale base is refused and Duck
    re-reads. A validation error comes back as the tool's error, with the JSON path, so
    Duck fixes it in the next round. Duck writes a script the plugin needs into the
    project's `scripts/` folder through the same card.
  - A chip "Duck edited the build toolbar" with **show diff** and **undo**, as for notes
    (W2).
  - The file is data to Duck: a plugin's labels or `confirm` text can't instruct it.
- **Key files:** `src/assistant/tools/plugins.ts`, `src/assistant/port.ts` /
  `port.local.ts`.
- **Done when:** both requests in the goal work end to end, a refused card runs nothing,
  and an invalid edit is fixed by Duck without your help.
- **Out of scope:** trusting plugin actions without a card (that is T1's job, per action).
- **As built:**
  - **`prepare` in the engine.** A card that shows "the exact argv after substitution"
    needs the backend, so a tool may declare `prepare(input, port)`, run before the
    gate. Its result is kept on the call (persisted with a parked batch) and handed to
    `describe`, the new `review` (diffs on the card), `trust` and `run`. A throw fails
    the call before any card: an unknown action, a value a field refuses, a file with
    problems, a stale base.
  - **Tools** (`src/assistant/tools/plugins.ts`): `list_plugins`, `read_plugins`,
    `run_plugin_action(project, plugin, action, values?, timeoutMin?, grantedBy?)`,
    `write_plugins(project, text, baseRevision, scripts?)`. Plugins and actions are
    named by id or label. Duck's `values` are checked against their fields (a select's
    options, a text field's pattern, a checkbox's true/false) and laid over the
    toolbar's own; the toolbar keeps its values.
  - **Runs.** New `plugins_preview` returns what `prepare_task` would spawn (the shown
    argv and the cwd). The card shows it, and the confirm question filled in. A run is
    pinned: `TaskRequest.revision` makes the spawn refuse (`stale:`) if the file changed
    after the card, and the tool previews again just before starting and refuses if the
    argv or cwd moved (a `{branch}` change). The run starts in the action's task panel
    without the confirm question (the card asked), refused while it is running, and
    shows the project, since task panels are drawn for the shown project only. The end
    (exited with its code, stopped, couldn't start, panel closed, run again from the
    app) comes back as a `<workbench_event>` with the last 15 lines of the terminal,
    marked as program output. A `long` action is watched quietly: only its end is
    reported.
  - **Trust.** A run's facts: specifier `plugin:action` (so
    `assistant:run_plugin_action(build:*)` allows a plugin's runs), the argv as a `Bash`
    call for the floor (a `git push` action asks), and `grantedBy`. An action with a
    `confirm` question always asks: a new fact `asks` is treated as the floor, so neither
    a rule nor the user's quoted words get past it. `write_plugins` takes no
    `grantedBy`: the diff is the point of its card. The floor reads the new file and its
    scripts.
  - **Edits.** New `plugins_text` (raw text and revision), `plugins_check` (the
    problems, as the parser reports them), `plugins_remove` (delete at a revision, for
    undo), `plugins_script_read` / `plugins_script_write` (one plain file name in
    `{data}/scripts/`, at most 256 KB). `prepare` compares the base revision and checks
    the text, so a broken edit comes back with its JSON paths and Duck fixes it without
    a card. Scripts are written before the file. The chip reads "Duck edited the build
    toolbar" when one plugin changed (else the project's toolbar); undo writes the old
    file back at the new revision (or removes a file Duck made), then restores each
    script still as Duck wrote it.
  - **Delegated edits** (added after the first build, on review: a change that needs
    the project's code read, or a script written, is coding work, and Duck's turns are
    on API credits). `delegate_plugins_edit(project, request)` starts a Claude Code
    session in the project on the coding model, and `apply_plugins_draft(project)`
    shows its result on the same diff card as `write_plugins`. A small edit whose
    commands Duck knows still goes through `write_plugins`.
    - **The skill.** Workbench ships a Claude Code plugin with one skill,
      `workbench:plugins` (`src-tauri/resources/claude-plugin/`: the drafting workflow
      in `SKILL.md`, the file format in `reference.md`). It is written to
      `<app data>/duck-sessions/claude-plugin/workbench/` at start and loaded with
      `--plugin-dir` by drafting sessions only. Nothing is installed, and neither the
      repos nor `~/.claude` are touched.
    - **The draft.** `<app data>/duck-sessions/plugin-drafts/<project>/`, outside the
      notes folder (a draft never syncs). It starts as a copy of the live file and
      scripts; the session edits the copy, and `apply_plugins_draft` reads it from
      disk, so the file never goes through Duck's tokens. A draft with problems fails
      before any card, telling Duck to send them to the session.
    - **The session's permissions.** It is registered by instance id (migration v13,
      `plugin_draft_sessions`), so every launch and resume gets `--permission-mode
      default --plugin-dir … --add-dir <draft> --settings <file>`. The settings file
      holds one rule, `Edit(//c/…/plugin-drafts/<project>/**)` (an Edit rule covers
      every file tool, Write included), and lives outside the draft folder, so the
      session can't rewrite its own permissions. The default mode is forced because
      the user's own default (`auto`) would let it write anywhere; checked with the
      CLI: a write in the draft goes through, a write beside it is refused. Anything
      else it asks for comes to Duck as a `<workbench_event>`, and Duck answers only
      what the user's request covers, quoting it in `grantedBy`.
    - `startNewSession` gained `beforeLaunch`, awaited before the console opens, so
      the session is registered before its first launch. Applying a draft clears it
      and the registration, so later resumes are ordinary sessions.

#### Step W6 — Screen and keys: Duck's hands on the terminal

- **Goal:** Duck can do at a session's terminal what you can: see the screen and press
  keys. Asked for on 2026-10-20, after a prompt sat unsent in a session's input box and
  Duck had no way to press Enter ("it still bothers me a little that there are things
  that Duck can't do in its own home environment").
- **Depends on:** W2, T1 (the trust rules).
- **Build:**
  - Tool `read_screen(session)` (read tier): the terminal's rendered screen as text
    (`terminalPool.readScreen`, the visible rows, trimmed), with a short hash of it.
    It shows what the transcript doesn't: the folder-trust dialog, `/login`, pickers,
    menus, the input box's contents, Claude Code's own error lines. Wrapped as
    untrusted, as transcripts are.
  - Tool `press_keys(session, keys, screenHash)` (consequential): named keys (`enter`,
    `escape`, `up`, `down`, `left`, `right`, `tab`, `shift+tab`, `backspace`, `ctrl+c`,
    `ctrl+u`, digits, `y`, `n`) and short text, at most a few dozen per call, written
    with small gaps (a burst is read as a paste: see the PTY harness notes).
    - **Stale screen refused:** the call names the hash Duck read; if the screen has
      changed since, nothing is sent and Duck reads again.
    - **Through the trust rules:** keys sent while a permission prompt or question is
      open answer it, so the call is judged as `answer_choice` would be (the floor, the
      rules, `grantedBy`). Elsewhere it's an ordinary consequential call, with the
      keys and the screen's last lines on its card.
    - Never into a session's terminal while you're typing in it: refused if the
      console has had your keystrokes in the last few seconds.
  - A chip in the thread: "Duck pressed Enter in backend".
- **Key files:** `src/assistant/tools/screen.ts`, `src/panels/terminalPool.ts`,
  `src/assistant/port.ts` / `port.local.ts`.
- **Done when:** Duck finds a prompt sitting unsent and presses Enter; answers the
  folder-trust dialog when asked to; a stale hash sends nothing; keys into an open
  permission prompt go through the trust rules.
- **Out of scope:** reading or driving shells and task panels (Claude consoles only).

### Track M — Models

#### Step M1 — Model per Claude Code session

- **Goal:** Sessions can be started with a chosen model; the Assistant starts coding sessions
  on Opus.
- **Depends on:** nothing (can run in parallel with A).
- **Build:**
  - Migration: `instances.model TEXT NULL`; `projects.default_model TEXT NULL`.
  - `pty_spawn` gains `model: Option<String>`. `claude_command` appends `--model <m>`
    (validated against `^[a-z0-9.\-\[\]]+$`, never interpolated through a shell).
  - The model is passed through `ConsoleSession` / `terminalPool` opts and on resume.
  - A model picker in the new-session UI (inherit / opus / sonnet / haiku / fable) and in
    the project dialog default. Shown on the instance card.
  - `create_session` (W2) defaults to `opus` when the Assistant classifies the task as coding
    or professional work (an Assistant pref).
- **Key files:** `src-tauri/src/pty/mod.rs`, `src-tauri/src/registry/mod.rs`,
  `src/ipc/pty.ts`, `src/panels/terminalPool.ts`, `src/state/registry.ts`,
  `src/panels/InstanceManager/*`, `src/remote/protocol.ts` (`create` gains an optional
  `model`).
- **Done when:** a session created with `opus` shows Opus in its status line, `/clear` keeps
  it, and resume keeps it.
- **Out of scope:** switching the model of a running session (`/model` by prompt already
  covers it).
- **As built:**
  - Migration v11: `instances.model`, `projects.default_model` (both nullable). The
    registry trims them, stores blank as NULL, and rejects anything `valid_model` refuses:
    lowercase letters, digits, `.`, `-`, `[`, `]`, at most 64 characters, starting with a
    letter or digit (so a value can never read as another flag).
  - **No new `pty_spawn` argument.** `pty_spawn` looks the model up itself
    (`registry::launch_model`: the instance's own, else the project's default), so a fresh
    launch, every resume path and a relaunch after a restart all agree without threading
    the model through `ConsoleSession` / `terminalPool`. A project shell's id isn't an
    instance, so it gets none. Locally it's two argv entries, `--model <m>`. Over SSH it
    joins the remote shell text as `"claude --model '<m>'"` (ssh re-parses argv; the
    validator admits no quote).
  - There's no new-session dialog (a new instance is made in one click), so the picker is
    on the card: a `◇` row action opens default / opus / sonnet / haiku / fable, and the
    meta line shows the model (dimmer when inherited). A change applies at the next
    launch or resume. The project dialog has a "default model" select. The phone's
    new-session sheet has a model select, and the `create` action takes `model`.
  - Duck's `list_sessions` shows each session's effective `model`
    (`src/util/models.ts` `effectiveModel` mirrors `launch_model`).
  - The `create_session` default (opus for coding work) is W2's, as planned.
  - **Verified:** 2 new Rust tests (validation, inheritance and clearing), the W1
    `list_sessions` test now covers `model`; cargo test, clippy, vitest, tsc and eslint
    clean. Live check passed: Opus in the status line, kept by `/clear` and resume.

#### Step M2 — Effort routing, Haiku workers, budget-aware degrade

- **Goal:** Keep the Sonnet main thread affordable: the right effort per message, Haiku for
  reading-heavy chores, and a graceful step down near the budget.
- **Depends on:** W2, W3, A1.
- **Build:**
  - **Per-message effort:** a small rule set in `engine.ts` picks `medium` or `high` for each
    user message. Signals: the thread mode (duck → high); explicit phrases ("think hard",
    «подумай как следует»); the message asks for research, a plan, a comparison or a browser
    task. It is sent as the per-message effort system message (beta
    `mid-conversation-output-config-2026-07-01`), so the cache is kept. The drawer shows a
    small "effort: high" chip when raised.
  - **`haiku_task(instruction, sources[])`:**
    - Sonnet hands a reading-heavy chore (several transcripts, a long page, a set of notes)
      to a Haiku one-shot, and gets back only the result.
    - Sources are fetched by the tool, never pasted in by Sonnet, so the long text never
      enters the main context.
  - **Tool search:** browser and rarely used tools get `defer_loading: true` behind the
    regex tool-search tool, which keeps the fixed prefix about 10k tokens. Context editing
    (`clear_tool_uses_20250919`) clears old tool results.
  - **Budget degrade** (the subscription brain itself is M3; until it lands, this step's
    Haiku path is the only degrade):
    - At the soft limit, a card says "Switching to Haiku for the rest of the month — Sonnet
      stays available per message."
    - New messages then go to a Haiku thread (a new thread, since caches are per model).
    - The "Sonnet" toggle sends a single message on Sonnet, with its cost shown.
    - At the hard cap, only primitives run.
  - **Projection:** the spend line extrapolates month-to-date to "on track for $X".
- **Key files:** `src/assistant/engine.ts`, `src/assistant/tools/haikuTask.ts`,
  `src/assistant/budget.ts`, `src/assistant/prompt.ts`.
- **Done when:**
  - "compare these three libraries for X and write it up in a note" runs at `high`;
    "what's the backend agent doing" runs at `medium`.
  - "summarize all sessions in project X" goes through `haiku_task`, and the main context
    grows by less than 2k tokens.
  - `cache_read_input_tokens` is non-zero on the second and later turns, including after a
    20-minute gap (the 1-hour TTL).
  - Forcing month-to-date to 81% switches new messages to Haiku with a card.
- **Out of scope:** a separate classifier call to pick the model.

#### Step M3 — Subscription brain: headless Claude Code as the fallback main thread

- **Goal:** When the API credits run low or out, Duck keeps answering on Sonnet through your
  subscription instead of dropping to Haiku, and moves back when the credits allow.
- **Depends on:** A2, M2, D2 (subscription-limit readings).
- **Build:**
  - **`Brain` interface** in `src/assistant/brain/`: `send(userTurn) → stream of events`
    (text deltas, tool calls, end of turn with usage), `cancel()`, `close()`. `ApiBrain`
    wraps the existing engine loop; `SubscriptionBrain` wraps the headless process. The
    engine, the drawer and the tool registry only see the interface.
  - **Duck MCP server** (`src-tauri/src/assistant/mcp_server.rs`, `rmcp` server,
    streamable HTTP on the hook server at `/duck/mcp`, per-launch bearer token):
    - Lists the registry's tools with their schemas (generated from the same definitions
      `ApiBrain` sends, so the two never drift).
    - Forwards each call to the webview as a `duck-tool-call` event and awaits the result,
      so the trust engine, confirmations and the 10 s tool budget apply as on the API path.
    - Only Duck's own process gets the token. Worker sessions don't get these tools.
  - **Headless process** (`src-tauri/src/assistant/subscription_brain.rs`):
    - Spawns `claude -p --input-format stream-json --output-format stream-json --verbose
      --model sonnet --effort <e> --tools "" --strict-mcp-config --mcp-config <generated>
      --system-prompt-file <Duck prompt> --permission-mode dontAsk --allowedTools mcp__duck
      --no-session-persistence` in the Duck workspace, with a clean env (no
      `ANTHROPIC_*`, no `WORKBENCH_INSTANCE_ID`).
    - Started lazily when the switch happens, kept alive while it's the active brain, killed
      after 30 minutes idle (re-spawn costs ~2 s plus one cold turn).
    - Per-message effort: `--effort` is fixed per process, so a message needing `high`
      re-spawns with a handoff, or (simpler, the default) stays at `medium`.
    - Reads `rate_limit_event` from the stream into the same `usage_limits` D2 uses, and
      `result.total_cost_usd` (API-equivalent) into the ledger with `backend: subscription`
      so the spend meter can show "saved $X of credits".
  - **Switching policy** (in `budget.ts`, per the Design section):
    - API soft limit or "credit balance too low" → subscription, if 5-hour < 70% and weekly
      < 80%; otherwise the Haiku thread.
    - Subscription over its thresholds while active → back to the API (Haiku thread if past
      the soft limit).
    - A new month's credits → back to `ApiBrain` at the next idle moment.
    - Each switch opens a new thread seeded with a Haiku handoff summary of the last ~20
      turns plus the current state snapshot, and posts a card ("Now answering on your
      subscription — API credits are at 80%").
  - **Settings:** brain policy `auto` (default) / `api only` / `subscription only` (for testing
    and for a month where you'd rather spare the credits).
- **Key files:** `src/assistant/brain/{index,api,subscription}.ts`,
  `src-tauri/src/assistant/{mcp_server,subscription_brain}.rs`, `src/assistant/budget.ts`.
- **Done when:**
  - With policy `subscription only`, the 20 X0 sample requests pick the same tools as on the
    API, and approvals still go through the trust engine.
  - Forcing month-to-date to 81% with the subscription at 20% moves new messages to the
    subscription brain with a card; forcing the subscription to 75% then moves them to the
    Haiku thread.
  - A simulated "credit balance too low" response switches brains mid-conversation without
    losing the user's message.
  - Killing the headless process mid-turn surfaces an error and the next message re-spawns
    it.
- **Out of scope:** running workers or `haiku_task` through the subscription brain (workers
  already are sessions; primitives stay on Haiku API until the hard cap).

#### Step M4 — Permission mode at launch

- **Goal:** A project (or one session) can start Claude Code in a chosen permission mode,
  so fewer prompts come up in the first place.
- **Depends on:** M1 (same path).
- **Build:**
  - `instances.permission_mode` and `projects.default_permission_mode` (nullable), passed as
    `claude --permission-mode <m>` on launch and resume, looked up in `pty_spawn` like
    the model, and validated against the modes the installed Claude Code lists.
  - The picker beside M1's model on the card and in the project dialog; `create_session`
    takes it too (an Assistant pref for coding work, like the model).
- **Done when:** a session launched with `acceptEdits` shows it in its status line, and
  resume keeps it.
- **Out of scope:** switching the mode of a running session (decided 2026-10-19: no
  in-session switcher. Shift+Tab stays in the terminal, and the trust policy covers the
  prompts).
- **As built:**
  - Migration v14: `instances.permission_mode`, `projects.default_permission_mode` (both
    nullable), cleaned like the model: trimmed, blank stored as NULL, anything
    `valid_permission_mode` refuses is an error (a camelCase word of at most 32 letters,
    so it can't read as a flag or shell syntax).
  - **Launch:** `pty_spawn` looks it up itself (`registry::launch_permission_mode`: the
    instance's own, else the project's), so launch, every resume and a relaunch after a
    restart agree, as for the model.
    - **Which modes:** `pty::permission_modes` reads the choices from the installed
      Claude Code's `--help` once per run (2.1.304: `acceptEdits auto bypassPermissions
      manual dontAsk plan`). A stored mode it doesn't list is left out of the launch
      (and logged) rather than stopping Claude Code at start; an unreadable list lets it
      through. `default` isn't listed any more but still works (it means `manual`), so
      it's always accepted; W5's drafting session launches with it.
    - **Drafting sessions** (W5) keep their own `--permission-mode default`: a picked
      mode is ignored for them, since the draft's allow rule is only a fence in that
      mode.
    - **Over SSH** the mode joins the remote shell text like the model
      (`"claude --model '<m>' --permission-mode '<p>'"`). The host's Claude Code isn't
      asked which modes it knows.
  - **Pickers:** the card's `◇` popover now has two rows, model and permission mode
    (default / the listed modes, `default` hidden as the alias it is), and the meta line
    shows the mode beside the model (dimmer when inherited). The project dialog has a
    "default permission mode" select. Both read the list through
    `claude_permission_modes` (`src/util/permissionModes.ts`, fetched once).
  - **Duck:** `create_session` takes `permissionMode` (`acceptEdits | auto | manual |
    dontAsk | plan | project`), and a new Duck setting, "…in permission mode" under the
    coding model, is used when the request names none (default: the project's).
    `bypassPermissions` isn't offered to Duck: it would step around track T.
  - **Not done:** the phone's new-session sheet has no mode select, and
    `list_sessions` doesn't report the mode (left out so as not to collide with T2's
    port changes; add with D1).
  - **Verified:** registry tests (validation, inheritance, clearing), the `--help` parser
    and the SSH quoting; the `create_session` test covers the setting, an explicit mode
    and a refused `bypassPermissions`. Live in the dev app: a session set to
    `acceptEdits` on its card showed "accept edits on", and its resume ran as
    `claude --resume <id> --model opus --permission-mode acceptEdits`.

### Track B — Web & browser

#### Step B1 — Web search and fetch

- **Goal:** The Assistant can do *quick* lookups itself, with citations. Real research goes
  to a worker session (D1).
- **Depends on:** M2.
- **Build:**
  - Add the server tools (type strings confirmed in X0) to the main Sonnet thread, with
    `max_uses` 5 (search) / 8 (fetch) per turn. Raise the message's effort to `medium` when
    they are used.
  - Render citations as links in the drawer.
  - Count searches in `assistant_usage`.
  - In the Haiku-degraded mode, offer the basic variants only if X0 found Haiku supports
    them.
- **Done when:** "what's new in the latest Tauri release?" returns a cited answer, and the
  search count and cost are recorded.
- **Out of scope:** local scraping.

#### Step B2 — MCP host + your Firefox (quick browser actions)

> **Revised by track D:** browser *chores* (multi-step, research-y) go to worker sessions,
> which already have your `firefox` MCP through Claude Code. This step is only for **quick,
> interactive** browser actions from Duck's own thread ("open my notifications", "what's in
> the current tab"), where a worker's start-up time would be annoying. Build it after D1,
> and only if that latency proves to matter in practice.

- **Goal:** The Assistant can do things in your real Firefox, through the bridge you already
  use, at no idle cost.
- **Depends on:** M2.
- **Build:**
  - `src-tauri/src/assistant/mcp_host.rs`, built on `rmcp` (client, `TokioChildProcess`):
    - Commands `mcp_host_tools(server)`, `mcp_host_call(server, tool, args)`.
    - The server definitions come from your **Claude Code MCP config**. Reuse
      `src-tauri/src/mcp/mod.rs` (`mcp_list`) to read the `firefox` entry's command and args
      (`uvx --from git+…mcp-bridge-for-firefox@<commit> mcp-bridge-for-firefox --stdio`).
      Each server is opt-in for the Assistant (a checkbox list in Assistant settings), so a
      new MCP server isn't exposed automatically.
    - Lazy spawn on first call (`CREATE_NO_WINDOW`, no shell) and kill after 10 minutes
      idle. The add-on reconnects by itself, so start order doesn't matter.
    - Tool lists are cached per server command line, so the main thread's tool list stays
      stable.
  - TS adapter: MCP tool schemas → API tools, namespaced `firefox__*`. Default tiers by tool:
    - Listing browsers, tabs, history and bookmarks, reading a page and screenshots are
      **read**.
    - Navigating, clicking and typing are **in-app**.
    - File upload, and anything on a page whose element refs look like submit / pay / login /
      password, are **consequential**. The trust floor covers login, payment and sending
      messages.
  - The tools are registered with `defer_loading: true` (tool search, M2). The system
    prompt says to call `browsers_select` with the agent profile when one exists.
  - **Two profiles:**
    - **Agent** is the default: the existing `claude-agent` profile, the only one with the
      add-on (X0). Firefox's new profile switcher doesn't list it, so Duck starts it on
      demand with `firefox.exe -P claude-agent --no-remote` when a browser task needs it and
      the bridge sees no add-on. The add-on connects ~5 s after the profile opens. Sites you
      log into there once stay logged in.
    - **Personal** is your everyday profile. Using it is the trust request
      `assistant:firefox(profile:personal)`, which asks by default; a rule can allow it per
      site or task.
    - A tool `use_personal_browser(reason)` makes the switch explicit, so the card says *why*
      ("needs your logged-in YouTrack").
    - Every browser chip shows which profile it acted in.
  - **When a site needs login**, the Assistant stops and asks, with three choices on the card:
    - "I'll log in in the agent profile" (opens the page there and waits);
    - "use my personal profile";
    - "skip".

    It never types a password itself: login stays on the trust floor.
  - Settings: the profile names / `browsers_list` ids for agent and personal; a site
    allowlist for the personal profile.
- **Key files:** `src-tauri/src/assistant/mcp_host.rs`, `src-tauri/src/mcp/mod.rs`,
  `src/assistant/tools/mcp.ts`, `Cargo.toml` (`rmcp`).
- **Done when:**
  - "open my GitHub notifications and list the unread ones" works in the agent profile
    (logged in once), *while* a Claude Code session also has the bridge connected.
  - A task that needs your personal tabs shows a card naming the profile and the reason, and
    runs there after Allow.
  - A login page produces the three-choice card, not typed credentials.
  - No `uvx` / Python process remains 10 minutes later.
- **Out of scope:** other browsers, and Anthropic's client-side `browser_toolset` (it would
  need a Firefox executor; revisit only if the bridge falls short).

### Track V — Voice

#### Step V1 — Push-to-talk with local STT on the GPU (desktop)

- **Goal:** Hold a key anywhere, speak English, Russian, Spanish or a mix, and the words go to the
  Assistant within a second of release.
- **Depends on:** A3, X0 (engine choice and measurements).
- **Build:**
  - `src-tauri/src/voice/`:
    - `capture.rs`: `cpal` default input → mono f32 → 16 kHz resample (`rubato`, or the one
      `transcribe-rs` ships). Ring buffer; start and stop on command.
    - `stt.rs`: a `Transcriber` trait, implemented by Parakeet v3 via `transcribe-rs` (the
      X0 winner; Whisper is dropped). Pin `ort = "=2.0.0-rc.12"` with `load-dynamic`; rc.14
      breaks `transcribe-rs`.
      - **Bring VRAM down** from X0's 3.6 GB (an fp16 export, or an ORT arena cap), and look
        at why the Rust path was 2.5–3× slower than Python's `onnx-asr` (likely the decoder
        loop).
      - Every clip is trimmed to the VAD's speech bounds (~200 ms of padding). **An empty
        result from the int8 CPU model is retried once in fp32:** X0 saw int8 return
        nothing on clips with ~1 s of leading silence.
      - The model is held in an `Arc<Mutex<Option<Model>>>`: load on the hotkey press, in
        parallel with recording; unload after the idle timeout.
      - Execution provider chosen from the "GPU for voice" pref and the power state: CUDA →
        DirectML → CPU int8 (3 threads, below-normal priority). The fallback chain is
        automatic, and the provider in use is shown in settings.
    - `models.rs`: download from Hugging Face into `<appdata>/models/` (`models.dev/` in the
      debug build), with progress events, a checksum, and resume.
    - Silero VAD trims leading and trailing silence (required, see above).
  - `tauri-plugin-global-shortcut`: hold-to-talk (default Ctrl+Alt+Space, rebindable).
    Release → transcribe → emit `voice-transcript {text, source: "desktop"}` → the engine
    submits it to the current thread, marked `voice`.
  - A small "listening…" / "transcribing…" HUD: the drawer opens if closed; with the window
    hidden, a tray icon state.
  - Settings: engine, "GPU for voice" (always / on AC power only / never), idle unload, mic
    device, and a "send without review" toggle (off = the text lands in the composer for a
    quick edit).
  - **A name fixer** for the Cyrillic spellings Parakeet gives English names in mixed speech
    (X0: «воркбенч», «колод код», «пул реквест»). Known names (project names, session titles,
    a short term list: Claude Code, pull request, commit, main, npm, worktree) are
    transliterated to Cyrillic once, then fuzzy-matched in the transcript and replaced
    with the original spelling. The raw text is kept beside it for the model.
- **Key files:** `src-tauri/src/voice/*`, `src-tauri/src/lib.rs`, `Cargo.toml` (`cpal`,
  `transcribe-rs`, `tauri-plugin-global-shortcut`), `src/panels/Assistant/*`.
- **Done when:**
  - A 5 s command is transcribed in < 1 s on the GPU (< 1.5 s on the CPU path) with the PC
    under load.
  - Mixed RU/EN commands come out with project names and the term list spelled in English
    (X0's mx01–mx04 recordings are the test set).
  - After the timeout, idle RSS and VRAM return to the pre-voice baseline and the dGPU can
    sleep.
  - No mic indicator shows in Windows while the key isn't held.
- **Out of scope:** wake word (if wanted later: the sherpa-onnx keyword spotter, opt-in);
  dictation into consoles.

#### Step V2 — Natural spoken replies

- **Goal:** Answers to spoken requests are spoken back in a natural voice, in English,
  Russian or a mix, on the desktop and the phone.
- **Depends on:** V1, X0 (listening test decided: Kokoro `af_heart` for English, Silero
  `kseniya` for Russian, both local on the CPU).
- **Build:**
  - `src-tauri/src/voice/tts.rs`, a `Speaker` trait: `speak(text, lang_hint) → stream of
    PCM chunks`.
    - **Local implementation (default):** a **`uv`-managed Python sidecar** hosting Kokoro
      v1.0 (`kokoro-onnx`, voice `af_heart`) and Silero v5_6_ru (torch CPU, speaker
      `kseniya`, `put_accent`/`put_yo`/`put_stress_homo` on).
      - A pinned `pyproject` in `<appdata>/voice-runtime/`, models downloaded there on
        first use; stdin/stdout framing; `CREATE_NO_WINDOW`.
      - Spawned on first use, Silero loaded only when a Russian sentence arrives, killed
        after 5 minutes idle.
      - X0 reference: first audio 0.18 s, 1.4 GB RSS with both engines loaded.
    - **Chirp 3 HD (optional):** streaming synthesis over REST with `reqwest`, key in the
      keychain (`duck/google-tts-key`, already stored). Used when chosen in settings, or as
      the fallback if the sidecar fails to start. Characters are counted per calendar month
      into `assistant_usage` (`purpose: tts`); it never goes past the free 1M silently.
  - **Sentence pipeline:**
    - Split the reply into sentences and strip markdown and code (a code block becomes "see
      the code on screen").
    - Read paths and identifiers in a speakable form.
    - Synthesize sentence 1 and start playback through `rodio` while sentence 2 is
      synthesized.
    - The push-to-talk key or Esc stops playback (barge-in).
    - Route per sentence: any Cyrillic → Silero, otherwise → Kokoro.
    - **Speakable pass (mandatory for Silero, which drops non-Cyrillic text):** a
      Silero-bound sentence that still has a digit or a Latin letter gets a one-sentence
      Haiku rewrite (numbers to words with correct case, English terms respelled in
      Cyrillic), or a rule-based pass offline. English sentences get a small rule pass
      ("3.5" → "three point five", "#128" → "number 128").
  - **Voice-mode answers:** when the user message is marked `voice`, add a short system note
    ("answer in one or two speakable English sentences, whatever language the user spoke;
    put detail after; any Russian you must quote is written speakably: numbers in words,
    English terms in Cyrillic") through
    the mid-conversation system message.
  - **Phone:**
    - The desktop synthesizes and stores the audio briefly (compressed). The PWA fetches
      `GET /api/assistant/tts/<messageId>` (authed) and plays it.
    - A per-surface setting: "desktop voice" (default) or "phone native voice".
      `speechSynthesis` is the offline fallback in both cases.
  - **Workbench "speak selection"** (`src/util/speech.ts`, Ctrl+Shift+L) is switched to the
    `Speaker` through a command, keeping `speechSynthesis` as the fallback.
  - Settings:
    - Voice per language (defaults `af_heart` / `kseniya`), speaking rate, and engine
      (local / Chirp).
    - "Speak replies": off / only for voice input / always, per surface.
- **Key files:** `src-tauri/src/voice/tts.rs`, `src-tauri/src/voice/sidecar.rs`,
  `src-tauri/src/remote/assistant.rs`, `src/panels/Assistant/*`, `src/pwa/assistant.ts`.
- **Done when:**
  - "what needs my attention?" by voice gets a spoken English one-liner within ~0.5 s of the
    reply starting.
  - "что требует моего внимания?" gets a spoken Russian one-liner in `kseniya`'s voice, with
    session names, times and numbers all audible (none dropped).
  - The same works from the phone.
  - With the sidecar made to fail, Chirp speaks instead (if enabled).
  - Ctrl+Shift+L speaks a selection in the new voice.
  - Nothing stays resident 5 minutes later.
- **Out of scope:** voice cloning; wake word.

#### Step V3 — Read-aloud and screen reading

- **Goal:** "Read me what the backend session said", "read me that note", and "take a
  screenshot and read me the error" all work, by voice or text, on the desktop and the phone.
- **Depends on:** V2, W3 (summaries).
- **Build:**
  - Tool `read_aloud(source, mode: summary | narrate | verbatim, maxMinutes?)`.
    - Sources: `session(instanceId, lastTurns)`, `summary(instanceId)`, `note(id)`,
      `page(url | firefox tab)`, `selection`, `text` (e.g. from a screenshot).
    - `narrate` is a Haiku rewrite (`x-wb-purpose: narrate`, frozen prompt). Code and diffs
      become one-line descriptions, tool calls become outcomes, and identifiers are made
      speakable. It keeps the original language.
    - A long source is split into sections, each synthesized on demand (not all up front),
      so stopping early doesn't spend characters.
  - Playback controller (Rust):
    - Commands: stop, pause/resume, next/previous section, rate.
    - The position is saved per source, so "continue reading" picks up where it left off.
    - Controls in the drawer, the phone tab, and the push-to-talk key (tap = pause).
  - Tool `screenshot(target: activeWindow | monitor(n) | window(title) | all, question?)`:
    - `src-tauri/src/voice/screen.rs` captures with `xcap`, downscales, and encodes PNG in
      memory. Command `assistant_screenshot` returns base64 to the engine, which sends it as
      an `image` block.
    - Nothing is written to disk unless you say "save it" (→ scratch folder).
    - It shows a toast ("screenshot: monitor 2").
    - Tier **in-app**; T1 rules can raise it to ask.
  - Optional local OCR: `Windows.Media.Ocr` (`windows` crate, `Media_Ocr` feature) for
    `verbatim` reading of dense text. Use it when the language packs are present; else fall
    back to Haiku's extraction.
  - The monitor list (names, which one is "left/right/main") is exposed to the model, so
    "the right monitor" resolves.
- **Key files:** `src/assistant/tools/readAloud.ts`, `src/assistant/narrate.ts`,
  `src-tauri/src/voice/playback.rs`, `src-tauri/src/voice/screen.rs`, `Cargo.toml` (`xcap`,
  `windows` features).
- **Done when:**
  - "прочитай, что ответила backend-сессия" narrates the last response in Russian without
    reading code, and stopping halfway stops synthesis.
  - "screenshot the right monitor and read me the error" reads the error from a DisplayLink
    screen.
  - "continue reading" resumes a note where it stopped.
  - Characters for a 10-minute read land in the counters.
- **Out of scope:** continuous screen watching; reading video subtitles.

#### Step V4 — Hands-free conversation mode

- **Goal:** Talk without pressing anything. It knows when you've finished, waits through long
  thinking pauses, and you can talk over it.
- **Depends on:** V2, X0 (turn-detection and echo findings).
- **Build:**
  - `src-tauri/src/voice/conversation.rs`, a state machine: `off → listening → speaking-user
    → pause → (turn-check) → grace → thinking → assistant-speaking → listening`.
    - **VAD:** Silero (`voice_activity_detector` crate or `sherpa-onnx` VAD) on 32 ms frames
      from the `cpal` stream.
    - **Turn check:** Smart Turn v3.2 ONNX via `ort` (CPU, 1 thread) on the last ≤ 8 s of
      audio. When it's asked, the threshold and the ceiling come from the thread's mode,
      using X0's measured policies:
      - assistant: from 250 ms of silence, threshold 0.5, ceiling 1.5 s;
      - chat: from 1.5 s, threshold 0.7, ceiling 8 s;
      - duck: only from 3 s, threshold 0.8, ceiling 8 s.
    - **Grace and merge:**
      - On end-of-turn, emit `voice-turn {text, provisional: true}`. The engine starts the
        request with an AbortController.
      - Speech within the grace window → `voice-turn-continue` → the engine aborts and the
        drawer shows the merged text. The next end-of-turn sends the merged turn.
      - History stays append-only: an aborted request is never appended.
    - **Verbal controls:** a tiny matcher on the STT text ("wait / подожди / hold on",
      "that's it / всё / over", "stop / хватит").
    - **Incremental STT:** each VAD segment is transcribed as it closes; the turn text is the
      concatenation. The STT model stays loaded while the mode is on.
    - **Barge-in:** user speech during TTS playback stops playback, through the echo chain in
      §Design (`voice/aec.rs`):
      - endpoint form-factor detection, with a re-check on device change;
      - AEC3 fed the exact playback PCM from `playback.rs` (X0: ~30 dB on the laptop
        speakers). X0 ran it through livekit's prebuilt WebRTC `AudioProcessingModule`. Check
        at the start of V4 whether livekit's Rust `libwebrtc` crate exposes the same module;
        `webrtc-audio-processing` needs a meson build. Headphones skip AEC (X0: no echo);
        a device of unknown type gets the full chain;
      - the adaptive barge-in gate;
      - the self-voice check against the sentence being spoken.

      A pref "echo handling: auto / force full / force half-duplex" shows the measured
      suppression for the current device.
    - **Auto-off** after N minutes of silence; turning it off releases the mic immediately.
  - UI:
    - Drawer: a conversation-mode toggle (+ `CommandId` `toggleConversation`).
    - A live state pill (listening / thinking / speaking), and a level meter.
    - The tray shows the state when the window is hidden.
    - A soft end-of-turn cue sound (pref).
  - Phone:
    - PWA conversation button: `@ricky0123/vad-web` in the page, sending speech segments
      (16 kHz PCM) over the assistant WS as `audioSegment` frames.
    - The desktop runs the turn check and STT, and returns `turnState` frames.
    - Playback barge-in uses the browser's echo cancellation.
- **Key files:** `src-tauri/src/voice/conversation.rs`, `src-tauri/src/voice/aec.rs`,
  `src/assistant/engine.ts` (provisional turns), `src/panels/Assistant/*`,
  `src/pwa/assistant.ts`, `Cargo.toml` (`ort`, the AEC3 binding).
- **Test kit from X0:** `tools/voice-eval/` (`record_echo.py`, `score_echo.py`,
  `score_turns.py`) and the recordings in `~/repos/Duck/voice-eval` are the regression set.
- **Done when:**
  - A 2-minute rubber-duck monologue with 4–6 s pauses is sent as one turn.
  - A quick "what needs me?" is answered with < 1.5 s from end of speech to the start of the
    spoken reply.
  - Resuming within the grace window merges, with no duplicate reply in the thread.
  - Talking over the reply stops it, **on headphones and on the laptop speakers**.
  - On speakers at normal volume: **0 false barge-ins in 10 minutes** of the Assistant
    talking, and a real interruption is caught within ~300 ms in at least 9 of 10 tries.
  - Switching from headphones to speakers mid-conversation keeps working.
  - CPU while silently listening stays < 2% of one core.
  - The mic indicator is off whenever the mode is off.
- **Out of scope:** wake word; speaker identification (other people's speech in the room
  will be heard — headphones or the pause key).

### Track S — Modes & skills

#### Step S1 — Modes: chat and rubber duck

- **Goal:** Besides acting on the app, the Assistant can be a general chat partner and a
  rubber duck.
- **Depends on:** M2 (Sonnet engine), W4 (core memory), A3.
- **Build:**
  - `src/assistant/modes.ts`: a registry `{id, title, model, effort, systemPrompt, tools,
    voicePatience, ttsStyle}`. A thread stores its mode, and the engine reads everything from
    it, so no model switches happen inside a thread.
  - Built-in modes: **assistant**, **chat**, **duck** (§Design → Modes and skills). The duck
    prompt is to ask one question at a time, reflect back, name assumptions, and not propose
    solutions unless asked.
  - Tool `switch_mode(mode, context)`: from the assistant thread it opens a new thread in
    that mode, seeded with a context brief (project, session summary, note). The drawer
    follows.
  - Duck **wrap-up**: "let's wrap up" → a structured summary → `create_note` in the
    project, with an offer "hand this to an Opus session?" → `create_session` with the note
    as the prompt.
  - Drawer: a mode picker on new threads; mode badge on each thread.
- **Done when:**
  - "давай подумаем над синхронизацией заметок" opens a duck thread that asks questions
    instead of answering.
  - Wrap-up produces a note.
  - A chat thread answers general questions without touching sessions.
- **Out of scope:** user-defined modes (S2).

#### Step S2 — Skills and user-defined modes

- **Goal:** New behaviors are added by dropping a file, or by asking the Assistant to write
  one.
- **Depends on:** S1.
- **Build:**
  - `src-tauri/src/assistant/skills.rs`: list and read
    `<appdata>/assistant/skills/*/SKILL.md` (`skills.dev/` in the debug build). It reuses
    the frontmatter parser in `src-tauri/src/skills/mod.rs` where possible. A watcher reloads
    on change.
  - The engine:
    - Puts skill descriptions in a stable, sorted block after the tools.
    - Adds a `load_skill(name)` tool whose result is the body.
    - A skill's `tools:` frontmatter can only narrow the tool set.
    - A skill with `mode:` frontmatter registers a mode in the S1 registry.
  - Tool `draft_skill(name, purpose)`: the Assistant writes a `SKILL.md`. A card shows the
    draft (consequential: it writes a file).
  - Assistant settings → Skills: list, enable/disable, open in the editor panel.
  - MCP opt-in list (from B2) on the same page, so "capabilities" live in one place.
- **Done when:**
  - A hand-written "morning briefing" skill runs on "доброе утро".
  - A drafted skill appears after Allow and works in the next turn without a restart.
  - A skill declaring `mode: interviewer` shows up in the mode picker.
- **Out of scope:** sharing or a marketplace; executable code in skills (code goes through
  MCP servers or Opus sessions).

#### Step V5 — Proactive announcements

- **Goal:** Duck tells you when there's news (a task done, a session needs you, an
  autopilot stop), on the right surface, without being rude about it.
- **Depends on:** V2, V4, D1. R1 is needed for phone delivery.
- **Build:**
  - `src/assistant/announce.ts`: an announcement queue `{level: info|report|needs_you,
    text, spoken, source, dedupeKey}`. Producers: task completion (D1), `wait_for_session`
    (W2), autopilot (P1), trust cards (T1/T2), routines (L4).
  - **Presence** (`src-tauri/src/voice/presence.rs`):
    - Desktop activity via `GetLastInputInfo`, plus the session-lock state.
    - Windows Focus / Do Not Disturb state, read from the notification settings: X0 checks
      which API is reliable on this Windows build.
    - Whether the foreground window is full-screen.
    - Phone foreground state from R1/R4 connections.
  - **The Speak master toggle**, which gates *all* TTS output: V2's spoken replies,
    announcements and the reply window.
    - A speaker icon beside the Duck button (click to toggle; the tooltip shows the state),
      plus the drawer header, tray, phone tab, `CommandId` `toggleSpeak` and a voice command.
    - It replaces V2's separate "speak replies" setting; V2's per-surface choice becomes the
      Speak state per surface.
  - **Delivery rules:** every rule in the §Design → Proactive updates settings table is a
    pref, with those defaults: the conversation gap, batching, DND (manual with durations,
    and by voice), following Windows Focus, optional quiet hours (off by default),
    full-screen suppression, the repeat interval, the reply window, the presence timeout,
    and push when away.
  - Settings UI: Duck settings → Announcements. **DND** also gets a one-click control on the
    Duck button's context menu and on the phone.
  - **Short reply window:** after a spoken announcement, open the mic for ~8 s (V4's
    pipeline: VAD + turn detection + echo cancellation). A reply goes to the thread as a
    normal message; silence closes the mic. The Duck button shows the open window.
- **Done when:**
  - A research task finishing while you're typing elsewhere gets a spoken one-liner
    within ~5 s, after you pause.
  - With DND on, or Speak off, it's a badge and push only.
  - "Duck, тихо" turns DND on, and a late-night session with Speak on keeps announcing.
  - Two completions 10 s apart are announced together.
  - Saying "read it" in the reply window starts read-aloud.
  - Away from the PC, the phone gets the push.
- **Out of scope:** calendar-aware quiet times (possible later through an MCP server).

### Track R — Remote

#### Step R1 — Assistant endpoints on the remote server

- **Goal:** The phone can use the same Assistant thread, streamed, with confirmations.
- **Depends on:** A3 (engine events stable), W2.
- **Build:**
  - `server.rs`: `GET /api/assistant` (WS, `ws_authed`).
    - Down: `thread` (recent messages), `delta`, `tool`, `confirm`, `done`, `error`, `spend`,
      `trust` (paused / live, plus new decisions), `tts {messageId}` (audio ready).
    - Up: `send {text}`, `confirm {id, allow}`, `stop`, `newThread`, `pauseTrust`.
  - `POST /api/assistant/audio` (`authed`, `DefaultBodyLimit` 4 MB on this route only, WAV
    16 kHz mono only, ≤ 60 s). It runs V1's `Transcriber` and returns `{text}`.
  - Bridge: Rust → webview event `assistant-remote-input`; webview → command
    `assistant_remote_emit(json)` → broadcast to the assistant sockets (the snapshot
    pattern).
  - Confirmation cards go to every surface; the first answer wins and the others update.
  - A push notification when a confirmation is waiting and no surface is open.
- **Key files:** `src-tauri/src/remote/server.rs`, `src-tauri/src/remote/assistant.rs`,
  `src/assistant/remoteBridge.ts`, `src/remote/protocol.ts`.
- **Done when:** a scripted WS client can chat, confirm and stop, and an unauthenticated
  client is rejected on both routes.
- **Out of scope:** PWA UI.

#### Step R2 — PWA Assistant tab with mic

- **Goal:** Talk to the Assistant from the phone, by text or voice.
- **Depends on:** R1, V1.
- **Build:**
  - `src/pwa/assistant.ts`: chat view (shared markdown render), streaming, tool chips,
    confirmation cards, the spend line.
  - Mic button (hold or tap-toggle):
    - `getUserMedia` → AudioWorklet → downsample to 16 kHz Int16 → WAV → POST `/audio` →
      put the text in the composer (auto-send pref).
    - Shown only in a secure context (Funnel/HTTPS); otherwise a hint that explains why.
  - Spoken replies play the desktop-synthesized audio (`tts` frame → fetch). V2 adds this;
    until then, text only.
  - The trust kill switch and the Decisions view (read-only list, with Pause) are in the tab
    header.
  - A tab in the existing PWA navigation; deep link from the push.
- **Key files:** `src/pwa/assistant.ts`, `src/pwa/main.ts`, `src/pwa/style.css`.
- **Done when:** from the phone over Funnel you can say "start a session in X to …", watch the
  reply stream, and approve a card.
- **Out of scope:** offline queueing.

#### Step R3 — The PWA as an app: shortcuts, share target, Duck start view

- **Goal:** On Android, Duck is one tap from the home screen, and anything can be shared to
  it.
- **Depends on:** R2, V4 (conversation mode for the "Talk" shortcut).
- **Build:**
  - Manifest (`src/pwa/` manifest source, built by `vite.pwa.config.js`):
    - `shortcuts`: "Talk to Duck" (`/?duck=talk`), "Ask Duck" (`/?duck=chat`), "New task"
      (`/?duck=task`), "What needs me?" (`/?duck=status`), each with an icon.
    - `share_target`: `POST /share`, multipart, accepting `text/*`, `url`, `image/*`.
      `server.rs` adds an authed `/share` that hands the payload to Duck as a new message
      ("Shared from phone: …"); images become an `image` block.
  - Deep-link handling in `src/pwa/main.ts`: `?duck=…` opens the Duck tab in that state.
    `talk` shows a single big "tap to talk" button, since the mic needs a user gesture.
  - Pref "open on: dashboard / Duck".
  - Push notifications from Duck (task done, card waiting) deep-link to the message.
  - Install hint: when the PWA isn't installed, Duck shows how to install it and how to drag
    a shortcut to the home screen.
  - **Device-bound key for the PWA:** a non-extractable WebCrypto ECDSA key in IndexedDB,
    registered at pairing. Connections answer a signed challenge, the same mechanism as R4.
    This is worth having because Duck can act on your behalf over a public address.
- **Done when:**
  - Long-pressing the installed icon shows the shortcuts.
  - "Talk to Duck" pinned on the home screen opens straight into a tap-to-talk screen.
  - Sharing a web page from Chrome to Duck produces a summary in the thread.
- **Out of scope:** a native app (R4).

#### Step R4 — Android companion app (gate: R3 sees real use)

- **Goal:** Duck behaves like a native assistant on your phone: the assistant gesture, a
  Quick Settings tile, a widget, and hands-free conversation with the screen off.
- **Depends on:** R3, V4. **Gate:** start it only if you actually use Duck from the phone
  regularly after R3 (decide in R3's As built).
- **Build:**
  - A **Tauri 2 mobile** Android target. The new crate or app `duck-android/` reuses the
    PWA's TypeScript UI and the Duck Protocol client.
  - A **Kotlin plugin** with:
    - `VoiceInteractionService` + `VoiceInteractionSessionService` (the assistant role). The
      app can be chosen in Settings → Default digital assistant app; the assistant gesture
      opens Duck listening, including over the lock screen (with a "require unlock for
      actions" pref).
    - A `TileService` Quick Settings tile that toggles conversation mode.
    - An `AppWidgetProvider` widget: talk button plus a status line (polled while visible).
    - A **foreground service** (microphone + media playback types) for conversation mode
      with the screen off, showing a persistent notification with a Stop action.
    - Android Keystore storage for the device token.
  - Audio is native capture (16 kHz PCM) and playback through the plugin; the same
    `audioSegment` / `tts` protocol frames as the PWA. The phone's own echo cancellation
    comes from `AcousticEchoCanceler` / the voice-communication audio source.
  - **Connectivity:**
    - The Funnel URL by default. Switch to the tailnet address when Android reports
      `TRANSPORT_VPN` and the address answers within ~300 ms; switch back on loss, resuming
      the Duck Protocol session.
    - The same pairing and device-approval flow as the PWA, **plus a device-bound key**:
      - A Keystore key pair (StrongBox if present, non-exportable) is created at pairing,
        and the public key is stored with the device record in `remote_devices`.
      - `ws_authed()` / `authed()` gain a challenge–response step for devices that have a
        key, so the token alone no longer authenticates them.
  - **Target device: Nothing Phone (2a), Nothing OS 4.1, Android 16.**
    - **Assistant role:** choose Duck under Settings → Apps → Default apps → Digital
      assistant app, then set "press and hold power button" to the digital assistant. Check
      both menus on Nothing OS 4.1, which can name them differently.
    - **Android 14–16 background rules:**
      - A `microphone` foreground service must start from a user-visible moment: the
        assistant session, the tile tap (using `startActivityAndCollapse(PendingIntent)`, as
        Android 14+ requires) or the widget button. Never from the background.
      - Declare the `microphone` and `mediaPlayback` FGS types and the matching permissions.
    - **Battery:** Nothing OS manages background apps aggressively. Ask for the
      battery-optimization exemption while conversation mode is used, and test a 30-minute
      screen-off session.
    - **Glyph lights (optional, fun):** the Phone (2a) has three Glyph zones on the back, and
      Nothing's Glyph Developer Kit lets apps drive them (it needs an API key from Nothing).
      Duck could show listening / thinking / speaking, and a slow pulse when something needs
      you, phone face-down. Check that the GDK still supports the (2a) on Nothing OS 4.1
      first.
  - Build tooling: Android SDK/NDK and `tauri android build`. A sideloaded APK; no store.
- **Done when:**
  - Long-pressing power opens Duck listening.
  - The tile starts conversation mode.
  - A 10-minute walk-and-talk with the screen off works.
  - It works over Funnel with Tailscale off, and switches to Tailscale mid-conversation when
    you turn it on. Latency for both is recorded in As built.
  - A copied device token without the Keystore key is rejected.
- **Out of scope:** iOS; Play Store publishing; native push via Firebase (PWA Web Push
  covers notifications).

### Track D — Delegation to sessions

#### Step D1 — Worker sessions: workspace, brief, result contract

- **Goal:** Duck can hand a heavy task to a Claude Code session on your subscription, and get
  a reliable result back when it's done.
- **Depends on:** W2 (`create_session`, `wait_for_session`), M1 (model per session).
- **Build:**
  - **Duck workspace:**
    - `C:\Users\mrsha\repos\Duck` (a pref; the debug build uses the sibling
      `C:\Users\mrsha\repos\Duck.dev`), registered as a Workbench project "Duck" on first use.
      It gets `tasks/`, a `CLAUDE.md` describing the worker role and the output contract,
      and `.claude/settings.json`.
    - Optionally a git repo, so task results have history. Workers never push.
    - The settings allow WebSearch, WebFetch, Read/Write/Edit/Glob/Grep inside the workspace,
      and the read-only `firefox` MCP tools. Nothing outside the folder.
  - Tool **`run_task(title, brief, kind: research|writing|browser|analysis|code,
    tier: standard|involved|serious, projectId?, model?, effort?)`**:
    - Creates `tasks/<date>-<slug>/brief.md`.
    - Resolves the tier through the tier table (§Design → Worker tiers: standard = Sonnet
      `medium`, involved = Sonnet `high`, serious = Opus `medium`). Explicit
      `model` / `effort` overrides it.
    - Spawns with `--model <m> --effort <e> --permission-mode dontAsk`, through M1's model
      plumbing, which this step extends with `effort` and `permissionMode` arguments on
      `pty_spawn` (effort validated against Claude Code's `low|medium|high|xhigh|max`).
      - The flags are always explicit: without them a worker inherits your defaults (Opus,
        `xhigh`, `auto`). The first hook's `effort.level` and model confirm the tier.
      - Non-browser kinds also get `--strict-mcp-config --mcp-config <minimal>`, so they
        don't each start a Firefox bridge (~140 MB, X0).
      - The Duck folder is pre-trusted on first use: Claude Code's trust dialog for a new
        folder defaults to "No, exit".
    - Picks the place: the workspace, or the target project's worktree for `code`.
    - Starts the session with a first prompt: "Read `brief.md`, do the task, then write
      `result.md` + `result.json` here", plus the contract.
    - Returns a task id immediately. The thread shows a **task card** with status, model,
      elapsed time, and "open console".
  - `src/assistant/tasks.ts`, a task store (in memory, plus `assistant_tasks` in SQLite):
    task id ↔ instance id, folder, state, timestamps.
    - On `done`: read `result.json`. A missing or invalid file triggers one automatic nudge
      ("write the result files"), then a fallback to `readLastResponse`.
    - Posts a follow-up message into Duck's thread, so Duck reports without being asked.
  - Tools `task_status(taskId)` (with an optional Haiku progress summary), `task_followup(
    taskId, prompt)` (`sendOrQueue` into the same session), `task_close(taskId)` (close the
    console, keep everything on disk), and `list_tasks`.
  - **Ownership:** instances created by `run_task` carry `owner: "duck"` (an instance
    field). `notifications.ts` skips desktop toasts and push for them; Duck gets them
    instead. The instance card shows "Duck · <task title>".
  - **Concurrency:** at most N running workers (pref, default 2); further tasks queue and
    start when one finishes.
- **Key files:** `src/assistant/tasks.ts`, `src/assistant/tools/tasks.ts`,
  `src/state/notifications.ts`, `src-tauri/src/registry/mod.rs` (`owner` column),
  `src-tauri/src/assistant/workspace.rs`.
- **Done when:**
  - "research how other Tauri apps do auto-update and recommend one" runs as a Sonnet
    worker that uses web search on the subscription. Duck announces the headline when it
    finishes, with $0 of API spend for the research itself (checked in `assistant_usage`).
  - A follow-up goes into the same session.
  - The worker never pinged you directly.
  - With 3 tasks requested, the third waits for a free slot.
- **Out of scope:** routing heuristics and limit awareness (D2).
- **As built (2026-10-20):**
  - **Workspace** (`src-tauri/src/assistant/workspace.rs`): `~/repos/Duck`
    (`Duck.dev` in a debug build) or the folder in Duck's settings. Made on first use
    with `tasks/` and a `CLAUDE.md` (the worker's role and the result contract; one
    you've edited is left alone), and registered as the project "Duck" when its first
    worker starts (`port.ensureProject`, once even when workers start together).
    - **Not a git repo** (left out; the folders are plain files).
    - **The allow list isn't in the workspace's `.claude/settings.json`**, as planned,
      but in a per-worker settings file in app data (`duck-sessions[.dev]/workers/
      <instance>.json`, passed with `--settings`), so a worker can't rewrite its own
      permissions. Rules are absolute (`Read/Edit/Write(//c/…/Duck/**)`), plus
      `WebSearch`, `WebFetch`, and for a browser task X0's Firefox tools.
  - **Launch flags:** a worker is registered by instance id (`worker_sessions`,
    main-DB migration v15) in `startNewSession`'s `beforeLaunch`, and `pty_spawn` adds
    `workspace::launch_args` at every launch and resume: `--effort`,
    `--permission-mode dontAsk`, `--settings <file>`, and for research / writing /
    analysis `--strict-mcp-config --mcp-config <no servers>`. The model goes through
    M1's `instances.model`.
    - Checked with the CLI first (Haiku, `-p`): `permissionMode: dontAsk`, no MCP
      servers, a write in the workspace allowed, and a write one folder up refused
      ("denied because Claude Code is running in don't ask mode").
    - **No `effort` column or picker** on instances: effort is a worker's launch
      flag only.
    - A worker's own mode wins over a picked one, as for drafting sessions.
  - **Code tasks** run in the target project's own worktree (`worktree: true`), in the
    project's own mode (so T2 judges their prompts), with the user's MCP servers, and
    `--add-dir <task folder>` plus an allow rule for that folder only. Remote projects
    are refused.
  - **Pre-trust:** no write to `~/.claude.json`. `deliverWhenReady` takes
    `trustFolder`, which answers the folder-trust dialog by its "Yes, I trust this
    folder" option (found by its words, since Claude Code has drawn it with Yes first
    and with No first). Only Duck's workspace asks for it.
  - **Background start:** a worker doesn't switch your project or take the focus.
    `openConsole(…, {background})` opens it unfocused, and `BackgroundConsoles` (mounted
    in `App.tsx`) holds its terminal off screen until it's running, since the dock only
    mounts the shown project's consoles. It docks normally when you open the project.
    A follow-up to a worker whose console isn't running starts it the same way.
  - **Tasks** (`src/assistant/tasks.ts`, `createTaskManager`): records in
    `assistant_tasks` (duck.db, JSON). States: queued, running, done, blocked,
    needs_decision, failed, closed.
    - **Concurrency:** `maxWorkers` (setting, default 3, up to 5; raised from the planned 2 on 2026-10-20: ~430 MB per worker). A start takes its slot
      before its first await, so tasks asked for together start side by side, and the
      rest queue in order.
    - **Turn end:** a fresh `result.json` (written after the run began, valid against
      `{status, headline, question?}`) settles the task. Otherwise one nudge prompt,
      then the last reply (`port.lastResponse`) stands in (`resultFrom: "reply"`). A
      session that ends without a result fails the task.
    - **Reporting:** every outcome goes to the asking thread as a
      `<workbench_event>`, so Duck tells you without being asked. A worker waiting on a
      prompt is reported once per prompt. Report wording drops the worker's own
      trailing full stop.
    - **Follow-up:** the same session, the task back to running, and only a result
      newer than the follow-up counts.
    - **After a restart:** a task that was running is settled from its result files,
      or failed with a word on how to go on (its console went with the app).
  - **Tools** (`src/assistant/tools/tasks.ts`): `run_task(title, brief, kind, tier,
    project?, model?, effort?)` (reversible; posts the task card), `task_status(task,
    progress?)` (with `progress`, the start of the latest reply rather than a Haiku
    summary), `task_followup`, `task_close`, `list_tasks`. Tasks are named by id or
    exact title. The tier phrases ("quick", "thoroughly", «это важно») are in
    `run_task`'s description, and the system prompt has one line on offloading.
  - **Ownership:** no `owner` column. `state/duckOwned.ts` holds instance → task,
    filled by the task manager (and again from the records at start). It drives the
    card's "duck ·" mark, keeps `notifications.ts` quiet (needs-you, escalation,
    stuck and done), and drops the "shared" warning (workers share the workspace by
    design). Closing a task gives the session back to you.
  - **UI:** the task card in the thread (state, `model · effort`, elapsed time, the
    headline, "open console", "close"); the `tasks` event and `task.close` message in
    the protocol; settings for workers at once, the workspace and each tier's model
    and effort. `list_sessions` now reports each session's permission mode and
    `workerTask` (M4's leftover).
  - **Verified:**
    - 19 vitest cases (task manager and tools; 368 in all) and 2 for the trust
      dialog; 6 Rust tests (222 in all). tsc, eslint and clippy are clean.
    - **Live in the dev app:** "research how other Tauri apps do auto-update and
      recommend one" ran as a Sonnet `medium` worker with the planned flags, without
      leaving your project. It finished in 1m 14s, and Duck announced the headline
      unprompted. Duck's own turns cost $0.039; the research ran on the subscription.
      A follow-up went into the same session and updated the result. Three haikus asked
      for at once: two ran together and the third started the moment one finished. The
      cards kept their "duck ·" mark after a restart, and the card's "close" worked.
  - **Not verified live:** that a worker's done or needs-you raises no toast (the
    path is the same check as `watching()`); a code task; a browser task.

#### Step D2 — Offload routing, subscription-limit awareness, Duck as the worker's user

- **Goal:** Duck decides on its own when to offload, respects your subscription limits, and
  handles its workers' questions.
- **Depends on:** D1, W3, T2.
- **Build:**
  - **Routing rules** in the system prompt (§Design → Offloading), with 8–10 examples
    measured in X0: what Duck does itself vs `haiku_task` vs `run_task`. A
    "do it here" / "send it to a session" phrase overrides.
  - **Tier choice:** rules and examples for standard / involved / serious, plus the phrase
    overrides. The chosen tier is shown on the task card, with an "upgrade and re-run"
    action.
  - **Limit awareness:** before `run_task`, read `usage_limits`.
    - Under the thresholds (5-hour < 70%, weekly < 80%; agreed 2026-10-18): run a session
      worker.
    - Over them: **automatically run an API worker** (`src/assistant/apiWorker.ts`).
      - The same brief, tier and result contract; it writes the same `result.md` /
        `result.json` into the task folder, so the rest of the flow doesn't care.
      - It runs as a Sonnet 5.5 sub-loop with web tools at the tier's effort (Opus 5.5 for
        serious), `x-wb-purpose: api-worker`.
      - The card is labelled "API · over subscription limit · $0.18".
    - It is subject to Duck's API soft limit and cap like everything else; if those are hit
      too, the task queues until the window resets.
  - **Duck as the worker's user:**
    - A worker's `AskUserQuestion` (pendingChoice `question`) in a Duck-owned session is
      answered by Duck from the thread's context, through `choose` (`remoteActions.ts`), and
      logged in the task card ("Duck answered: Postgres, because you said earlier…").
    - If the brief or the conversation doesn't settle it, Duck asks you, and relays your
      answer.
    - Plan approvals in workers follow T3's plan review.
  - **Results archive:** a "Tasks" list in the drawer (title, model, duration, headline),
    opening `result.md` in the editor panel. An optional "save to project notes" per result.
- **Done when:**
  - Asked for a heavy comparison, Duck picks `run_task` without being told.
  - A one-URL question stays on the API.
  - With `usage_limits` forced to 85% weekly, the task runs as an API worker, labelled with
    its cost, and produces the same result files.
  - "Compare X and Y" picks standard, "thoroughly compare…" picks involved, and "this
    decides our architecture, think it through" picks serious (Opus).
  - A worker's clarifying question is answered by Duck with a logged reason.
- **Out of scope:** session-backed conversation (D3).

#### Step D3 — Session-backed thinking modes (experiment)

- **Goal:** Find out whether rubber duck and deep chat can run their *thinking* in a session
  too, with Duck relaying voice and text, so long conversations also cost no API.
- **Depends on:** D1, S1, V4.
- **Build:**
  - A mode flag `backend: api | session` on S1 modes.
  - With `session`, the mode's thread is bound to a dedicated worker session (Sonnet or Opus;
    workspace `conversations/`).
    - Each user turn is pasted as a prompt.
    - The reply is read from the transcript on `done` (`readLastResponse`) and spoken.
  - Duck stays in the loop only for app actions it notices in the reply ("want me to start
    that?").
  - Measure the time from end of speech to the start of the spoken reply, and subscription
    usage per hour, against the API version.
- **Done when:** a 15-minute session-backed rubber duck runs end to end, the numbers are in
  As built, and you've decided whether to keep it as an option, make it the default, or drop
  it.
- **Out of scope:** making it the default before the measurements.

#### Step D4 — Headless workers over stream-json

- **Goal:** Duck's workers run without a terminal: Claude Code speaking its structured
  protocol (`claude -p --input-format stream-json --output-format stream-json`, as the
  Agent SDK does), so Duck sends messages, sees every event, answers permission
  requests as data and interrupts cleanly. No screen reading and no timing guesses.
  Asked for on 2026-10-20 with W6 and T4.
- **Depends on:** D1, D2; shares the stream-json process code with M3.
- **Build:**
  - **A worker kind of session** with no PTY: a backend process per worker, its
    stdin/stdout framed as stream-json; events go to the webview as they arrive. The
    session id, the transcript file and the hooks stay as for any session, so the
    status engine, summaries (W3) and the trust log keep working.
  - **The transcript view is its console:** the drawer's "open console" opens the
    transcript view (it already renders transcripts), with its composer sending
    through the protocol. A "take over" turns it into a normal terminal session
    (`--resume` in a PTY) when you want the TUI.
  - **Permissions as data:** `--permission-prompt-tool` (a tool on Duck's MCP server,
    M3) or the protocol's own permission requests go to the trust watcher; no menu,
    no keys.
  - **Delivery:** follow-ups are messages on stdin, taken when Claude Code says so;
    `interrupt` is a protocol message. `promptOutbox` is not needed for them.
  - The worker's flags (effort, allow list, MCP, `--add-dir`) carry over from D1.
- **Check first:** which slash commands work headless (`/compact` at least), whether
  `--resume` with stream-json keeps the conversation, and what a long run costs in
  memory against a PTY session.
- **Key files:** `src-tauri/src/assistant/` (a worker process module), `src/assistant/tasks.ts`,
  the transcript view.
- **Done when:** a research task and a code task run headless end to end, a follow-up and
  an interrupt work, a permission request is answered without a menu, and "take over"
  opens the same conversation in a terminal.
- **Out of scope:** your own sessions (they stay terminals: you use slash commands and
  the full TUI).

### Track L — Learning & self-development

#### Step L1 — Long-term memory: files, index, recall

- **Goal:** Duck keeps durable, readable memory about what matters, and brings it up when it's
  relevant.
- **Depends on:** W4, D1 (workspace + git).
- **Build:**
  - Make `C:\Users\mrsha\repos\Duck` a git repo on first use. L4 adds the private remote.
    Duck commits memory and skill changes itself, with messages like `memory: decided
    SQLite for notes sync`. Commits go through Workbench's shared background git queue
    (`src-tauri/src/gitqueue/`, improvement plan N3; if N3 hasn't landed, L1 builds that
    module there). L4 adds the judgment lane on top.
  - The memory layout of §Design → Long-term memory: topic files, `journal/`, `lessons.md`.
    The entry format is a dated bullet plus `(src: thread:… | task:…, conf: high|med|low)`.
  - `src-tauri/src/assistant/memory.rs`:
    - Parse the files into entries.
    - An FTS5 table in `duck.db` (`tokenize='trigram'`), fed by a `notify` watcher on
      `memory/`.
    - Commands `memory_search(query, k)`, `memory_write(topic, entry)`,
      `memory_forget(match)`.
    - **Project notes are indexed too, read-only**, in a separate FTS table fed by a
      watcher on the notes root. `recall` returns note hits labelled `note: <project> /
      <name>`, so "what did I write about the auth refactor" finds them. Notes are never
      copied into memory, and consolidation and housekeeping never touch them.
  - Tools:
    - `remember(topic, fact, why)` is in-app tier (a chip with Undo).
    - `recall(query)` is read tier.
    - `forget(query)` previews the matches on a card, then deletes them.
    - A **secret filter** runs before any write: key/token/password patterns and long
      high-entropy strings are rejected.
  - **Automatic recall:** before each main-thread request, run `memory_search` on the user
    message. Up to 3 hits above the threshold are appended as a `clear_at:
    "next_user_message"` system note (beta `mid-conversation-system-clear-at-2026-08-21`),
    so they don't pile up in the history.
  - **Lessons:** when you correct Duck ("no, I meant…", «не то»), it writes a `lessons.md`
    entry naming the mistake and the right behavior.
  - Drawer → **Memory** view: browse by topic, search, edit (opens the file), forget, and
    "don't remember this conversation" (a per-thread flag).
- **Key files:** `src-tauri/src/assistant/memory.rs`, `src/assistant/tools/memory.ts`,
  `src/assistant/engine.ts` (automatic recall), `src/panels/Assistant/Memory.tsx`.
- **Done when:**
  - Something decided in one thread ("we'll use SQLite for notes sync") is surfaced
    unprompted a week later when notes sync comes up, in Russian or English.
  - "Forget what I said about X" removes it from the files and the index.
  - A pasted API key is refused by `remember`.
  - The Duck repo has one commit per memory change.
- **Out of scope:** consolidation (L2); embeddings.

#### Step L2 — Consolidation, journal, and recall quality

- **Goal:** Memory stays tidy and trustworthy without you curating it.
- **Depends on:** L1, W3.
- **Build:**
  - A **daily consolidation** job: the first idle hour after midnight, or on demand
    ("tidy your memory").
    - It runs as a Haiku pass (`x-wb-purpose: consolidate`) over the day's threads, task
      results and `remember` entries.
    - Output is structured: new entries, merges (old → new), contradictions, stale entries
      to retire, and a journal paragraph.
    - Merges and retirements are applied directly and logged. **Contradictions** become one
      question for you the next time you talk ("Earlier: Postgres. Today: SQLite. Which
      holds?").
    - One commit per run.
  - **Recall quality check:** log every automatic-recall hit and whether the reply used it,
    then review the hit rate after two weeks. If keyword recall misses obvious things, add
    the local embedding index (`multilingual-e5-small` ONNX via `ort`, CPU, lazily loaded,
    unloaded when idle) beside FTS, with hybrid ranking.
  - **Skill suggestions:** the consolidation pass also spots repeated multi-step requests,
    and queues a "make this a skill?" offer (S2).
- **Done when:**
  - A week of use produces a readable journal.
  - A deliberate contradiction is caught and asked about.
  - Duplicates are merged.
  - The recall hit-rate numbers are in As built, with the embeddings decision recorded.
- **Out of scope:** cross-device sync of memory (it's a git repo; a remote can be added by
  hand).

#### Step L3 — Self-development through Opus sessions

- **Goal:** "Duck, improve yourself: …" produces a reviewed, tested change to Duck's own
  prompts or code, which you approve.
- **Depends on:** D2, S2, L1, T1.
- **Build:**
  - **Prompts as data:** move Duck's system prompts, routing examples and the tier table
    into `C:\Users\mrsha\repos\Duck\config\`. They are hashed and loaded at thread start,
    with built-in defaults if a file is missing or invalid.
    - Tool `propose_config_change(file, diff, why)` shows a card with the diff. On approval
      it is applied, and takes effect on the next thread.
  - **`documentation/duck-architecture.md`** (started in A2): audit it against the code and
    fill the gaps. It covers modules, `WorkbenchPort`, the Duck Protocol, the tools, trust,
    voice and tasks, with "where to change X" pointers, so a fresh Opus session can find its
    way around.
  - Tool **`improve_duck(request, scope: config|code, effort?)`**:
    - `config`: Duck drafts the change itself, as a `propose_config_change` card.
    - `code`: `run_task` at tier **serious** (Opus, `medium` by default) in a **worktree of
      the Workbench repo** (the existing `provision_worktree`), on branch `duck/<slug>`.
    - The brief template includes:
      - the request and the related `lessons.md` entries;
      - pointers to this plan, `duck-architecture.md` and the guardrails;
      - the test commands (`npm run lint`, `npm test`, `cargo test` in `src-tauri`);
      - "no merge, no push";
      - `result.md` with a summary, the files touched, and test output.
  - **Safety-layer detection:** if the branch diff touches `src/assistant/trust/**`,
    `src-tauri/src/assistant/{proxy,budget,key}.rs` or the floor data, the result card
    carries a red "touches the safety layer" badge, and the merge needs a second confirm.
  - **Review and merge:** the result card has "Open diff" (the Diff/Review panel on the
    branch), "Ask for changes" (`task_followup`) and "Merge". Merge is a trust-floor action,
    always yours, and uses the existing git integration (`integrate_worktree`).
  - **Activation:** after a merge, a card offers "rebuild & restart": dev build
    (`npm run tauri:dev` in a shell console) or release build (`npm run tauri:build`, then
    restart). Duck's state lives in `duck.db` and the workspace, so it survives.
  - **Proposals:** a weekly look at `lessons.md` and repeated tool errors. If there is a
    pattern, Duck *suggests* a self-improvement task; it never starts one unasked.
- **Key files:** `src/assistant/tools/improve.ts`, `src/assistant/config.ts`,
  `documentation/duck-architecture.md`, `src/assistant/tasks.ts`.
- **Done when:**
  - "Duck, when I say 'the backend' always pick the session titled backend-api" is solved as
    a config change, without code.
  - "Duck, add a tool that lists my git stashes across projects" produces an Opus branch
    with passing tests and a diff you review and merge; after restart the tool works.
  - A change touching `trust/` shows the badge and asks twice.
- **Out of scope:** Duck merging or deploying anything on its own; changing Workbench code
  outside Duck's modules unless the request says so (the brief names the allowed paths).

#### Step L4 — Routines, backup and housekeeping

- **Goal:** Duck's data repo is backed up and stays tidy without you thinking about it, and
  Duck can run anything on a schedule.
- **Depends on:** L1, D2, S2.
- **Build:**
  - **Routines:** a small scheduler in Duck (`src/assistant/routines.ts`, a `routines` table
    in `duck.db`).
    - Each entry is `{id, title, schedule (cron-like or "daily after first idle hour"),
      action: skill | run_task brief | internal job, enabled, lastRun, nextRun}`.
    - It runs while Workbench is running; a run missed while the app was closed fires once
      on the next start (no backlog of repeats).
    - Tools `schedule(…)`, `list_routines`, `pause_routine`. Routines show in Duck settings.
      Morning briefings and similar can now be routines.
  - **Background git lanes** (§Design → Two repos): `src-tauri/src/assistant/gitlane.rs`.
    - The mechanical lane is the shared `gitqueue` (from N3 or L1). `gitlane.rs` adds Duck's
      jobs to it and shows results as `duck-git` *info* items.
    - On a failure that needs judgment (non-fast-forward, conflict, lock or corrupt state):
      enqueue a `run_task` (standard tier, Sonnet `medium`) with a repair brief, in the
      background. It escalates to *needs you* only if the worker reports `blocked`.
  - **Backup** (approved 2026-10-18):
    - On setup, run `gh repo create <name> --private` and set it as `origin` of
      `C:\Users\mrsha\repos\Duck`.
    - A built-in routine pushes after each consolidation, and at most hourly otherwise.
    - A trust rule `assistant:git_push(repo: duck-data, remote: origin)` is allowed by a
      **named floor exception**: only this repo and remote, never `--force`.
    - Push failures surface as *info*, escalating to *needs you* after a day.
  - **Housekeeping routine** (weekly, Sunday after the first idle hour; **if Workbench
    isn't running on Sunday, it runs the next time Duck starts**, once): a background
    `run_task` at tier standard (Sonnet `medium`) in the Duck workspace, with a fixed
    brief.
    - The brief: repo hygiene, task retention (default: keep `result.md` forever; delete
      bulky intermediate files after 30 days; fold old tasks into `tasks/INDEX.md`), memory
      tidy-up, skills lint.
    - It works on branch `housekeeping/<date>`. Duck fast-forwards `main` when the diff
      only tidies (no entries removed without a source-backed reason); otherwise it posts a
      *report* with the diff for your OK.
  - **Monthly docs cleanup** of `documentation/duck-architecture.md` and the plans'
    As-built notes, through `improve_duck(scope: code)`, as a reviewed branch in the
    Workbench repo.
- **Done when:**
  - The Duck repo has a private remote and is pushed after consolidation.
  - While you chat with Duck, ten memory writes commit in the background with no added
    reply latency.
  - A simulated non-fast-forward push is repaired by a background worker without
    interrupting you.
  - Skipping Sunday runs housekeeping on the next start.
  - A forced-push attempt is refused.
  - A housekeeping run produces a tidy branch and is fast-forwarded.
  - A routine missed while the app was closed runs once on the next start.
- **Out of scope:** routines while Workbench isn't running (that's the "separate Duck" path
  in §Separable, not separate).

### Track P — Plan autopilot

#### Step P1 — Autopilot loop for one session

- **Goal:** Duck runs your "step → compact → continue" loop on a session, and stops only
  when something needs you.
- **Depends on:** W2, W3, T2 (live-mode trust), D2 (Duck answering questions), V5
  (announcements; P1 can start with push only).
- **Build:**
  - `src/assistant/autopilot.ts`: per-instance autopilot state `{planPath, continuePrompts
    (default ["continue the implementation", "proceed to the next step"]),
    situationalPrompts: bool, compactPolicy: per-step-review (default) | always | never,
    compactFocus, maxSteps, stepsDone, state: running|paused|stopped, log[]}`, persisted in
    `duck.db`.
  - The review's structured output adds `compact: yes|no`, `compactReason` and
    `nextPrompt?`.
  - **From X0:**
    - `statusline::ingest` keeps `context_window.used_percentage` per instance (the POST
      has it; today it's dropped), so the review sees the real context fill.
    - Fix the reducer first: SessionStart{source: compact} only clears `compacting` and keeps
      the phase. Today it goes `to("idle")` before PostCompact, which during a mid-turn
      auto-compaction could deliver a queued prompt mid-turn.
    - Queue "continue" with `setQueued` right after sending `/compact`, never with a second
      `sendOrQueue`: the card is at rest until PreCompact arrives.
  - Starting it: the tool `start_autopilot(instanceId, planPath?, maxSteps?)`, or the
    instance card menu → Autopilot. If the plan path isn't given, Duck finds it from the
    session's recent prompts and transcript and asks you to confirm.
  - The loop, on each `done` transition for the instance:
    1. Collect the turn: the transcript text since the last user prompt
       (`plainText.ts`), the last response, and the plan file's progress section.
    2. **Step review:** Sonnet `low` (`x-wb-purpose: autopilot-review`), structured output
       `{verdict: continue|needs_you|plan_done, stepId?, summary, reason, question?}`, with
       the per-plan checklist.
    3. `continue`:
       - If the review says `compact: yes`: `sendPrompt("/compact <focus>")` →
         `onCompactionEnd`.
       - Then `sendOrQueue(prompt)`, where the prompt is either your phrasing ("continue
         the implementation" / "proceed to the next step") or the review's situational
         prompt. This reuses the queue fix from commit `ca1304c`.
       - Compaction is never sent while the session is `working`, only after a reviewed,
         finished step.
    4. `needs_you` / `plan_done` → pause, then a proactive update with the summary and the
       question. Your reply is relayed with `sendPrompt`; "resume" restarts the loop.
  - Permission prompts during the turn are left to T2. If the trust policy has to *ask*
    you, autopilot shows "waiting on you" without counting it as a failure.
  - Instance card: an autopilot badge (step, next step, state), Pause / Stop / Step log.
    The same is shown in the phone dashboard.
- **Done when:**
  - Autopilot runs 3 consecutive steps of a real plan (e.g. this one) unattended: each one
    reviewed, compacted, continued.
  - It stops with a clear question when a step ends with the agent asking for a decision.
  - Your spoken answer resumes it.
  - The step log shows every verdict.
- **Out of scope:** multiple sessions, time windows, limits (P2).

#### Step P2 — Unattended runs: limits, windows, stalls, checklists, several sessions

- **Goal:** Autopilot is safe to leave running overnight or through a workday.
- **Depends on:** P1, D2 (limit reading).
- **Build:**
  - **Stop conditions:**
    - `maxSteps`, or "until done";
    - a time window ("only 22:00–07:00", or "until 18:00");
    - the same step reviewed as failed twice;
    - a **stall**, meaning a turn running more than 3× the median step time (Duck checks
      in with a progress summary first);
    - the session ending or crashing.
  - **Subscription limits:** before each continue, read `usage_limits`. Above the 5-hour
    or weekly threshold, pause with "resuming at 14:20" and resume automatically after
    `resetsAt`. There is no API fallback for autopilot.
  - **Per-plan checklist** (stored with the autopilot; defaults detected from the plan's
    format, e.g. "tick the Progress tracker", "append As built", "tests pass", "commit
    made"). The review checks each one, and a missed item becomes a fix-up prompt
    ("you didn't tick the tracker"), not a stop, up to once per step.
  - **Several sessions on autopilot at once**, each with its own state. Announcements are
    batched across them.
  - **Morning summary** after a run that spanned your absence: a *report* when you're next
    around, with steps done per session, where each stopped and why, and what needs you
    first.
- **Done when:**
  - An overnight run on two sessions stops by its window, pauses for a limit and resumes,
    and delivers a correct morning summary.
  - A stall is detected and reported.
  - A missed tracker tick gets one fix-up prompt.
- **Out of scope:** autopilot editing the plan itself (it can *propose* plan edits as a
  `needs_you`).

### Track T — Trust

**The principle (decided 2026-10-19, after W2's live test):** Duck exists to speed you up,
so a card for every small action defeats it. Guardrails come from rules, a short built-in
floor, a decision log you can read afterwards, and a kill switch, not from asking. A card
is for what the floor and the rules can't settle. Reliability matters as much as the
rules: every failure found in a live test becomes a regression test (W2's string option
and the dropped first Enter are the first two), and anything that drives the TUI is
checked in the scratch PTY first.

#### Step T1 — Trust engine for the Assistant's own actions

- **Goal:** Replace W2's tier → card mapping with the trust engine (§Design → Trust policy)
  for the Assistant's own consequential tools, with an audit log and a kill switch. Duck acts
  without a card on what the rules allow.
- **Depends on:** W2.
- **Build:**
  - `src/assistant/trust/`:
    - `rules.ts`: parse and match Claude Code-style rules (`Tool(specifier)`, `:*` prefix,
      `**` globs, `domain:`) plus `assistant:<tool>`. Rules are scoped global or per project.
      Precedence is deny > ask > allow, as in Claude Code.
    - `floor.ts`: the built-in always-ask list as data with tests. Edits need a typed
      confirmation.
    - `engine.ts`: `decide(request) → {decision, layer, reason}`, layers 1–6 in order. Layers
      4–5 (mandate and judge) are stubs that answer "ask" until T2.
  - Migration: `assistant_rules` and `assistant_decisions`. Commands to list, add and remove
    rules and to page through decisions.
  - Kill switch: a `toggleTrust` command (palette + hotkey), a tray menu item, and a state
    shown in the drawer header. `meta` `assistant_trust_paused`.
  - Per-project mode: **off** (everything asks), **shadow** (decide and log, still ask),
    **live**. New projects default to **live** on the starter rules (changed 2026-10-19
    from shadow); shadow is there for a project you want to watch first.
  - **Starter rules** (global, editable):
    - Allow: `assistant:send_prompt`, `assistant:create_session`, `assistant:append_note`,
      `assistant:create_note`, `assistant:write_note`, `assistant:interrupt_session`, and
      `assistant:answer_choice` when the request is covered by a mandate (T2) or the
      answer is a question's option.
    - Ask: `assistant:stop_session` on a working session, `assistant:delete_note`,
      `assistant:resume_session` over a running session.
    - The floor (always ask, can't be overridden by a rule): anything that pushes,
      force-anything, deletes outside a worktree, touches credentials or `~/.claude`.
  - **Explicit permission in the request counts.** "Tell it to continue, and approve it if
    it asks" is a mandate for that session: the matching answers run without a card and
    are logged against the message that granted them.
  - UI: Assistant settings → Trust (rules table, floor, mode per project). Drawer →
    **Decisions** view, with Make a rule / Always ask for this.
- **Key files:** `src/assistant/trust/*`, `src/assistant/policy.ts` (now a thin adapter),
  `src-tauri/src/assistant/trust.rs`, `src-tauri/src/db/mod.rs`, `src/panels/Assistant/*`.
- **Done when:**
  - Unit tests cover rule matching, precedence, and the floor overriding an allow rule.
  - On the starter rules, a note rewrite and an interrupt run without a card and show in
    Decisions.
  - "Approve it if it asks" lets the next permission answer run without a card; a request
    without that line still asks.
  - Pausing trust brings the cards back immediately.
- **Out of scope:** Claude Code prompts (T2).
- **As built (2026-10-19):**
  - `src/assistant/trust/`:
    - `rules.ts`: `parseRule`, `matches` and `evaluate`. Bash is matched by a `:*` prefix
      (whole words) or `*` anywhere; file tools by a path glob relative to the root, with
      `//` absolute (`//C:/…` on Windows) and `~/` home; `WebFetch(domain:x)` covers
      subdomains; `assistant:<tool>(specifier)` matches what the tool says about the call.
      Deny > ask > allow; global rules plus the call's own project's. A rule that doesn't
      parse never matches, and `addRule` refuses one.
    - `floor.ts`: nine entries as data (push, force, branch-delete, delete-outside,
      credentials, claude-config, pipe-to-shell, publish, message-people), each with the
      examples it must and mustn't catch, which the tests hold it to. The floor reads text:
      a prompt Duck sends, a typed answer, and the command, path or URL a permission
      answer would let through.
    - `mandate.ts`: `findGrant`. The quote (at least 6 characters, quote marks and end
      punctuation stripped, case and spacing ignored) must be in a message the user typed
      or said in this thread (source desktop, phone or voice: never `event` or a tool
      result) within 12 hours.
    - `decide.ts`: the layers in order. Paused, a project set to `off`, and a thread the
      rate guard tripped all fall back to W2's cards. Then the floor, the confirm-prompts
      setting, the rules, the mandate, and the tier as the default. The judge (layer 5) and
      session mandates are T2's. Shadow mode decides, and the card shows anyway.
    - `store.ts`: the config in memory, written through to duck.db. The starter rules are
      seeded once on the first load, so a rule you delete stays deleted. The rate guard
      (more than 30 automatic approvals in one thread in 10 minutes) is in memory, cleared
      by resuming trust.
  - The starter rules are the allow list above, with `answer_choice(question)` as the
    question case. There are no ask rules: an ask rule beats the user's words, so
    "stop api and tests" would still have shown a card. Stopping, killing, deleting a
    note, resuming over a running session and answering a permission prompt or a plan
    have no rule, so they ask unless a grant covers them.
  - **Grants** (`grantedBy`) are on every one of those calls, not only `answer_choice`.
    The user's request for the call ("stop api and tests") counts as much as a
    permission given ahead of time ("approve it if it asks"). A grant never covers a
    "don't ask again" option.
  - **Fixes from the first live test:**
    - Duck asked to stop sessions you had told it to stop, and the turn waited on those
      cards before the next task. This is fixed by the grants above.
    - New tool `kill_session` (consequential): the rail's "kill instance" (close the
      console, end the process, close its review panel, remove the row, renumber). It
      refuses a session with a worktree, which would be left on disk, and a remote one
      in tmux, which needs your SSH password: those go through the rail.
      `renumberInstances` moved from the rail into `state/registry.ts` so both share it.
    - A session started from the dev build rendered plain white. The app had been
      launched from a Claude Code shell, and its `NO_COLOR=1` reached every console.
      `main.rs` already dropped the session markers (`CLAUDECODE`, …); it now also
      drops `NO_COLOR` when `CLAUDECODE` shows the app came from such a shell.
  - `policy.ts` is now the adapter: it builds the request, runs `decide`, applies the rate
    guard, and logs every decision except calls that would have run under W2 anyway. A
    `deny` becomes the call's error result ("Not done: a trust rule refuses this…"),
    and the rate guard's trip is a `trust` notice in the thread. Without a trust store (it
    failed to load), the gate is W2's.
  - Engine:
    - The gate gets `threadId`, `toolUseId`, the card's `summary`, and the tool's
      `facts` (`ToolDef.trust`, read through `registry.trustFacts`).
    - It may answer `{verdict: run | ask | deny, reason?, notice?}`.
    - Every action tool now declares its project, and `send_prompt` / `create_session`
      their prompt text.
    - `answer_choice` takes `grantedBy`.
  - Storage: duck.db migration v3 (`assistant_rules`, `assistant_decisions` keeping the
    last 5000 rows and outliving their thread, `assistant_trust_modes`). The kill switch,
    the floor entries turned off, and the seeded flag are in `meta`
    (`src-tauri/src/assistant/trust.rs` and its commands).
  - Kill switch, in four places:
    - the drawer header's pill;
    - `toggleTrust` (Ctrl+Alt+Shift+Space, also in the palette);
    - the tray's new right-click menu ("Pause Duck's trust", a check item; left click
      still shows the window);
    - a ⏸ on the title-bar Duck button.
    The flag lives in Rust, so the tray works with no window, and `assistant-trust-paused`
    keeps the webview in step.
  - UI: drawer settings → **trust rules…** (kill switch, rules with add and remove, a
    mode per project, the floor with a typed confirmation to turn an entry off), and
    **decisions…** (newest first, "auto-approved today", **make a rule** on an ask, and
    **always ask for this** on an allow). Undo per decision isn't built: a note edit
    already has its chip's undo.
  - **Verified:**
    - 38 new vitest cases: 8 rules, 11 floor, 17 policy end to end over the real tools
      and a fake port, 1 engine, 1 for `kill_session`; the fallback test was rewritten.
      307 passing.
    - 5 new Rust tests (205 passing).
    - tsc, eslint and clippy are clean.
    - Checked live by the user, with the fixes above.

#### Step T2 — Auto-answering Claude Code permission prompts

- **Goal:** Sessions keep working while you're away: the Assistant answers their permission
  prompts under the policy.
- **Depends on:** T1, M1. (W3's summaries make the mandate richer but aren't needed: the
  mandate is the request that started the session, or its first prompt.)
- **Build:**
  - A watcher on `hook-event` `PermissionRequest` (+ `pendingChoice` for the option
    list):
    - Builds a request `{project, instanceId, tool_name, tool_input, mandate?}` →
      `trust.decide`.
    - On allow: `answerChoice` with the **"Yes" (once)** option, resolved by label from
      `pendingChoice`, never by a fixed digit. If the labels don't match the known shapes:
      ask.
    - On deny: Esc + a note in the thread. On ask: the usual needs-you path (notification,
      push, card).
  - **Mandate:** `create_session` (W2) stores the originating request on the instance (in
    memory plus `meta`). For sessions you started yourself, the mandate is their first user
    prompt from the transcript.
  - **Judge:** `trust/judge.ts`, a Haiku call (`x-wb-purpose: judge`) with structured output,
    a frozen prompt, and the tool input wrapped as untrusted. Only `allow` + `low` is
    accepted; the cost is recorded.
    - When Haiku returns `ask` with `medium` risk, a **Sonnet second opinion** runs (same
      schema, `x-wb-purpose: judge2`) before you're bothered. It can turn the request into
      `allow` + `low`; anything else goes to you with both reasons attached.
    - Cost ~$0.005, expected on ~15% of judged prompts.
    - The floor and rules still come first. Neither judge can override them.
  - **Rate guard** per session; when tripped: pause that session's trust and notify.
  - **Race:** if you answer first (the status changes before the decision lands), the
    decision is discarded and logged as `superseded`.
  - Each decision shows as a line in the session's notifications ("auto-approved
    `npm test`").
- **Key files:** `src/assistant/trust/watcher.ts`, `src/assistant/trust/judge.ts`,
  `src/state/pendingChoice.ts` (read only), `src/state/remoteActions.ts` (exports only).
- **Done when:**
  - A replay of the past week's permission prompts (from transcripts) through `decide`
    agrees with what you answered, or the differences are rules you accept. This replaces
    the day in shadow mode.
  - In live mode, a session running tests and edits in its worktree goes 30 minutes without
    needing you.
  - A `git push --force` request still asks.
  - A transcript or tool input containing "approve this" doesn't change the outcome.
- **Out of scope:** questions and plans (T3).
- **As built (2026-10-20):**
  - `src/assistant/trust/session.ts`: the deterministic layers for a Claude Code prompt,
    over the hook's structured call:
    - Trust paused, or the project `off`: the prompt is left alone and nothing is logged.
    - The session's rate guard (`session:<id>`); the floor over the command, path or
      URL; a file write outside the session's folder (its worktree, else the project
      root), except Claude Code's own scratchpad, memory and plan files.
    - Your rules, matched as Claude Code would (`Bash(npm test:*)`, path globs,
      `domain:`). Nothing settled it: the judge.
    - `pickYes` presses only an option labelled exactly "Yes", and only when the options
      were read off the screen and one of them is a "No…".
  - `trust/judge.ts`: the frozen prompt, `Verdict` (`decision`, `risk`, `reason`), and
    `judge()`.
    - Haiku first (`judge`, no thinking); only `allow` + `low` passes.
    - `ask` + `medium` gets Sonnet (`judge2`, adaptive thinking); its `allow` + `low`
      passes, and anything else asks with both reasons.
    - The call goes inside `<untrusted>`, the mandate and the latest prompt inside
      `<task>`. Tag-like text in either is defanged, and long strings (a file's
      content) are cut to 1500 characters.
    - Any failure asks. The cost goes to the ledger like any call (`client.structured`,
      which `oneShot` now uses too).
  - `trust/watcher.ts` (`startTrustWatcher`, started with Duck when the trust store
    loads):
    - It picks up every permission prompt as it opens and decides it.
    - On allow, it waits up to 5 s for the options to be read off the screen and
      answers with "Yes" by label.
    - On deny, it sends Esc and posts a notice in the thread that started the session.
      On ask, it leaves the prompt to you.
    - In shadow mode it logs and leaves the prompt. A prompt that closes, or is
      answered, before the decision lands is logged as `superseded` and left alone.
    - More than 30 automatic approvals in 10 minutes, or three high-risk verdicts in a
      row, trips the session's guard and says so.
    - Every decision goes to the decision log (`threadId` `session:<id>`, the tool's own
      name, the input with long strings cut) and leaves a line under the session's card
      in the rail (`state/trustLines.ts`), e.g. "duck: auto-approved `npm test`".
  - **Off until you've checked the replay.** Duck's setting "Answer sessions'
    permission prompts under the trust rules" (`answerSessionPrompts`) is off by
    default. Off, the watcher works as in shadow mode for every project: it decides,
    logs and leaves a "would allow…" line, and the prompt stays yours. Projects keep
    their own `off` / `shadow` / `live` on top of it.
  - **No toast for a prompt Duck answers.** `state/promptHold.ts` holds a fresh
    needs-you until the watcher has decided (at most 45 s).
    - The desktop toast and the phone push (`notifications.ts`) are told only if the
      prompt was left to you and the session is still waiting.
    - So are Duck's own session watches: `port.onPhase` reports such a needs-you once
      it's decided, and never one Duck answered.
    - A prompt left to you is told after the judge's 1–3 s, not at once.
  - **Mandates.**
    - `create_session` and `delegate_plugins_edit` store the user's latest message in
      the thread as the session's mandate. The tools get it as `ToolContext.request`.
    - It is kept in memory and in duck.db `meta` (`assistant_mandate:<instance>`), and
      dropped when Duck kills the session.
    - A session you started has its first prompt from the transcript as its mandate,
      plus your latest prompt there (`port.sessionContext`).
    - With neither, the prompt asks.
  - Port: `choiceOf`, `onChoices`, `holdNeedsYou`, `sessionContext`, `noteSession`;
    `ChoiceRef.optionsFrom`; `createSession` and `startPluginsDraft` take `mandate`.
    Engine: a public `notice(threadId, n)`.
  - Decisions view:
    - Make a rule offers `suggestRule`: a Bash command's first words
      (`Bash(npm test:*)`), a file tool's folder, or WebFetch's host.
    - New layer labels: judge, answered first.
    - Superseded rows count as nothing.
  - **The replay** (the done-when check), in the decisions view, under "replay the past
    week…":
    - `assistant_replay_calls` (`src-tauri/src/assistant/replay.rs`) streams the
      week's transcripts and returns each tool call with its outcome (ran, rejected
      by you, denied by a mode, error) and the prompts before it. Only an error that
      starts with Claude Code's own wording counts as a rejection.
    - `trust/replay.ts` runs every call through the layers, with the judge on every
      rejected call and an even sample of the rest (40 by default, about $0.02).
    - It reports the disagreements (rejected calls the policy would allow), calls you
      let run that a rule would refuse, and a sample of what would still ask.
    - A transcript can't say which calls prompted and were allowed, so that half
      shows how the policy would spread them, not agreement.
  - **The replay without the judge, on the past week** (12,177 calls: 11,255 in auto
    mode, 12 rejected by you):
    - The first run had 769 calls that ran asking at the floor, almost all false.
      Writes to Claude Code's scratchpad, memory and plan files, and
      `curl … | python -c` (inline code reading the download as data), now pass.
    - 225 asks are left, by design: pushes, `--force`, branch deletes, `cmdkey`, and
      sessions reading `~/.claude` transcripts and settings.
    - Of the 12 rejected calls, one asks at the floor and the rest go to the judge.
      Most are T0's deliberate test refusals (`mkdir t5-dir3`, `python -c
      "print(6*7)"`), which the judge may well allow: refusals made on purpose.
  - **Verified:**
    - 26 new vitest cases: 14 for `session.ts`, the judge and `suggestRule`, and 12 for
      the watcher end to end over the fake port; `create_session`'s mandate and the new
      floor examples are checked in existing cases. 347 passing.
    - 4 new Rust tests (212 passing, plus the ignored by-hand dump).
    - tsc, eslint and clippy are clean.
  - **Not verified live:**
    - The judge on real calls (it needs the app's proxy). Run the replay with the judge
      from the decisions view, then turn on the setting.
    - A session that runs tests and edits for 30 minutes without needing you.
    - That a toast doesn't fire for an auto-approved prompt.

#### Step T3 — Learning loop: promote rules, questions and plans

- **Goal:** Fewer prompts over time, and the Assistant handles questions and plans when you
  delegate them.
- **Depends on:** T2.
- **Build:**
  - **Promotion:** when the same pattern is approved (by you or by the policy) N times
    (default 3) in a project, offer:
    - "Add `Bash(npm test:*)` to this project's Claude Code allow list" (writes
      `.claude/settings.local.json` `permissions.allow` through the existing `fs` commands,
      with a diff preview), or
    - "Make it an Assistant rule".
  - **Questions:** for a session with a mandate and a "delegated" flag, Sonnet answers an
    `AskUserQuestion` through `choose` (`remoteActions.ts`) and posts what it picked and why.
    Otherwise the question is forwarded with a suggested answer.
  - **Plans:** a Sonnet review against the mandate (`x-wb-purpose: plan-review`). The policy
    setting chooses between "approve if the review passes" and "show me the plan with the
    review".
  - **Daily digest** (optional): auto-approved count, rules suggested, anything the rate
    guard caught.
- **Done when:**
  - Promoting a rule removes that prompt from future runs (Claude Code doesn't ask any more).
  - A delegated session's question is answered with a logged rationale.
  - A plan review shows up beside the plan card.
- **Out of scope:** editing Claude Code's global (user-level) settings; promotion is
  per-project only.

#### Step T4 — Permission answers through the `PermissionRequest` hook

- **Goal:** T2 answers Claude Code's permission prompts as data, not keystrokes, so an
  approval can't miss its menu, land in the wrong dialog, or race your own typing.
- **Depends on:** T2.
- **Build:**
  - **Check first** (the CLI on the installed version, before any code): whether a
    `PermissionRequest` hook can return a decision (`allow` / `deny`, with a message)
    that Claude Code acts on without showing its menu, how long it waits for the hook,
    and what it does when the hook gives no decision. Workbench already installs the
    hook and receives the event (`hooks/install.rs`); today it only observes it.
  - **Hold the response:** the hook server keeps the HTTP response for that event open
    while the trust watcher decides (rules, then the judge: a few seconds), and answers
    with the decision. No decision in time (the judge is slow, Duck is off, the policy
    leaves it to you) answers "no decision", so the menu shows as now.
  - `answerChoice` keystrokes stay for questions and plans, and as the fallback when
    the hook can't decide.
  - The decision log gains how each prompt was answered (`hook` or `keys`).
- **Key files:** `src-tauri/src/hooks/`, `src/assistant/trust/watcher.ts`.
- **Done when:** an allowed prompt never shows its menu in the terminal, a denied one
  reaches Claude Code with its reason, one left to you shows its menu as before, and a
  week's decisions show no keystroke answers for permission prompts.
- **Out of scope:** questions (`AskUserQuestion`) and plan approvals.

---

## Sequencing

```
X0 ─┬─▶ A1 ─▶ A2 ─┬─▶ A3 ─┬─▶ W2 ─┬─▶ T1 ─▶ T2 (needs M1) ─▶ T3
    │             │       │       ├─▶ D1 (needs M1) ─▶ D2 (needs W3, T2) ─▶ D3 (needs S1, V4)
    │             │       │       ├─▶ M2 ─┬─▶ B1
    │             │       │       │       └─▶ B2 (after D1, only if needed)
    │             └─▶ W1 ─┴───────┤
    │                     └─▶ W3 ─┤
    │                             ├─▶ W4
    │                             └─▶ R1 ─▶ R2 (needs V1) ─▶ R3 (needs V4) ─▶ R4 (gate: real phone use)
    ├─▶ M1 ─▶ M4 (permission mode at launch)
    └─▶ V1 (after A3) ─▶ V2 (after X0's listening test) ─┬─▶ V3 (needs W3)
                                                          └─▶ V4
    M2 + W4 ─▶ S1 ─▶ S2 ;  M2 + D2 ─▶ M3
    W4 + D1 ─▶ L1 ─▶ L2 ;  D2 + S2 + L1 + T1 ─▶ L3 ;  L1 + D2 + S2 ─▶ L4
    V2 + V4 + D1 ─▶ V5 ;  W2 + W3 + T2 + D2 ─▶ P1 (V5 for spoken stops) ─▶ P2
    W2 + K1 (improvement plan; merged 2026-10-19) ─▶ W5
```

**Suggested order:**
1. X0, A1, A2, A3, A4, W1, M1, W2, T1, W5, T2, M4, D1 (done). *First
   milestone: text control of the app that acts without asking about the small things,
   with heavy work offloaded to sessions.* (Reordered 2026-10-19: trust moved ahead of
   D1, because a card for every action defeats the point of Duck. W5 moved ahead of T2
   once K1 merged: its plugin runs are Duck's own consequential tools, so T1's rules
   already cover them per action, while T2 is the larger step.)
2. W3 (done), W6, T4, **D2**, D4, **P1**. *Autopilot milestone: sessions, Duck's workers
   included, keep going while you're away, and plans run step by step.* (W6, T4 and D4
   added 2026-10-20: Duck's control of sessions without guessing from the screen. W6 is
   small and comes first; T4 starts with a CLI check and is dropped if the hook can't
   decide; D4 follows D2, when the workers' reliability matters most.)
3. V1, V2, R1, R2, V3, **V5**, **P2**. *Voice + phone milestone, including read-aloud,
   screenshots, proactive spoken updates, and unattended autopilot runs.*
4. M2, **M3**, W4, L1, S1, V4. *Conversation milestone: chat and rubber duck, hands-free, with
   long-term memory.*
5. L2, S2, **L3** (self-development: from here Duck can help build the rest), **L4**, R3, then B1,
   T3, D3; B2 only if quick browser actions turn out to need it; **R4** once
   R3 shows you really use Duck from the phone.

T2 goes live after the replay check in its done-when (the past week's prompts through
`decide`), not after days in shadow mode. Shadow stays available per project.

---

## Research notes (2026-10-18)

- **STT options compared:**
  - Parakeet TDT 0.6B v3 int8 (best accuracy per CPU unit, ~650 MB) vs Moonshine v2 (tiny,
    single-language models).
  - whisper.cpp (small is several seconds on CPU; turbo only on a GPU; some Windows Vulkan
    overlay layers crash it).
  - faster-whisper (needs Python: rejected) and Voxtral / Kyutai (too heavy for CPU).
  - Crates: `transcribe-rs` 0.3.x (Handy), `sherpa-onnx` 1.13.x (ASR + VAD + KWS + TTS in one),
    `whisper-rs` 0.16.
  - Wake words: Porcupine needs an online AccessKey; the sherpa-onnx KWS is the in-process
    choice if ever wanted.
- **STT on the GPU:** `transcribe-rs` has `ort-cuda` / `ort-directml` features; `whisper-rs`
  has `cuda` / `vulkan`. DirectML is reportedly in maintenance in favour of Windows ML (not
  verified), so CUDA is the primary path on the RTX 4060.
- **TTS (EN+RU) compared:**
  - Kokoro-82M: Apache, top open English model, **no Russian** (a Habr test got
    gibberish). Runs in Rust through `sherpa-onnx` / `ort`.
  - Silero `v5_6_ru`: neural auto-stress and intonation, about 91% homograph stress accuracy;
    **CC BY-NC**; PyTorch only, so a sidecar.
  - `kokoro-ru`: a community retrain with the Kokoro ONNX layout, OpenRAIL. Young, with
    ж/ш/х artifacts; good stress needs RUAccent (Python).
  - Qwen3-TTS 0.6B: Apache, 10 languages including RU, streams. Russian stress quality
    unverified; Rust ports experimental; ~2–3 GB VRAM (est.).
  - Piper `ru_RU`: tiny, espeak stress, noticeably robotic.
  - Skipped for Russian:
    - Chatterbox Multilingual: no Russian stress model per NVIDIA's own card.
    - XTTS-v2: non-commercial, and the company is defunct.
    - Fish/OpenAudio: CC-BY-NC-SA.
    - ESpeech / F5: needs reference audio; base checkpoint NC.
    - Orpheus, Kyutai, CSM, Zonos and similar: no usable Russian.
- **Windows Natural voices:** there is **no Russian natural voice** for Narrator, and the SAPI
  adapter is a self-described hack. edge-tts is natural and free, but uses an undocumented
  endpoint (ToS risk): fine for X0's listening test, not as a foundation.
- **Cloud TTS** at ≈ 0.9M chars a month:
  - Google Chirp 3 HD: $0 (1M free, then $30 per 1M).
  - Azure Neural: ~$6 (0.5M free; multilingual voices).
  - Yandex SpeechKit: ~$8 (best Russian prosody, weak English).
  - OpenAI gpt-4o-mini-tts: ~$15.
  - ElevenLabs: ~$45 or more.
- **End-of-turn detection:**
  - Pipecat **Smart Turn v3.x**: audio-based; BSD-2; ~8 MB ONNX; 23 languages including
    Russian; ~12 ms on a modern CPU (Daily's figure; third-party runs 36–83 ms). No published
    Russian accuracy, hence X0's own recordings.
  - LiveKit's turn detector: text-based, a Qwen2.5-0.5B fine-tune, ~400 MB RAM, Russian
    supported, under the custom "LiveKit Model License". Kept as an alternative if
    audio-only detection misfires.
  - Silero VAD for speech start and stop.
- **Cloud STT fallback** if ever needed: Groq whisper-large-v3-turbo at $0.04 per audio hour.
  The Claude API has no audio input.
- **MCP:**
  - The Messages API MCP connector reaches only public URL servers, not local stdio, hence
    the local `rmcp` host.
  - The Agent SDK spawns a Claude Code process per session and carries a coding-agent system
    prompt; wrong shape for a light assistant, and the guardrails rule it out for agents.
- **No official Rust SDK.** The official TS SDK in the webview through the proxy gets typed,
  maintained API coverage without hand-written Rust types.
- **Firefox MCP bridge:**
  - An add-on plus a local MCP server on port 8765 and up. One server per client, and the
    add-on connects to all of them.
  - It works in your everyday profile (no `navigator.webdriver`).
  - Clicks are synthetic events, and some sites ignore them.
  - It needs `uv` / Python 3.10+.
- **Discord (dropped 2026-10-18):** a bot can only see DMs to itself and servers it has
  joined, and automating your own account is against the ToS. Not worth it next to the
  phone remote.
- **Unverified (X0 must confirm):**
  - STT VRAM and latency on the RTX 4060, the dGPU wake cost, and mixed-language accuracy.
  - TTS naturalness (only a listening test settles it), Qwen3-TTS Russian stress, and local
    first-audio latency.
  - The `web_search` / `web_fetch` type-string versions and Haiku support.
  - WebView2 hidden-window throttling.
  - Claude Code's permission modes and the exact `PermissionRequest` payloads.

---

## Open questions

| # | Question | Resolved in |
|---|---|---|
| 1 | ~~Languages?~~ **English and Russian** (decided 2026-10-18). Mixed-language utterances are the key test. | ✔ |
| 2 | ~~GPU?~~ **RTX 4060 Laptop, 8 GB; use it for voice** (decided 2026-10-18), on AC power by default. | ✔ |
| 3 | ~~Haiku or Sonnet as the main model?~~ **Sonnet; Haiku for summaries and other primitives** (2026-10-18). About $60 a month at moderate use; the soft limit degrades to Haiku on heavy months. Still open: the measured per-turn cost. | X0 |
| 4 | Do the consoles here bill to the subscription (so Opus sessions cost no API credits)? | X0 |
| 5 | ~~Budget defaults?~~ **Soft limit 80%, hard cap $90** (agreed 2026-10-18). | ✔ |
| 6 | ~~May the Assistant answer prompts?~~ **Yes, most of them, under the trust policy** (track T; decided 2026-10-18). The starter rules are in T1; they're tuned with the replay in T2. | T2 |
| 7 | Is the phone mic over Funnel/HTTPS acceptable, or do we also want Tailscale Serve HTTPS on the tailnet name? | R2 |
| 8 | ~~Discord?~~ **Dropped** (2026-10-18). | ✔ |
| 9 | Hotkeys: Ctrl+Space (drawer), Ctrl+Alt+Space (push-to-talk) and a trust-pause key: free of conflicts? | A3 / V1 / T1 |
| 10 | ~~Which TTS?~~ **Local: Kokoro `af_heart` (EN) + Silero `kseniya` (RU)**, chosen in the X0 listening test (2026-10-19). Chirp stays optional. | ✔ |
| 11 | ~~Firefox profile?~~ **Agent profile by default; personal profile on an explicit, reasoned request** (2026-10-18). | ✔ |
| 12 | ~~Paid TTS overage?~~ **Moot: local engines by default** (2026-10-19). Chirp is optional and never pays silently. | ✔ |
| 13 | ~~OCR language packs?~~ **Installed: `en-US`, `ru`** (checked 2026-10-18). | ✔ |
| 14 | ~~Phone voice?~~ **Desktop-synthesized (the same Kokoro/Silero voice everywhere)**; the phone's native TTS stays the offline fallback (2026-10-19). | ✔ |
| 15 | ~~Speakers or headphones?~~ **Both: talk-over must work on speakers too** (2026-10-18). **AEC3 with the playback reference** (X0, 2026-10-19: ~30 dB on the laptop speakers, no false barge-ins, interruptions caught in ~0.29 s; headphones need no AEC). Windows' communications processing isn't needed. | ✔ |
| 16 | ~~Name?~~ **D.U.C.K.**, "Duck" (2026-10-18). "Duck" is a common word, so a future wake word would be the phrase "Hey Duck" / «Эй, Дак», not the bare name. | ✔ |
| 17 | ~~Workspace?~~ **`C:\Users\mrsha\repos\Duck`** (created 2026-10-18); debug build uses `Duck.dev`. Still open: clean up old task folders after N days, or keep them (default: keep; the folder can be a git repo). | D1 |
| 18 | ~~Thresholds?~~ **5-hour < 70%, weekly < 80%; over them, run automatically on the API** (2026-10-18). | ✔ |
| 19 | ~~Worker model?~~ **Tiers: standard = Sonnet `medium`, involved = Sonnet `high`, serious = Opus `medium`**, chosen by Duck per task (2026-10-18). | ✔ |
| 20 | ~~Separate Duck from Workbench now?~~ **No: separable, not separate.** A `WorkbenchPort` boundary, the Duck Protocol for all surfaces, its own `duck.db` (2026-10-18). | ✔ |
| 21 | ~~Tailscale or public for the phone app?~~ **Public (Funnel) by default; Tailscale used automatically when it's on**, plus device-bound keys (2026-10-18). Device: **Nothing Phone (2a), Nothing OS 4.1, Android 16**. | ✔ |
| 22 | Glyph lights for Duck's state on the Phone (2a): worth the Nothing GDK API-key registration? | R4 |
| 23 | ~~Private GitHub repo for Duck's data?~~ **Yes** (2026-10-18). All Duck git work runs in the background: a mechanical lane for commits and pushes, Sonnet `medium` worker sessions for anything needing judgment. | ✔ |
| 24 | ~~Housekeeping cadence?~~ **Weekly on Sunday; if missed, on the next Duck start** (2026-10-18). Retention default: keep results, prune bulky intermediates after 30 days. | ✔ |
| 25 | ~~Autopilot defaults?~~ **Compact only after a finished step, judged per step (usually yes); never mid-job. Continue with "continue the implementation" / "proceed to the next step", or a situational prompt** (2026-10-18). Max steps per run: default 5, adjustable. | ✔ |
| 26 | ~~Quiet hours?~~ **All etiquette is configurable; quiet hours optional and off by default; manual DND (with durations and a voice command) is the main control; a master Speak toggle gates all voice output** (2026-10-18). | ✔ |

---

## Progress tracker

| Step | Title | Status |
|---|---|---|
| X0 | Spike: check the assumptions | ☑ (the phone echo run waits for R2) |
| A1 | API key in the keychain + loopback proxy + usage ledger | ☑ |
| A2 | Assistant engine: loop, tool registry, threads | ☑ |
| A3 | The Assistant drawer (desktop UI) | ☑ |
| A4 | Deleting threads | ☑ |
| W1 | Read tools | ☑ |
| W2 | Action tools + the confirmation policy | ☑ |
| W3 | Session summaries | ☑ |
| W4 | Core memory (the always-loaded profile) | ☐ |
| W5 | Project toolbar tools | ☑ |
| W6 | Screen and keys: Duck's hands on the terminal | ☐ |
| M1 | Model per Claude Code session | ☑ |
| M2 | Effort routing, Haiku workers, budget-aware degrade | ☐ |
| M3 | Subscription brain: headless Claude Code as the fallback main thread | ☐ |
| M4 | Permission mode at launch | ☑ |
| D1 | Worker sessions: workspace, brief, result contract | ☑ |
| D2 | Offload routing, subscription-limit awareness, Duck as the worker's user | ☐ |
| D3 | Session-backed thinking modes (experiment) | ☐ |
| D4 | Headless workers over stream-json | ☐ |
| B1 | Web search and fetch | ☐ |
| B2 | MCP host + your Firefox | ☐ |
| V1 | Push-to-talk with local STT on the GPU (desktop) | ☐ |
| V2 | Natural spoken replies | ☐ |
| V3 | Read-aloud and screen reading | ☐ |
| V4 | Hands-free conversation mode | ☐ |
| V5 | Proactive announcements | ☐ |
| L1 | Long-term memory: files, index, recall | ☐ |
| L2 | Consolidation, journal, and recall quality | ☐ |
| L3 | Self-development through Opus sessions | ☐ |
| L4 | Routines, backup and housekeeping | ☐ |
| S1 | Modes: chat and rubber duck | ☐ |
| S2 | Skills and user-defined modes | ☐ |
| R1 | Assistant endpoints on the remote server | ☐ |
| R2 | PWA Assistant tab with mic | ☐ |
| R3 | The PWA as an app: shortcuts, share target, Duck start view | ☐ |
| R4 | Android companion app (gate: R3 sees real use) | ☐ |
| T1 | Trust engine for the Assistant's own actions | ☑ |
| T2 | Auto-answering Claude Code permission prompts | ☑ |
| T3 | Learning loop: promote rules, questions and plans | ☐ |
| T4 | Permission answers through the `PermissionRequest` hook | ☐ |
| P1 | Autopilot loop for one session | ☐ |
| P2 | Unattended runs: limits, windows, stalls, checklists, several sessions | ☐ |
