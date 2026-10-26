# The Office — Development Plan

A side feature of Workbench: a **2D pixel-art office** that shows your Claude Code sessions as
workers at desks. It's a dashboard you can glance at and click — who is working, who needs
you, what Duck is up to — wrapped in a small living simulation: idle workers drink coffee, play
kicker, chat at the water cooler, and you can sit down at the TV and play.

Steps follow the main plan's format (`claude-code-workbench-development-plan.md`): one step per
Claude Code pass, each with **Depends on**, **Build**, **Key files**, **Done when**. The main
plan's Definition of Done applies to every step here too.

The order is deliberate: **foundation → visual design → MVP → life → Duck & tasks → chatter →
games.** Phase OD (design) is a sign-off gate: no gameplay code builds on art that hasn't been
approved.

---

## Settled decisions

1. **Runs as its own page, in the browser by default.** A new Vite entry (`src/office/`), built
   like the phone page and served by Workbench's Rust core on **loopback only**. Workbench's
   "Open Office" opens it in the default browser (a Tauri window is an optional setting). Its
   own process, never competing with the terminals; **closing the tab stops it**.
2. **State and actions come from what already exists.** The office reads the same
   `RemoteSnapshot` the phone gets (`src/remote/protocol.ts`) and sends the same actions
   (`prompt`, `choose`, `create`, `interrupt`, `stop`). Workbench's webview stays the single
   owner of status and of acting on sessions (see `src-tauri/src/remote/mod.rs`, "two
   deliberate boundaries"). The office never parses terminals, never writes to a PTY.
3. **Twelve workers, three teams.** Demiurge 4, TinyWizardRoyale 2, open space 6. Teams lend
   workers when they run out (rules in "Assignment" below).
4. **All art is generated in code**, from hand-authored pixel templates plus per-worker
   recolouring and layering. We fall back to buying an asset pack only if this clearly can't
   reach "good-looking".
5. **Chatter runs on Haiku**, through Duck's existing API client, budgeted, and only while the
   office is visible. Upgradeable to Sonnet by a setting.
6. **Plain Canvas 2D, no game engine.** Native resolution 640×384 (40×24 tiles of 16 px),
   integer-scaled with nearest-neighbour. Characters are 16×32.
7. **Performance budget** (measured in O0.4, re-checked in O6): idle office **< 1 % CPU**,
   busy office **< 3 % CPU**, page process **< 150 MB RAM** on this machine. The emulator
   and minigames are excluded while they're open — they only run while you play.

## Architecture

```
Workbench webview ──snapshot──▶ Rust core ──▶ office listener (127.0.0.1, on demand)
  (status.ts, Duck,              (remote/)        │  GET  /office/            page
   actions, Haiku calls)  ◀──action / chatter──── │  GET  /office/api/state   snapshot
                                                  │  WS   /office/api/ws      live snapshot
                                                  │  POST /office/api/action  same actions as phone
                                                  │  GET  /office/api/transcript
                                                  │  POST /office/api/chatter Haiku scene
                                                  ▼
                                   Browser tab: src/office/
                                     sim (10 Hz) ─▶ render (≤30 fps, skips static frames)
```

- **Auth:** Workbench mints a one-time launch token and opens
  `http://127.0.0.1:<port>/office/#t=<token>`; the page trades it for a session kept in memory.
  Every `/office/api/*` call carries it. The listener also checks the `Host` header (blocks DNS
  rebinding — any web page can reach loopback). It's independent of the phone's remote-access
  switch; it's on while Workbench runs, after the first "Open Office".
- **Snapshot additions** the office needs: per-instance `activity` (kind of the latest tool:
  `edit | bash | test | web | read | task | other`), Duck's state (`idle | thinking | speaking |
  routine`, autopilot target), per-project `lastCommitAt`. These are additive fields; the phone
  ignores them.

## Assignment

- A session gets a worker while its console is live (`live === true`).
- **Room** comes from the project: Demiurge and TinyWizardRoyale map to their rooms (by
  project id, set in office settings — not by name matching); everything else is open space.
- **Sticky:** the instance → worker map is saved; a returning instance gets the same worker
  if they're free. New instances get a random free worker from the room's team.
- **Borrowing:** when the team is all busy, take an idle worker — from open space first, then
  from the other main team. The borrowed worker walks over to a **spare desk** in that room
  (Demiurge has 6 desks, TWR 4, open space 8). A borrowed worker returns home when released.
- **Beyond 12 live sessions** (not expected): the extra session shows as an empty desk with an
  open laptop and a "remote contractor" tag — still hoverable and clickable.
- Released (session ended): the worker packs up, walks to the kitchen and goes idle.

## Status → behaviour

| Signal | Worker | Over the head |
|---|---|---|
| `working` + edit | typing, monitor glows | status icon |
| `working` + bash / test | at the whiteboard / server rack, fidgeting | status icon |
| `working` + web / read | reading a newspaper / a document | status icon |
| `subagents > 0` | an **intern** per subagent beside the desk | — |
| `compacting` | shuffling papers into the filing cabinet | — |
| `needs_you` | stands, waves | **`!`** bubble (**`?`** when it's a question with options) |
| `escalated` | sweating, bubble pulses red | `!` red |
| `stuck` | slumped on the keyboard | `…` |
| `done` | leans back with a coffee; after ~10 min wanders off (comes back on the next turn) | ✓ |
| ended | walks out | — |

Name tags show the worker name + a status glyph (same glyphs as the rail).

## Worker roster (approved in OD.2; `src/office/roster.ts`)

| Team | Workers |
|---|---|
| Demiurge | Felix, Bram, Kenji, Theo |
| TinyWizardRoyale | Pip, Juno |
| Open space | Mira, Oksana, Ada, Lola, Gus, Rhea |

Each gets a look (generated), a one-line personality (feeds idle preferences and chatter), and
favourite spots.

## Floor plan (to be designed in OD.5)

- **Duck's glass office** — boss desk, the huge rubber duck.
- **Demiurge room** — 6 desks, a whiteboard.
- **TinyWizardRoyale room** — 4 desks, a whiteboard.
- **Open space** — 8 desks.
- **Kitchen & water cooler** — coffee machine, fridge, table.
- **Lounge** — sofa, TV with a console, beanbags.
- **Kicker table**, **meeting table** (standup), **D&D corner**, entrance door, a server rack,
  plants, a wall clock showing real time.

---

## Phase O0 — Foundation

### Step O0.1 — Office page scaffold
- **Goal:** A blank office page with the render loop and a performance overlay.
- **Depends on:** —
- **Build:** New Vite entry `src/office/` with its own config (mirror `vite.pwa.config.js`).
  Canvas at 640×384, integer-scaled to fit the window, nearest-neighbour, sidebar on the right.
  Fixed-step simulation at 10 Hz; render on `requestAnimationFrame` capped at 30 fps and
  skipped when nothing changed; everything stops when the page is hidden. HUD: fps, frame ms,
  JS heap (where available). Draw a placeholder grid.
- **Key files:** `src/office/main.ts`, `src/office/loop.ts`, `src/office/hud.ts`,
  `vite.office.config.js`, `package.json` scripts.
- **Done when:** `vite` serves the page; grid renders crisply at any window size; HUD shows
  ~0 work when static; switching tabs stops the loop.

### Step O0.2 — Serving, auth and "Open Office"
- **Depends on:** O0.1.
- **Build:** Loopback listener for `/office/*` in the Rust core, started on the first "Open
  Office" and kept while the app runs. One-time launch token → in-memory session; `Host`
  check. Routes for state, WS, action, transcript reuse the remote server's handlers. "Open
  Office" in the command palette and the app menu opens the default browser (setting: or a
  Tauri window). The page shows the live instance list as plain text.
- **Key files:** `src-tauri/src/remote/office.rs` (or `src-tauri/src/office/`),
  `src-tauri/src/remote/server.rs`, `src/panels/CommandPalette.tsx`, `src/office/net.ts`.
- **Done when:** the page in Firefox/Chrome shows instances updating live; a request without
  the session, or with a foreign `Host`, is refused; works with phone remote access off.

### Step O0.3 — Snapshot additions
- **Depends on:** O0.2.
- **Build:** Add `activity`, Duck state and `lastCommitAt` to the snapshot (see Architecture).
  The tool → activity mapping is a pure function in `src/state/` with tests.
- **Key files:** `src/remote/protocol.ts`, `src/state/status.ts` (or a sibling module),
  the snapshot builder, tests.
- **Done when:** tests cover the mapping; the office's text list shows activity and Duck state.

### Step O0.4 — Measuring the cost
- **Depends on:** O0.1.
- **Build:** A Rust command reporting CPU % and RAM of Workbench's process tree (`sysinfo`
  crate), shown in the HUD and later the sidebar stats. A short "how to measure" note (Chrome /
  Firefox task manager for the tab, the HUD for Workbench).
- **Done when:** baseline numbers recorded in this document under "Measurements".

## Phase OD — Visual design (sign-off gate)

### Step OD.1 — Pixel format and palette
- **Build:** A text pixel format (rows of palette characters in TS files) compiled at runtime
  into one atlas canvas; recolour maps; a ~32-colour palette; a preview page listing every
  sprite at 1×/3×.
- **Key files:** `src/office/art/pixels.ts`, `src/office/art/palette.ts`,
  `src/office/preview.html`.
- **Done when:** atlas builds in < 50 ms; preview page works; tests for parsing and recolouring.

### Step OD.2 — Characters (may need 2 passes)
- **Build:** 16×32 base body; layers: skin tones, 6+ hair styles, 6+ tops, trousers,
  accessories (glasses, headphones, beard, hat). Animations: idle, walk in 4 directions, sit &
  type, sit relaxed, stand & wave, drink, sleep, cheer, facepalm. Interns as a smaller variant.
  The 12-worker roster with names, looks, personalities.
- **Key files:** `src/office/art/characters.ts`, `src/office/roster.ts`.
- **Done when:** the preview shows all 12 workers in every animation, and the user approves.

### Step OD.3 — Furniture and tiles (may need 2 passes)
- **Build:** floors per room, walls, windows, glass walls, door; desks with monitors (off / on /
  glowing), chairs, plants, whiteboards, filing cabinet, server rack; kitchen set; lounge set
  (sofa, TV, console, beanbags); kicker table; meeting table; D&D table; wall clock.
- **Done when:** every prop in the preview; user approves.

### Step OD.4 — Duck the boss
- **Build:** the huge rubber duck (~48×48) and the boss desk; animations: idle bob, thinking,
  speaking, waddle (walking).
- **Done when:** user approves.

### Step OD.5 — Floor plan
- **Build:** the office map as an ASCII layout file + prop placements → tile layers, a
  walkability grid, and named points (desk seats per room, chat spots, prop slots, door).
  Static render of the full office with all 12 workers seated.
- **Key files:** `src/office/map/office.ts`, `src/office/map/build.ts`.
- **Done when:** the static office renders in the page; published for review; user approves.

## Phase O1 — MVP: sessions in the office

### Step O1.1 — Entities and rendering
- **Depends on:** OD.*.
- **Build:** worker/intern/Duck entities, an animation player, depth sorting by y, name tags,
  status glyphs, speech bubbles.
- **Done when:** workers render at their home desks with animations playing.

### Step O1.2 — Movement
- **Build:** A* on the walkability grid, walking with direction, simple waiting when blocked,
  entering/leaving through the door. Pure pathfinding module with tests.
- **Done when:** a debug click sends a worker anywhere reachable without clipping furniture.

### Step O1.3 — Assignment engine
- **Depends on:** O0.3, O1.2.
- **Build:** the rules in "Assignment" as a pure module (snapshot in → assignments out) with
  tests (stickiness, borrowing order, release, > 12 sessions). The sticky map and the room
  mapping are saved through Workbench (an `/office/api/prefs` route backed by the app DB),
  not in browser storage. Workers walk to their desks when assigned.
- **Done when:** tests pass; starting/stopping sessions in Workbench moves the right workers.

### Step O1.4 — Status → behaviour
- **Build:** the table in "Status → behaviour", including interns for subagents and `!`/`?`
  bubbles.
- **Done when:** each state is visible when driven from a real session (and from a fake
  snapshot fixture for the rare ones).

### Step O1.5 — Hover and the sidebar
- **Build:** hover tooltip (worker, project, session title, phase, activity, for how long).
  Clicking a worker opens the sidebar: header, the pending choice (choice card → `choose`),
  transcript tail, prompt box, interrupt / stop. Esc closes it.
- **Done when:** you can answer a permission prompt and send a prompt from the office.

### Step O1.6 — Stats when nothing is selected
- **Build:** sessions by phase, usage limits, context sizes, sessions and commits today,
  CPU/RAM from O0.4, a short activity log (worker events in plain words).
- **Done when:** the sidebar shows them updating live.

## Phase O2 — Office life

### Step O2.1 — Idle planner
- **Build:** activities with locations, slots, durations and weights by personality (coffee,
  water cooler, sofa, bookshelf, window, plants, a walk); slot reservation so nobody stacks.
  Time of day: arrive in the morning, lunch in the kitchen, leave in the evening; at night only
  assigned workers stay.
- **Done when:** idle workers look busy for 10 minutes without anyone getting stuck or
  overlapping.

### Step O2.2 — Group activities
- **Build:** water-cooler chats (canned lines for now), kicker matches (moving ball, score),
  console sessions on the sofa.
- **Done when:** each happens on its own during a normal session.

### Step O2.3 — Reactions
- **Build:** a commit → the worker cheers; escalation → sweating; session end → walks out;
  Duck's autopilot acting on a session → Duck waddles over.
- **Done when:** each is visible when triggered for real.

### Step O2.4 — Ambience
- **Build:** daylight tint through the day and lamps at night, monitor glow, clock with real
  time, a "coffee budget" whiteboard showing the usage limits.
- **Done when:** the office looks right at noon and at midnight; CPU still within budget.

## Phase O3 — Duck and running the office

### Step O3.1 — Duck in the boss office
- **Build:** Duck's state animations; clicking Duck opens a Duck chat in the sidebar (reuse
  the phone's Duck client where it fits, `src/pwa/duck*.ts`).
- **Done when:** you can talk to Duck from the office and see it think and answer.

### Step O3.2 — Giving tasks
- **Build:** drag an idle worker onto a desk (or click an empty desk): a small form (project,
  prompt, worktree, model) → `create` action. The worker walks to the desk and is bound when
  the instance appears (matched by `requestId`).
- **Done when:** a session started from the office runs in Workbench with that worker on it.

### Step O3.3 — Answering from the bubbles
- **Build:** clicking a `!`/`?` bubble opens the choice card right there.
- **Done when:** a prompt is answered with two clicks without opening the sidebar.

## Phase O4 — Chatter

### Step O4.1 — Chatter service
- **Build:** `/office/api/chatter` → the webview → Duck's API client, Haiku, structured JSON
  output (a scene: speakers, lines, an optional mood). Context: personas of the workers
  involved, recent commits and session titles per project, time of day; a slice of random
  topics. Cached system prompt; budget (calls/hour, tokens/day) in settings; only while the
  office is visible; canned lines when off or over budget.
- **Done when:** scenes come back valid; the budget holds; turning it off costs nothing.

### Step O4.2 — Playing scenes
- **Build:** when 2–3 idle workers meet at a chat spot, play a scene: they face each other,
  bubbles in turn, the lines go to the activity log.
- **Done when:** an hour with the office open has believable conversations within budget.

## Phase O5 — Games

### Step O5.1 — Game overlay
- **Build:** clicking a prop opens a game overlay over the dimmed office; keyboard and gamepad
  input (Gamepad API); the office render pauses while it's open.
- **Done when:** a dummy game opens from the TV and the kicker and closes cleanly.

### Step O5.2 — Kicker
- **Build:** a small top-down foosball game against the computer.

### Step O5.3 — TV: retro console emulator (may need 2 passes)
- **Build:** NES/SNES/Game Boy/GBA/Mega Drive through Nostalgist.js (libretro cores compiled to
  WebAssembly), cores **bundled locally** and loaded only when you start playing. ROMs come
  from a folder you choose in settings (served by the office listener); no ROMs ship with
  Workbench. Save states, gamepad, fullscreen. While you play, idle workers gather on the sofa,
  and the TV sprite shows the actual game picture.
- **Done when:** a homebrew ROM plays at full speed with a gamepad; closing it frees the core.

### Step O5.4 — Whiteboard Pictionary with Duck
- **Build:** you draw, Duck guesses — or Duck draws (its drawing tools) and you guess.

### Step O5.5 — Morning standup
- **Build:** on request, idle workers gather at the meeting table; each summarises yesterday's
  sessions of their project (Haiku over transcripts).

### Step O5.6 — D&D table (stretch, may need several passes)
- **Build:** an LLM dungeon master, idle workers as the party with their personas, a saved
  campaign, played in a side panel with dice.

## Phase O6 — Polish
- **O6.1** Settings page (room mapping, roster names, chatter budget and model, open in browser
  vs window, ROM folder).
- **O6.2** Performance pass against the budget; record final numbers under "Measurements".
- **O6.3** Docs: a short section in the README and an architecture note.

---

## Measurements

_Filled in by O0.4 and O6.2._

## Progress tracker

- [ ] O0.1 Office page scaffold
- [ ] O0.2 Serving, auth and "Open Office"
- [ ] O0.3 Snapshot additions
- [ ] O0.4 Measuring the cost
- [x] OD.1 Pixel format and palette
- [ ] OD.2 Characters (pass 1 done: cast, idle/walk/type/wave; pass 2: drink, sleep, cheer, facepalm, interns)
- [ ] OD.3 Furniture and tiles
- [ ] OD.4 Duck the boss
- [ ] OD.5 Floor plan
- [ ] O1.1 Entities and rendering
- [ ] O1.2 Movement
- [ ] O1.3 Assignment engine
- [ ] O1.4 Status → behaviour
- [ ] O1.5 Hover and the sidebar
- [ ] O1.6 Stats when nothing is selected
- [ ] O2.1 Idle planner
- [ ] O2.2 Group activities
- [ ] O2.3 Reactions
- [ ] O2.4 Ambience
- [ ] O3.1 Duck in the boss office
- [ ] O3.2 Giving tasks
- [ ] O3.3 Answering from the bubbles
- [ ] O4.1 Chatter service
- [ ] O4.2 Playing scenes
- [ ] O5.1 Game overlay
- [ ] O5.2 Kicker
- [ ] O5.3 TV: retro console emulator
- [ ] O5.4 Whiteboard Pictionary with Duck
- [ ] O5.5 Morning standup
- [ ] O5.6 D&D table
- [ ] O6.1 Settings
- [ ] O6.2 Performance pass
- [ ] O6.3 Docs
