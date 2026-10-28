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
6. **Plain Canvas 2D, no game engine.** Native resolution 512×352 (32×22 tiles of 16 px),
   integer-scaled with nearest-neighbour. Characters are 16×32.
7. **Workers sit with their backs to the camera** (decided in OD.3). The monitor faces
   you over their shoulder, so a room's state — code scrolling, a flashing red "needs
   you" screen, a dark one — reads at a glance. A worker who needs you stands and turns
   to wave.
8. **Performance budget** (measured in O0.4, re-checked in O6): idle office **< 1 % CPU**,
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
  from the other main team. Demiurge (4 desks) and TWR (2) have one desk per worker, so a
  borrowed worker takes one of the open space's 2 **spare desks** (8 in all), the nearest to
  the team's room. A borrowed worker returns home when released.
- **Beyond 12 live sessions** (not expected): the extra session shows as an empty desk with an
  open laptop and a "remote contractor" tag — still hoverable and clickable.
- Released (session ended): the worker packs up, walks to the kitchen and goes idle.

## Status → behaviour

| Signal | Worker | Over the head |
|---|---|---|
| `working` + edit | typing, monitor glows | — (the monitor shows it) |
| `working` + bash / test | at the server rack / whiteboard, fidgeting | status icon |
| `working` + web / read | reading a newspaper / a document | — |
| `subagents > 0` | typing faster; the count shows in the sidebar | — |
| `compacting` | shuffling papers into the filing cabinet | — |
| `needs_you` | stands beside the desk, waves; monitor flashes red | **`!`** bubble (**`?`** when it's a question with options) |
| `escalated` | sweating, bubble pulses red | `!` red |
| `stuck` | slumped on the keyboard | `…` |
| `done` | leans back with a coffee; after ~10 min wanders off (comes back on the next turn) | ✓ |
| ended | goes off to the kitchen or the lounge — nobody leaves the office | — |

Name tags show the worker name + a status glyph (same glyphs as the rail).

## Worker roster (approved in OD.2; `src/office/roster.ts`)

| Team | Workers |
|---|---|
| Demiurge | Felix, Bram, Kenji, Theo |
| TinyWizardRoyale | Pip, Juno |
| Open space | Mira, Oksana, Ada, Lola, Gus, Rhea |

Each gets a look (generated), a one-line personality (feeds idle preferences and chatter), and
favourite spots.

## Floor plan (approved in OD.5; `src/office/map/`)

512×352. Mostly open floor: floors and furniture mark the areas.

- **Along the back wall:** Demiurge (4 desks, whiteboard; a bookshelf and cabinet toward the
  open space, the server rack in the corner) · the hall with the front door and the clock ·
  Duck's glass office (boss desk under the window, the standup table in front of it) · the
  lounge down the right side (TV, sofa, beanbags, kicker, D&D table).
- **Below:** the open space (8 desks, 2 spare) · TinyWizardRoyale (2 desks) under Duck's
  office · under that the **meeting room** (a long table for 8 and a whiteboard on a stand)
  and the kitchen, as wide as the lounge (fridge, coffee, sink, water cooler).
- **Walls:** the outside wall, Duck's glass, and glass (like Duck's) with open doorways between the
  four rooms on the right (TinyWizardRoyale, lounge, meeting room, kitchen). Everything else
  is open floor.
- `office.ts` holds the tile layout, furniture, desks and named spots; `build.ts` makes the
  draw list, the seats (stand point, monitor) and an 8 px walk grid. Tests check that every
  desk and activity spot is reachable from the door.

---

## Phase O0 — Foundation

### Step O0.1 — Office page scaffold
- **Goal:** A blank office page with the render loop and a performance overlay.
- **Depends on:** —
- **Build:** New Vite entry `src/office/` with its own config (mirror `vite.pwa.config.js`).
  Canvas at 512×352, integer-scaled to fit the window, nearest-neighbour, sidebar on the right.
  Fixed-step simulation at 10 Hz; render on `requestAnimationFrame` capped at 30 fps and
  skipped when nothing changed; everything stops when the page is hidden. HUD: fps, frame ms,
  JS heap (where available). Draw a placeholder grid. _(Done: it draws the static office
  instead, with the walk grid on `G`; the build goes to `src-tauri/src/remote/office/dist/`
  as one page, for O0.2 to embed.)_
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
  _(Built: `src-tauri/src/remote/office.rs`, port 48950 (49050 in a debug build), any
  free port if that one is taken. The transcript socket is the phone's
  (`transcript::follow`). "Open Office" is the palette's "Open the office" and the
  status bar's "office" (there is no app menu); the Tauri-window setting waits until
  someone wants it.)_

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
  sprite at 1×/3×. _As built:_ no single atlas — each sprite becomes its own canvas the
  first time it's drawn and is kept (`src/office/canvas.ts`, `cached`), so the page only
  builds what it shows.
- **Key files:** `src/office/art/pixels.ts`, `src/office/art/palette.ts`,
  `src/office/preview.html`.
- **Done when:** atlas builds in < 50 ms; preview page works; tests for parsing and recolouring
  (`pixels.test.ts`). Measured: every sprite (1,235: all workers, props, floors, Duck) builds
  in ~28 ms (Node, warm; ~52 ms cold).

### Step OD.2 — Characters (may need 2 passes)
- **Build:** 16×32 base body; layers: skin tones, 6+ hair styles, 6+ tops, trousers,
  accessories (glasses, headphones, beard, hat). Animations: idle, walk in 4 directions, sit &
  type, sit relaxed, stand & wave, drink, sleep, cheer, facepalm. (Interns for subagents were
  drawn and dropped: not useful enough.)
  The 12-worker roster with names, looks, personalities. _As built (approved):_ frames
  are 16×26, not 32 (hair rises into 2 rows of headroom); 6 hair styles, 4 top styles
  (tee, collar, hoodie, stripes) told apart further by colour; glasses, beard, headphones
  and blush, no hat. The animations are idle, walk (4 directions), type, wave, drink,
  sleep, cheer and facepalm. "Sit relaxed" isn't drawn yet; `sleep`'s front view is the
  seated pose it will build on, and it's due with the sofa in O2.1.
- **Key files:** `src/office/art/characters.ts`, `src/office/roster.ts`.
- **Done when:** the preview shows all 12 workers in every animation, and the user approves.

### Step OD.3 — Furniture and tiles (may need 2 passes)
- **Build:** floors per room, walls, windows, glass walls, door; desks with monitors (off / on /
  glowing), chairs, plants, whiteboards, filing cabinet, server rack; kitchen set; lounge set
  (sofa, TV, console, beanbags); kicker table; meeting table; D&D table; wall clock.
- **Done when:** every prop in the preview; user approves.
- _As built (approved):_ 37 props and 7 floors (office, Demiurge, TinyWizard, boss,
  meeting, wood, kitchen), all in the preview, with the animated ones playing. Monitors are
  off / code / alert: the code and alert screens flash between 2 frames, and the red alert
  is the "needs you" screen. The glow a lit monitor casts on the room is lighting and is due
  in O2.4. The console isn't its own prop; it sits in the TV stand with a controller. The
  wall clock takes the time as an argument (`clockAt`), so O2.4 only has to pass in the
  real time. Added beyond the list: partitions, a wall-mounted and a standing whiteboard,
  bookshelf, bin, tall plant, water cooler, fridge, and the boss desk (OD.4).

### Step OD.4 — Duck the boss
- **Build:** the huge rubber duck (~48×48) and the boss desk; animations: idle bob, thinking,
  speaking, waddle (walking).
- **Done when:** user approves.
- _As built (approved):_ 48×48, in sunglasses and a red bow tie. Duck is generated from
  ellipses with the face stamped on top, not hand-drawn, so blinking, looking up and an
  open beak are pose parameters. The views are front, back, right, and left (the right view
  mirrored). In the sunglasses, "thinking" moves the lens glint upward. Waddle is a bob in
  place; the walking itself is done by moving Duck, as the preview does across the carpet.
  The preview never shows the back view; it's there for walking away in O1.2.

### Step OD.5 — Floor plan
- **Build:** the office map as an ASCII layout file + prop placements → tile layers, a
  walkability grid, and named points (desk seats per room, chat spots, prop slots, door).
  Static render of the full office with all 12 workers seated.
- **Key files:** `src/office/map/office.ts`, `src/office/map/build.ts`.
- **Done when:** the static office renders in the page; published for review; user approves.
- _As built (approved):_ 32×22 tiles of 16 px (512×352), laid out as described under "Floor
  plan". The ASCII layout is a string array in `office.ts` rather than a separate file; it
  marks only the back wall and each room's floor. Furniture is placed in pixels. Glass and
  dividers are built to length. Each placement can set `base` (its draw-order edge) and `foot`
  (how much floor it blocks). There are 14 desks: 4 Demiurge, 2 TinyWizardRoyale and 8 in the
  open space, 2 of them spare. Each seat gives the desk, the monitor, the seated sprite and a
  stand point. The named spots (kitchen, lounge, D&D, pitch, standup, browse, window) are the
  "chat spots" and "prop slots" the spec lists; O2.1 will reserve them. The door is at the
  hall and Duck sits behind the boss desk. `build.ts` makes the floor layer, the props sorted
  by y and an 8 px walk grid. Tests check the desk counts, that props stay on the canvas and
  are sorted, that every desk and spot can be reached from the door, and that no two spots
  overlap. `previewOffice.ts` draws the office for the page and the preview: all 12 workers at
  their home desks, Ada's screen on alert, and the walk grid and spots on `G`.

## Phase O1 — MVP: sessions in the office

### Step O1.1 — Entities and rendering
- **Depends on:** OD.*.
- **Build:** worker and Duck entities, an animation player, depth sorting by y, name tags,
  status glyphs, speech bubbles.
- **Done when:** workers render at their home desks with animations playing.
- _As built (approved):_ `src/office/world/`. `entities.ts` is plain data: a worker
  (feet position, facing, animation, seated, home desk, overhead icon, tag glyph, bubble)
  per roster entry and Duck, plus which screen each desk's monitor shows; `createWorld`
  seats everyone at their home desk, typing, with clips offset so neighbours don't move
  in step. `anim.ts` is the player: frame at a time and time to the next frame, looping
  or played once and held. `render.ts` draws the floors once, then furniture, monitors and
  people sorted together by their draw edge, then name tags, status icons and bubbles over
  everything, and returns when the picture next changes. Lettering is a 5 px pixel font
  (`art/font.ts`, capitals only, unknown characters as `?`), so text scales with the
  scene. Name tags (`art/labels.ts`) are a dark pill rimmed in the worker's shirt colour
  with the rail's glyph (◐ ● ○ · –) in the rail's colours, shown on hover or for everyone
  (`N` on the page, a toggle in the preview). Status icons are 7×7 badges (working, `!`,
  `?`, red `!`, `…`, ✓); bubbles wrap at 72 px and have a tail toward the speaker. Until
  O1.3 the page and preview show a fixed demo of these: Ada standing and waving with the
  `!` bubble and the alert screen, Felix's working icon, Pip done, Gus asleep and stuck,
  Theo and Duck speaking. Tests cover the font, the labels, the player and the world.

### Step O1.2 — Movement
- **Build:** A* on the walkability grid, walking with direction, simple waiting when blocked,
  entering/leaving through the door. Pure pathfinding module with tests.
- **Done when:** a debug click sends a worker anywhere reachable without clipping furniture.
- _As built (approved):_ `world/path.ts` is A* over the 8 px walk cells, 4-way so a path
  only needs the four facings, with a small cost per turn so routes are long straight legs,
  not staircases; it may start on a blocked cell (getting up) but never steps onto one, and
  takes cells to avoid. `world/move.ts` walks people at 30 px/s along the cells where the
  path turns, one axis at a time so they face where they go, ending exactly on the target
  (or, if that can't be reached from the door, the nearest cell that can). Getting up puts
  a worker behind their chair; arriving can mean standing, sitting at a desk, or leaving
  through the door (then they're away: not drawn, not hit); coming in starts at the door.
  Someone standing in the next cell makes a walker wait; after 1 s they look for a way
  round, after 3 s they squeeze past. The sim moves people at 10 Hz and the renderer slides
  them between steps, so walking is smooth at any frame rate. The debug click (page and
  preview): click a worker to pick them (their tag shows), then the floor to send them
  there, a free desk to sit at it, or the door to see them out — they come back to their
  own desk 3 s later; `G` shows the routes. Tests cover A* (shortest, straight legs, walls,
  no way through, blocked start, avoided cells, door to every desk) and walking (no step on
  furniture, facing, landing, sitting, leaving and coming back, waiting and going round,
  squeezing past). Checked in the preview: people walk behind desks and in front of them in
  the right order; screens don't yet follow who's at a desk (O1.3/O1.4).

### Step O1.3 — Assignment engine
- **Depends on:** O0.3, O1.2.
- **Build:** the rules in "Assignment" as a pure module (snapshot in → assignments out) with
  tests (stickiness, borrowing order, release, > 12 sessions). The sticky map and the room
  mapping are saved through Workbench (an `/office/api/prefs` route backed by the app DB),
  not in browser storage. Workers walk to their desks when assigned.
- **Done when:** tests pass; starting/stopping sessions in Workbench moves the right workers.
- _As built (approved):_ `world/assign.ts` is the rules, pure: live sessions in the rail's
  order, the rooms, the sticky map and the seating so far in; the new seating and sticky
  map out. Seating already given never moves while its session lives. A new session takes
  its sticky worker if they're free — one from another team only when the room's own team
  has nobody free — else a random free worker of the team, preferring ones no ended
  session still has a claim on. A team with nobody free borrows from the open space, then
  the other main team (the open space borrows from Demiurge, then TinyWizardRoyale); a
  borrowed worker takes the free desk nearest the room, the two spare desks first, and
  nobody takes the home desk of a worker who's free. Past twelve, a session is a
  contractor: a free desk with a laptop on it and a "Remote contractor" tag (on hover or
  `N`), or no desk once the two extra desks are gone; a contractor gets a worker as soon
  as one is free. Sticky entries for instances Workbench no longer has are dropped.
  `world/sessions.ts` applies it: on the first snapshot everyone is simply in place; after
  that a newly seated worker walks to their desk (in through the door if they're out) and
  a released one walks to a free kitchen spot (else another idle spot). People with
  nothing to do stand at the kitchen, kicker, D&D and window spots — not at their desks,
  since sitting without typing waits for the relaxed pose (O2.1); real idle life is O2.
  "A borrowed worker returns home" means just that they're free again: their next session
  is their own team's, at their home desk. Screens are on where a worker sits at their
  session's desk, laptops on contractors' desks, dark elsewhere. Name tags carry the
  session's phase glyph; the rest of "Status → behaviour" is O1.4. The page
  (`liveOffice.ts`) loads the saved settings from `GET /office/api/prefs` before the first
  seating, and saves `{rooms, sticky}` back with `PUT` (a second after a change). Workbench
  keeps them as one JSON object (≤ 64 KiB) under `office.prefs` in the DB's `meta` table
  and doesn't read them. The sidebar's **Rooms** list sets each project's room; moving a
  project re-seats its live sessions from the new room. The preview keeps the O1.1 demo;
  the office page's debug click still works, and the next snapshot sends a moved worker
  back. Tests: assignment (home desks, stability, stickiness and claims, forgetting,
  borrowing order and spare desks, release, > 12, a 200-round random run checking that
  no desk or worker is used twice), seating (first snapshot in place, walking to a desk
  and to the kitchen, coming in through the door, laptops, when to save), and the prefs
  route's validation (Rust). Checked in the preview's renderer with made-up sessions:
  borrowing onto the spare desks, contractors' laptops, and ten people walking off to the
  kitchen and lounge. Not yet watched against real sessions in Workbench.

### Step O1.4 — Status → behaviour
- **Build:** the table in "Status → behaviour", including the `!`/`?` bubbles.
- **Done when:** each state is visible when driven from a real session (and from a fake
  snapshot fixture for the rare ones).
- _As built (approved):_ `world/behave.ts` turns each session into a place and a pose,
  re-applied every sim step so timed changes happen without a new snapshot. At the
  desk: typing (twice as fast with subagents out), a newspaper held up for the web (its
  top shows over the bowed head), a sheet held to one side for reads, slumped on the
  keyboard when stuck, leaning back with the hands behind the head for an idle session,
  and with a coffee when done. Away from it: the server rack for a command, the
  Demiurge whiteboard (or the meeting room's, if that one's taken) for tests, the filing
  cabinet (a new spot in front of it) while compacting; with the station taken, they
  type at the desk instead. Needs you: up and standing beside the desk facing you, so
  the bubble doesn't hide the monitor, waving, a `!` bubble (`?` for a question), the
  monitor flashing red; escalated: sweating, waving faster, the bubble flashing red.
  Done for ten minutes: they wander to an idle spot and come back for the next turn.
  Nobody leaves the office: a session that ended in a still-open console sends its
  worker to the kitchen or the lounge until it restarts (a closed console releases
  them the same way, as in O1.3), and a console whose session hasn't sent its first
  hook yet counts as idle — at the desk, leaning back. Over the head: the stuck and
  done icons, and the working icon only away from the desk (at it, the monitor says
  so). Contractors get the `!`/`?` over their laptop. A change of activity only moves a
  worker once it has held for 1.5 s, and nobody leaves a station sooner than 6 s after
  getting there, so a session flicking between tools doesn't send them running; a
  change of phase is acted on at once. Monitors: code while working, red while it
  needs you, dark otherwise (done, idle). New poses in `art/characters.ts`: typeFast,
  fret, newspaper, document, board, tinker, file, relax, coffee (Cast section buttons
  in the preview). The preview now seats `world/fixtures.ts`'s one-session-per-state
  snapshot, so every state shows at once; a debug-clicked worker goes back to work 3 s
  after arriving. Tests: the state → behaviour table, and in a stepped office: first
  snapshot in place, standing up and sitting back down, rack only for a lasting
  command, staying at a station, sharing the whiteboards, done → wander → back, ended
  → kitchen → back, a new console at the desk, the working icon only away from the
  desk, the debug click, change detection. A shell command that runs a test script of
  your own (`random_test.ps1`, `test_api.py`, `run-tests.sh`, `app.test.js`, Pester)
  now counts as a test run (`state/activity.ts`), not only the known test runners.
  Watched against real sessions in the dev app (O1.3 and O1.4 together): sessions
  got workers from their rooms and kept them; reading, editing, waving with the red
  monitor, coffee when done all showed. What that turned up, all fixed: a new console
  read as ended (its phase is null until the first hook), so its worker walked out and
  back in on the first prompt; a session running `random_test.ps1` sent its worker to
  the rack (the script wasn't recognised as a test); the working icon over every desk
  was noise; and the waving worker, behind the chair, hid the monitor under the
  bubble. Workers no longer leave the office at all.

### Step O1.5 — Hover and the sidebar
- **Build:** hover tooltip (worker, project, session title, phase, activity, for how long).
  Clicking a worker opens the sidebar: header, the pending choice (choice card → `choose`),
  transcript tail, prompt box, interrupt / stop. Esc closes it.
- **Done when:** you can answer a permission prompt and send a prompt from the office.
- _As built (approved):_ hovering a worker shows a tooltip by the pointer
  (`describe.ts`): who they are and their room, the project and session title, and
  what it's doing in words ("editing, 2 subagents out", "needs you: wants
  permission") with how long it's been so — counted from when the page first saw that
  state, so a session already waiting when the office opened counts from then. A
  worker with no session is "free"; a contractor's desk is a "Remote contractor".
  Clicking a worker or a contractor's desk opens their session in the sidebar
  (`panel.ts`); clicking the floor, ✕ or Esc closes it, and it follows the worker
  onto their next session. The panel: the header (who, project · title · branch, the
  state with the rail's glyph), the phone's choice card (`pwa/choice.ts`) to answer
  with `choose` — its terminal buttons hidden, there's none here — or approve/deny when
  Workbench can't say what's asked, the transcript's tail (the desktop's feed and
  renderer over the office's transcript socket, through the phone's
  `transcriptSource`), following the end unless you scroll up, and a prompt box
  (Enter sends, Shift+Enter a new line; "start" when the console isn't running) with
  interrupt while it works and stop, which asks a second click because it closes the
  console. Drafts are kept per session. The O1.2 debug click (pick a worker, send them
  walking) now works only with the walk grid on (`G`). The sidebar is the same size
  in every mode, set from the window (`sideLayout` in `canvas.ts`): the office fills
  the height and the column takes the width left (wider on a wide monitor, never under
  280 px, the office shrinking then); on a portrait screen it's a panel under the
  office, as tall as the office leaves. Tests: the tooltip's wording, who a worker or
  a contractor is, the sidebar's size. Checked in Workbench (the dev app): a
  permission prompt answered and a prompt sent from the office.

### Step O1.6 — Stats when nothing is selected
- **Build:** sessions by phase, usage limits, context sizes, sessions and commits today,
  CPU/RAM from O0.4, a short activity log (worker events in plain words).
- **Done when:** the sidebar shows them updating live.
- _As built (approved):_ with nobody picked the sidebar shows (`stats.ts`, rebuilt on
  every snapshot and every 3 s): the live sessions by phase; today's sessions that
  worked (counted by the page, kept with its prefs so a reload doesn't lose them) and
  today's commits (Workbench counts each project's commits since the local midnight,
  `git::commits_since`, carried as `commitsToday` on the snapshot's projects); the
  5-hour and 7-day usage limits as bars with their resets; the five fullest contexts,
  by worker; Workbench's CPU/RAM (one poll shared with the HUD); and an activity log
  (`log.ts`): the last eight changes between snapshots in plain words, by worker — a
  session opening or closing, getting to work, needing you (and what it asks),
  finishing, new commits. It replaces O0.2's plain session list. A debug build also
  starts the office's listener with the app and writes a reusable office URL to
  `office-dev.url` in the app-data dir, so a tool can open the office without a
  click. Tests: the log's wording, the phase counts, the contexts, today's commits;
  counting commits since a time. Checked in Workbench (the dev app).

## Phase O2 — Office life

### Step O2.1 — Idle planner
- **Build:** activities with locations, slots, durations and weights by personality (coffee,
  water cooler, sofa, bookshelf, window, plants, a walk); slot reservation so nobody stacks.
  Nobody ever leaves the office: idle workers always find something to do inside, and move
  on to another activity every so often, so a long idle stretch doesn't freeze anyone in
  one place. The activity list is meant to grow, so adding one is just a new entry. Time of
  day shapes the choice (lunch in the kitchen around noon; at night the quieter ones: the
  sofa, the window, their desk with the lamp off).
- **Done when:** idle workers look busy for 10 minutes without anyone getting stuck or
  overlapping.
- _As built (approved):_ `world/idle.ts`: twelve activities as a list (coffee, a fridge
  snack, the dishes, the water cooler, the sofa, a beanbag, a window, the bookshelves,
  watering plants, doodling on a whiteboard, a stroll, the paper at their own desk), each
  with its places, pose, how long it lasts (half a minute to eight) and a weight. A
  worker's `likes` (two each, in the roster) make those three times likelier; the time
  of day weighs in (lunch 12–14: the kitchen; night 22–7: the sofa, the windows, their
  desk); the same thing never twice running. A spot (or desk, as `desk:<n>`) is held by
  one person from the moment it's picked; someone at their own desk gets up when a
  session wants it; anyone not there within 90 s picks again. A session ending sends its
  worker to the kitchen first; done-for-ten-minutes and ended workers idle the same way
  (but not at their session's desk). Sofa and beanbag sitters walk up and settle onto
  the seat itself, behind the furniture's front. New spots: a second Demiurge window,
  five plants, four stroll ends. Tests: the picker's rules (likes, time of day, no
  repeats, only free places, kitchen first, durations); ten simulated minutes of a whole
  office checked every step — nobody holding or standing on another's place, everyone
  moving on, nobody giving up on a trip, under 30 % of the time walking — passing on 40
  seeds across morning, lunch and night, with and without sessions. Seen in the office
  page.

### Step O2.2 — Group activities
- **Build:** water-cooler chats (canned lines for now), kicker matches (moving ball, score),
  console sessions on the sofa.
- **Done when:** each happens on its own during a normal session.
- _As built (approved):_ `world/groups.ts`, on top of the idle planner. Two or three at
  the water cooler chat: canned lines in speech bubbles, taking turns every few seconds,
  for at least a minute and a half. Two at the kicker (a new idle activity that waits up
  to two minutes for an opponent) play a match to five: goals at random every 6–20 s,
  the ball running on the table and into the net, the score in a bubble over it; the
  winner cheers and the loser facepalms. Two or more on the sofa get the console out:
  the TV is on only then (off otherwise), controllers in hand (a new `gamepad` pose; the
  kicker's is `foosball`), now and then a shout. Social activities draw people to
  company (four times likelier with someone there; one that needs a partner twelve
  times likelier with someone waiting, less likely started alone), so they form by
  themselves. Each goes in the activity log ("Kenji beat Lola 5:3 at the kicker").
  Tests: matches always reach five with the ball on the table and in the net at each
  goal; thirty simulated afternoon minutes with three sessions working see a chat, a
  console session and a finished match on every seed tried (about six chats, four
  console sessions and three matches per half hour), the TV never on for one, and
  nobody leaving a match before it's over.

### Step O2.3 — Reactions
- **Build:** a commit → the worker cheers; escalation → sweating; session end → off to the kitchen (nobody leaves the office);
  Duck's autopilot acting on a session → Duck waddles over.
- **Done when:** each is visible when triggered for real.
- _As built (approved):_ `world/reactions.ts` compares each snapshot with the last.
  Sweating (`fret`) came with O1.4 and the kitchen after an ended session with O2.1. A
  rise in a project's commits today has one worker on it (one running a command first,
  then one working) get up beside the desk and cheer for five seconds, or turn and
  cheer at the rack; not on the first snapshot, nor when the count resets at midnight.
  A session on autopilot that starts working, starts compacting or gets its question
  answered brings Duck out from behind the boss desk, waddling the same routes as
  everyone, to the left of that desk: it faces the worker and says a short line for six
  seconds, then goes back. The snapshot says which sessions an autopilot drives, not
  who acted, so moving one on yourself brings Duck too. Tests: the cheer and who gives
  it, no cheer for what isn't news, Duck there and back, Duck staying put otherwise.

### Step O2.4 — Ambience
- **Build:** daylight tint through the day and lamps at night, monitor glow, clock with real
  time, a "coffee budget" whiteboard showing the usage limits.
- **Done when:** the office looks right at noon and at midnight; CPU still within budget.
- _As built (approved):_ `world/ambience.ts`. The windows show the sky of the hour by
  the local clock: night (19:30–5:30, the starry one), dawn, day and dusk. A shade over
  the office with ceiling lamps and monitor glow at night was tried and dropped as not
  adding much. The clock already told the real time (OD.5). The whiteboard on
  Demiurge's wall is the coffee budget: a mug for the five-hour usage window and a pot
  for the week, each a gauge of what's left (red past 80 % used, dashed when not
  known; a window past its reset is full again). `?time=HH:MM` on the page's address
  sets the office's time (the sky, the clock, the idle planner's hour) for checking it
  at noon or midnight. Also: chat bubbles up when the saved settings load no longer
  stay up for good.

## Phase O3 — Duck and running the office

### Step O3.1 — Duck in the boss office
- **Build:** Duck's state animations; clicking Duck opens a Duck chat in the sidebar (reuse
  the phone's Duck client where it fits, `src/pwa/duck*.ts`).
- **Done when:** you can talk to Duck from the office and see it think and answer.
- _As built (approved):_ `world/boss.ts`, `duckChat.ts`. At the boss desk Duck shows
  what it's doing: its beak moves while it speaks aloud or its reply streams into the
  office's chat; it looks up with a "…" while it thinks or runs a tool, with "routine"
  during a routine; a card waiting for your yes or no is a red "?"; otherwise it bobs.
  Out on a trip (O2.3) it leaves that behind. Hovering Duck says what it's doing;
  clicking it opens a chat in the sidebar: a thread picker and a new thread, the
  conversation (the desktop's items and markdown), the reply as it streams, the turn's
  state, Duck's cards to allow or deny, and stop. The phone's pieces do the work: Duck's
  socket on the office's listener (`/office/api/assistant`, the same relay as the
  phone's) and the phone's store (`duckStore.ts`); no mic, voice or files. The webview
  takes the office as you at the desktop, not a phone: its messages are the desktop's,
  nothing is spoken for it, pushes and announcements go on as if it weren't open, and it
  can't be a host or upload. Also: the server keeps the list of open Duck sockets, and a
  bridge that starts asks for it, so a webview reload (a hot reload in dev) no longer
  leaves open chats, the phone's too, without Duck's news; an announcement with no phone
  open no longer renders speech.

### Step O3.2 — Giving tasks
- **Build:** drag an idle worker onto a desk (or click an empty desk): a small form (project,
  prompt, worktree, model) → `create` action. The worker walks to the desk and is bound when
  the instance appears (matched by `requestId`).
- **Done when:** a session started from the office runs in Workbench with that worker on it.
- _As built (approved):_ `world/hire.ts`, `hireForm.ts`. Drag a free worker onto a free
  desk, or click a free desk (hovering one outlines it): the sidebar opens a form for it,
  naming who'll take it — the one dragged, else the desk's owner if free, else the
  nearest free worker of the room's team, else anyone free, else a contractor. Project
  (those in the desk's room first, the one committed to latest picked), first prompt
  (Ctrl+Enter), model and worktree; it sends the phone's `create` action, with "send
  again" (same request id) when Workbench doesn't answer. Once sent, the desk and worker
  are held (`assign` gets them as `held`): the worker walks over and waits there, and
  when the request's instance is live it's seated with them, whatever room its project
  sits in, and the sidebar turns to its session. A failed request, one Workbench never
  heard of in 20 s, or 5 minutes without its instance lets them go. A free worker's
  panel and tooltip say they can be dragged.

### Step O3.3 — Answering from the bubbles
- **Build:** clicking a `!`/`?` bubble opens the choice card right there.
- **Done when:** a prompt is answered with two clicks without opening the sidebar.
- _As built (approved):_ `askCard.ts`. The renderer records where each `!`/`?` bubble
  was drawn (`Renderer.asks()`; `askAt` in `liveOffice.ts` hit-tests it, with a little
  slack). Clicking one opens a card by the bubble (above it, else below), out of the
  sidebar: the phone's compact choice card (`pwa/choice.ts`) answering with `choose`, or
  approve / deny when Workbench has no card for the prompt. It follows the bubble, closes
  once the session stops asking, on ✕, Esc or any other click; "session ›" opens the
  session in the sidebar. Hovering a bubble adds "click the bubble to answer here" to the
  tooltip. The name tag now stacks above the bubble (or status icon), so the tag that
  shows on hover never moves the bubble out from under the pointer.

## Phase O4 — Chatter

### Step O4.1 — Chatter service
- **Build:** `/office/api/chatter` → the webview → Duck's API client, Haiku, structured JSON
  output (a scene: speakers, lines, an optional mood). Context: personas of the workers
  involved, recent commits and session titles per project, time of day; a slice of random
  topics. Cached system prompt; budget (calls/hour, tokens/day) in settings; only while the
  office is visible; canned lines when off or over budget.
- **Done when:** scenes come back valid; the budget holds; turning it off costs nothing.
- _As built (approved):_ `remote/chatter.ts` (the shapes), the Rust core's
  `remote/office/chatter.rs`, the webview's `state/officeChatter.ts`, the page's
  `chatter.ts` and `chatterPanel.ts`. The page names who meets where (roster ids and
  what each is up to), when, and the projects in the air: their sessions', then their
  rooms', the latest committed to first. The Rust core is the gate: chatter on, under
  the hour's calls and the day's tokens, no other call out; otherwise it answers `off`,
  `hour`, `day` or `busy` and nothing reaches the webview. Past it, the request goes to
  the webview as an `office-chatter` event, and the answer comes back through
  `office_chatter_reply` (30 s at most). The webview adds each project's three latest
  session titles and its commits from the past week, and three random topics. It calls
  Haiku (Sonnet by the setting; purpose `office_chatter`) with structured output: lines
  of `{speaker, text}` and a mood. The system prompt holds the whole roster and the
  rules and never changes, so it's cached: about 1.9k tokens for the first call, then
  about 500. Lines by anyone not in the scene are dropped, characters the pixel font
  can't draw are taken out, and the rare overlong line is cut at a word. The settings
  (`office.chatter`: on, model, calls an hour, tokens a day; default on, Haiku, 20,
  50k) and the ledger (`office.chatter.usage`) are kept in the DB's `meta`. The day is
  the page's local date, and a cached read counts at a tenth, as it's priced. A call's
  tokens are known only after it, so a day can end one call over. The page asks nothing
  while chatter is off or the tab is hidden. After a spent hour it waits five minutes,
  after a spent day until the next, and after a failure a minute. Whenever it gets no
  scene it falls back to canned lines. The sidebar's **Chatter** section has the
  switch, the model, the two limits, what's been spent, and "Try a scene" (two or three
  free workers at the water cooler). Playing scenes in the office is O4.2. Checked in
  the dev app with real calls: valid, in-character scenes, one on a real commit; `off`
  with nothing spent; `hour` at a cap of one. Tests: the settings and the budget
  (Rust); the prompt, the cleaning, the budget's count; the request and the client's
  waiting.

### Step O4.2 — Playing scenes
- **Build:** when 2–3 idle workers meet at a chat spot, play a scene: they face each other,
  bubbles in turn, the lines go to the activity log.
- **Done when:** an hour with the office open has believable conversations within budget.
- _As built (approved):_ in `world/groups.ts`. There are two chat
  spots: the water cooler, and the sofa in front of the TV, where they talk over the
  console (gamepads out, eyes on the screen; its canned lines are the game shouts). The
  scene is told which (`spot`), and the topics suit it: office and kitchen things at
  the cooler, games, films and shows on the sofa. When two or three meet at one, the
  chat asks chatter (`staff.writer`, set by
  the page) for a scene of about six lines. It waits up to 6 s for it, then plays the
  lines in turn. Each line stays up 2.4 s plus 70 ms a character, and lines by anyone
  who has walked off are skipped. At the cooler everyone faces the others (along
  whichever way the rest are further), so the one at the top turns to the room. When
  the scene runs out and they're still there, it asks for one more (two per chat at
  most), given the chat's last eight lines: it carries on from them, with no greeting
  and no repeats. Canned lines fill in while it waits, and whenever there's no scene.
  An ask that comes back empty is made again with the next canned line. That's free
  unless the client actually calls: it doesn't while the page is hidden, chatter is
  off or over budget, or within a minute of a failure. This fixed a chat that began
  at load with the tab hidden staying canned throughout. The log has one entry per
  chat, "Mira and Gus are chatting at the water cooler" (or "got the console out"), with the scene's lines under
  it as they're said (the last ten). Canned lines stay out of the log. Lines aren't cut. A bubble
  takes about 48 characters (Haiku runs over the 36 it's asked for now and then), and
  a line running a word or two past that stays whole. One running three or more words
  past it is said in two or three bubbles by the same speaker. The break goes after
  the last sentence that fits, else after a comma, else between words. Only what three
  bubbles can't hold is cut, with "…". Broken between words, the first bubble keeps
  to 48 characters, so a word isn't left on its own. So the chats don't all sound
  alike, each scene is given a shape picked from 24 (news and reactions, a friendly
  disagreement, a story told in pieces, a tiny mystery…), and the ten topics the office
  talked about last, to steer clear of: the scene names its own `topic` for that. The
  three fallback topics rotate, none offered again within three scenes. About one scene
  in three, one of the workers has a small thing going on in their day (new squeaky
  shoes, a move next month), the same all day. The prompt says a personality is how
  someone talks, not a catchphrase to repeat, and that nobody off the roster works
  there. Checked in
  the dev app: in-character scenes at the cooler (lunch plans before noon, the mug in
  the sink, Ada's kitchen rota, Pip's spells), a follow-up that carries on, a third
  worker joining mid-chat and getting lines, and about 500 tokens a scene once the
  prompt is cached. Tests: facing, a scene played line by line by its speakers and
  into the log, the wait before canned lines, asking again after an empty answer, a
  follow-up given the chat so far; the log's gathering; the prompt's carry-on and the
  splitting of long lines.

## Phase O5 — Games

### Step O5.1 — Game overlay
- **Build:** clicking a prop opens a game overlay over the dimmed office; keyboard and gamepad
  input (Gamepad API); the office render pauses while it's open.
- **Done when:** a dummy game opens from the TV and the kicker and closes cleanly.
- _As built (approved; live test owed):_ `games/` on the office page. Hovering the TV or the
  kicker says "click to play"; clicking it opens its game in a window over the dimmed
  office (`overlay.ts`), scaled up by whole pixels, on its own 60 Hz loop that stops
  while the page is hidden. The office keeps stepping behind it (walks and chats go
  on) but isn't drawn till it closes. The keyboard and any gamepads (Gamepad API,
  standard mapping) read as one pad (`pad.ts`): arrows/WASD, the stick or the d-pad
  steer; Z/Space or A, X/Shift or B, Enter or Start. The game has those keys, so the
  office's own (G, N, P, H) wait. It closes on ✕, Esc, a gamepad's Back (let go first,
  so one held at open doesn't) or a click on the dimmed office. A game is `{w, h,
  step(pad), draw(ctx), stop?}` (`game.ts`); both props open the test game for now, a
  dot steered round a field with lamps for the buttons and which controller is in use.
  Gamepads need a secure page: on localhost they work, over plain http on the LAN the
  browser hides them and it's keyboard only. Tests: the keyboard and gamepad reading
  (deadzone, d-pad, a non-standard pad), the test game's steering, the props' hit test.
  Checked in the dev page: the TV and the kicker open their game, Esc and a click on the
  dimmed office close it. **Owed:** a live play test (the dot steering, the office
  still behind the game and back after it) and a real gamepad; the browser tab used
  was hidden, so no frames ran. To be done with the later games.

### Step O5.2 — Kicker
- **Build:** a small top-down foosball game against the computer.
- _As built (approved; live test owed):_ `games/kicker.ts`, opened from the kicker. The table is
  seen from above, you (blue) against the computer (red), first to five; which end you
  defend is drawn at random and every rematch swaps it. Four rods a side, interleaved as on a real table: goalie 1, defence 2,
  midfield 5, attack 3. You hold two rods at once, one per hand, each moved along your
  rods on its own and never crossing (the left hand's rod is always left of the right
  hand's). They start with the goalie in the hand nearer your goal and midfield in the
  other: from the right goal the right hand has the goalie. The pad grew a two-hand reading for
  it (`pad.ts`): WASD, the d-pad or the left stick is the left hand, with Q/E to move it
  along; IJKL (or the arrows), A/B/X/Y as a diamond or the right stick is the right,
  with U/O beside it; on a gamepad each hand's bumper moves it outward and its trigger
  inward. Up and down slides a rod; left and right swings its men that way on a spring,
  toward the other goal to kick. It's physical: a foot hits the ball with the
  speed it really has, so a swing from a wind-up is a hard shot, a swing from rest a soft one and a still foot a wall that
  bounces it back, and sliding the rod as you hit it angles the shot. Swung far either
  way the feet lift and the ball rolls under. Your rods out of hand stay where you left
  them. The computer plays all four of its rods, a touch slower than you and late on
  where the ball is going; it winds up only from behind the ball and not at one coming
  in fast, keeps raised feet up over a ball (stepping the rod aside first) and lifts to
  let its own shots through. A serve rolls in from a side wall, top and bottom in turn;
  a ball lying dead for three seconds is served again. Enter or Start pauses and, once
  over, starts again. Tests: the table (every rod's reach across the field and the
  goalies' across the goal, no strip between rods out of reach), the hands moving
  along without crossing, the swing spring, a still foot bouncing the ball, a wound-up
  shot beating one from rest, rolling under raised feet, a goal and the serve after it, the ends beside
  the goal, the dead-ball serve, three minutes of computer-against-computer staying on
  the table, the computer beating a player who does nothing, pause and restart,
  your end by chance and swapped each rematch, the left end mirrored (hands, kicking
  right, scoring right), the hands' keys and buttons. Tuned headless: computer against computer comes out even over
  40 games (16–24, goals 145–165, about 2½ minutes a game); against a player who does
  nothing it wins all 40, mostly 5–0 or 5–1, in about two minutes, from either end.
  Checked in the dev page: the kicker opens its game, the table drawn at either end.
  **Owed:** a live play (the feel of the slide and swing, the computer's strength, the
  hands' switching) and a real gamepad; the browser tab used was hidden, so no frames ran.

### Step O5.3 — TV: the office console (split into O5.3a–f)
The TV is a games console with two halves: **our own minigames**, written in the office's
code and added to over time, and **an emulator** for your own game images. Saves made on the
TV carry over to RetroArch on Steam and on your phone. Decided (2026-10-28):
- **Save sync goes through Syncthing.** The office reads and writes the saves in the PC's
  RetroArch saves folder (RetroArch on Steam). Syncthing-Fork on Android keeps that folder in
  step with the phone's RetroArch, directly between the two devices with no cloud.
  Workbench writes no sync code of its own.
- **RetroArch on every device**, so a system uses the same libretro core everywhere.
  Mega Drive uses Genesis Plus GX.
- **Only in-game saves (`.srm`) travel.** Save states depend on the exact core build, so the
  office keeps its own save states locally.

Researched: [RetroArch Cloud Sync](https://docs.libretro.com/guides/retroarch-cloud-sync/)
works over WebDAV only and is reported unreliable on Android
([#16847](https://github.com/libretro/RetroArch/issues/16847)). Syncthing on handhelds is
the common setup, using Syncthing-Fork on Android since the original app was discontinued.
Folder-sync apps for Google Drive work but are slower and need the cloud. Save states don't
survive a move between devices.

#### Step O5.3a — Console shell
- **Build:** clicking the TV boots a console: a short boot logo, then a menu of cartridges.
  The menu lists the authored games (a registry, `games/console/`, where each game is a
  `GameDef` with a title, a cartridge label and its own best scores) and a **Library** entry
  for the emulator (empty until O5.3d). Adding a game means adding a module and one registry
  line. The pad drives the menu, and Esc or Back goes from a game to the menu, then off. While
  you play, idle workers drift to the sofa and beanbags to watch. The test game moves into
  the menu as "Pad test".
- **Done when:** the TV opens the menu; a game starts from it, returns to it, and keeps its best
  score after a reload; idle workers gather to watch.
- _As built (approved):_ `games/console/`. The TV opens **Duckbox**: its logo
  drops in with a little duck in sunglasses and "press start", and after two seconds or a
  press it shows the menu, a column of cartridges with each label in its own colours and
  the best score on it. The Library comes last and for now only says it's empty. Up and
  down (held, it repeats) choose, and A, Z, Space, Enter or Start plays. A cartridge
  plays at its own size and the overlay follows it, along with its keys under the picture.
  Esc or Back takes it out to the menu, and from the menu turns the console off. For this
  the overlay now offers Esc and Back to the game first (`Game.back`), and a game may
  change its size and help as it goes. A cartridge (`cartridges.ts`) is an id, a title,
  label colours, its keys and `make()`. One that keeps a score reads its game's `score`,
  and the best is kept in the page's storage. The test game is the first cartridge,
  "Pad test". While you play, idle workers come to watch: whoever is idle thinks again
  at once, with the sofa and the beanbags eight times likelier. The TV is on, and those
  on the sofa watch with their hands free, not holding the controllers they use when
  they play themselves. Tests: the boot (by time, or sooner on a press, not on one held
  at open), the menu's moves and repeat and wrap, the empty Library, a cartridge at its
  own size and help, Back to the menu (with the game stopped) and then not taken, a held
  button not restarting a game, the best kept (not the last) and saved on leaving, the
  watch places likelier, and an idle office filling the sofa and beanbags once you play,
  with the TV on and hands free (failing without it). Checked in headless Chrome against the dev page:
  the boot, the menu, the Library's note, the pad test with its help, and Esc to the menu
  and Esc again to close.

#### Step O5.3b — Star run: the flying and shooting
- **Build:** the first authored game, a vertical scroller. A ship flies up an endless
  scrolling starfield and shoots at enemies and asteroids. Everything ahead is generated from
  a seed, sector by sector: asteroid fields, enemy formations and their flight paths, with
  the mix and pace rising with distance. Lives, a score, a short invulnerability after a hit,
  and a game-over screen with the best run.
- **Done when:** a seed always generates the same sectors; difficulty rises with distance;
  a computer-flown ship survives longer on easy sectors than hard ones; a live play feels
  right.
- _As built (approved; live test owed):_ `games/starrun/`, the first cartridge in the Duckbox
  menu. The run is 160×224 and scrolls 0.75 px a step. A sector is 800 px, about 18
  seconds, and its name blinks as you enter it. Each sector is generated from the run's seed
  and its own number (`sectors.ts`). It is a squadron, an asteroid field or a mix, and the
  first is always a gentle squadron. Its heat sets everything: 5 formations, rising to 14;
  8 rocks, rising to 36; and the enemies' speed, toughness, rate of fire and shot speed
  all rise to a ceiling about sector 15. Four enemies come in as the sectors go on:
  - darts, in a line, a vee or a weaving column, shooting straight down from sector 4;
  - swoops, weaving across from a side;
  - gunners, which come down, stop to fire aimed shots, then go on;
  - divers, which turn and dive at you.
  Asteroids come in three sizes and split as you shoot them, each one lumpy in its own
  way. You fly with the arrows, WASD or a stick, hold A to fire, and hold B to fly slow.
  Start pauses. You have three lives. A hit flashes the ship and gives you two seconds
  where nothing touches you, and clears the shots close by. Points come for kills and for
  each sector reached. Game over shows the score, the sector reached and the best (or
  "new best!"), and Start flies again on a new seed. The console now hands a cartridge
  its best to beat (`make(best)`). `autopilot` flies the ship: it tries every direction a
  little way ahead and takes the safest. Tests:
  - a seed's sectors are always the same and another seed's differ;
  - the heat rises, with the threat of sectors 6–8 over twice that of 0–2 and 14–16
    higher again;
  - spawns stay in their sector and on the screen;
  - the gunner's stop, the scroll and spawning, and the points for a sector;
  - flying and firing, a kill, an asteroid's split, and a life lost then the safe moment;
  - game over (a press held from before doesn't restart it), the best carried on, and pause;
  - the same run step for step from a seed and pad;
  - the autopilot, looking again only every 12 steps the way a player reacts, flies all
    of 3,000 steps unhit from sector 1 in every one of 12 seeds, but is hit in most runs
    from sector 19, and flies over 1.5 times longer early on. Reacting at once, it dodges
    almost everything, so the difficulty is tuned for a player, not for it.
  Checked in headless Chrome against the dev page: the menu with Star run first, the
  sector banner, darts in vees and lines, asteroids, firing, the score and a life lost,
  pause, and Esc to the menu.
  **Owed:** a live play to judge the feel and the pace.

#### Step O5.3c — Star run: perks and bosses
- **Build:** pickups dropped by enemies and asteroids: spread shot, rapid fire, a shield, a
  bomb that clears the screen, a magnet, and extra lives. Weapons go up in levels and lose one
  when you're hit. A **boss** guards the end of every few sectors. Each boss is built from a
  seed out of parts (a hull, turrets and weak points) with attack patterns that grow with
  distance, and has a health bar and a death sequence. A new boss starts a new zone with its
  own palette and enemy mix.
- **Done when:** a boss from a seed is always the same and beatable; perks stack and drop
  back on a hit; a live play.
- _As built (approved; live test owed):_ `games/starrun/boss.ts`, with the perks in `starrun.ts`.
  Sectors come in zones of three. The last sector of a zone clears out early, then the
  scroll holds (the stars fly on) while the boss comes in under a blinking WARNING, its
  health bar filling. It is built from the run's seed and the zone's number:
  - a hull mirrored down the middle, its width eased row by row between a few made-up
    widths, with a notch or two cut in;
  - cores (one, then two, then three) and turrets sitting on its underside facing you, so
    a shot from below meets them before the hull;
  - turret pairs, each pair with a pattern: aimed, fan, stream, ring and spiral, the first
    two from the start and one more each zone, the newest on the first pair. From zone 2 a
    middle gun fires aimed shots.
  Further on, a boss is bigger, with more turrets and core health, and its shots come
  faster, thicker and sooner. Below half health it fires faster still. Shots stop on the
  hull, and only the cores count toward its health. A turret can be shot out for points.
  When the last core goes, its shots go with it. It shudders, sinks and bursts for two
  seconds, scores 1,000 times the zone, and leaves a spread, a shield and a rapid behind.
  Then the next zone begins under "ZONE n". It has its own palette (space, stars, rocks,
  and the boss's hull and core glow, out of five, never the one before) and favours two
  kinds of enemy.
  Enemies, rocks and shot-out turrets drop perks by chance: gunners often, darts rarely,
  and small rocks never. A perk is a capsule with its sign, falling slowly and blinking
  near the bottom:
  - spread: two shots, then three, then five fanned;
  - rapid: shots sooner, 7 steps down to 3;
  - shield: a ring round the ship per hit it will take;
  - bomb: at once clears every enemy, rock and shot on screen, and takes 15% off a boss's
    cores and 10 off its turrets, though it never finishes a boss;
  - magnet: 15 seconds of pulling perks in from 80 px, up to 30;
  - life: up to five.
  The gun and shields go to level 3; past a ceiling a perk scores 500. A hit the shield
  takes costs nothing more. Otherwise it costs a life and a level off the higher of the
  two guns. Pips under the score show the gun's levels and the shields, with a bar for the
  magnet. The autopilot now aims where a boss's nearest core will be, keeps off its hull,
  and goes for perks close by.
  Tests:
  - a boss is the same from the same seed and zone, and differs by either;
  - every hull is mirrored, with its cores clear underneath and turrets on the hull, over
    10 zones of 6 seeds;
  - zone 7's bosses are bigger, with more guns and core health, and with 4 or more
    patterns against zone 1's 2 at most;
  - the scroll holds through a fight; a shot on the hull does nothing; the last core
    clears the shots and scores; the boss dies, drops its three perks, the zone goes up
    and the scroll goes on into the next sector;
  - turrets shot out (one by a shot, the rest by a bomb) fire no more;
  - the computer, reacting every 12 steps with a gun at half the zone's number, beats
    every boss of zones 1–6 on 6 seeds, the zone 1 bosses without a hit, and the bosses of
    zones 5–6 hit it more than those of 1–2;
  - a boss fight goes the same step for step;
  - spread volleys of 1, 2, 3 and 5, and rapid fire over half as fast again;
  - stacking to the ceilings, then scoring;
  - a shield taking a hit, then levels off the higher gun on each hit after;
  - a bomb clearing the screen, while leaving a boss's cores at 1;
  - the magnet pulling a perk in;
  - drops from a computer-flown run, the same each time.
  Checked in headless Chrome by drawing set-up runs with the dev server's modules: a boss
  coming in, fights in zones 1, 3, 5 and 8 in their palettes, a death, the "ZONE 2" banner,
  and the perks with the shield rings and pips.
  **Owed:** a live play.

#### Step O5.3d — Emulator
- **Build:** the Library plays your game images through Nostalgist.js (RetroArch's
  libretro cores compiled to WebAssembly). The cores are **bundled locally** and loaded only
  when you start a game, starting with Mega Drive (Genesis Plus GX), then NES, SNES, Game Boy
  and Game Boy Advance. The images come from a folder you choose, served by the office
  listener, and zips are opened. No images ship with Workbench. The pad maps to the RetroPad.
  The game is integer-scaled in the overlay and can go fullscreen. The TV sprite in the
  office shows the actual picture. Save states are kept per game, in the office only.
- **Done when:** a Mega Drive image from the Drive (e.g. Sunset Riders) plays at full speed
  with a gamepad; closing it frees the core; a save state comes back after a reload.
- _As built (approved; live test owed):_ `games/emulator/`, the listener's
  `remote/office/library.rs`, and Nostalgist.js pinned at 0.23.0.
  - **Cores:** five, from Nostalgist's own RetroArch build (v1.22.2): Genesis Plus GX,
    FCEUmm, snes9x, Gambatte and mGBA. Their zips (about 6 MB) are built into Workbench
    (`src-tauri/resources/cores/`, with their hashes), and the listener unpacks a core
    when a game asks for it. Nothing is fetched from the web.
  - **The Library:** the folder is chosen from the Library's last row, in a folder
    dialog on the PC, and kept in the app DB. The Library lists the games under it, four
    folders deep, each with its system: `.md`/`.gen`/`.smd`/`.bin` (not beside a
    `.cue`), `.nes`, `.sfc`/`.smc`, `.gb`/`.gbc`, `.gba`, and zips holding one of them.
    It gets its image from the listener, out of its zip if zipped, and only from under
    the folder.
  - **Playing:** A plays a game, resuming it, and B starts it over. RetroArch runs off
    screen at the system's size: square pixels, 320×224 for the Mega Drive. Each step the
    overlay copies the picture and scales it by whole pixels, and ⛶ or F fills the screen.
    The pad reaches the core as RetroArch's keys:
    - the keyboard as RetroArch lays it out: the arrows, Z X A S, Q W, Enter and right
      Shift;
    - a gamepad by where each button sits;
    - RetroArch reads no keys or gamepads of its own.
    Buttons held from the menu count only once they're let go.
  - **Leaving:** Back on a gamepad is Select; Back with Start, or Esc, goes back to the
    Library. Leaving keeps a save state in app data (`office-states/`, one per game),
    then exits the core and removes its canvas. A dot in the Library marks the games
    that resume.
  - **The TV:** while a game runs, the TV in the office shows it, shrunk into its screen
    and redrawn ten times a second behind the overlay.
  - **Other changes:** the font gained brackets, `&`, `+` and `_`, for game names.
  - **Tests:**
    - the pad as a RetroPad, from the keys and a gamepad;
    - a Library game: loading, presses as they change (not those held from the menu),
      Select with Start, the state kept and then the core freed (even when keeping it
      fails), resuming or starting over, no core left running when left while loading,
      and failures named;
    - the listing read;
    - the console's Library: listing and moving, play and back to it marked, B fresh, a
      game asking to go, an empty file refused, the folder chosen, and no Library still
      saying it's empty;
    - Rust: the systems by extension, a scan with zips opened and a CD's `.bin` skipped,
      reading only inside the folder, state names, every built-in core unpacking, and the
      ROM name header.
  - **Checked against the dev app in headless Chrome,** with free homebrew from
    retrobrews kept outside the repo:
    - Bottled (`.md`) from its title into the game;
    - Errorrush out of a zip;
    - Ambushed on the NES at 256×240;
    - leaving and reopening resumes where it was, with the core's canvas gone in between;
    - the TV in the office shows the game;
    - with a fake gamepad, its Start starts the game while a non-standard pad's is
      ignored; Back alone keeps the game; Back with Start leaves.
  - **Found:** the Drive's game files are all **empty**: Drive itself reports 0 bytes for
    Sunset Riders and the rest. The Library lists them as "EMPTY FILE" and won't start
    them. Putting real copies there is the user's to do.
  **Owed:** a live play of a Mega Drive game with a real gamepad, judging full speed and
  sound, once a real image is in the folder.

#### Step O5.3e — Saves shared with RetroArch
- **Build:** in-game saves live in RetroArch's own saves folder on the PC. The office finds
  it from RetroArch's config (Steam install, `savefile_directory`, and the "sort saves by
  core" setting), or from a folder set by hand. The `.srm` is read when a game starts and
  written on every in-game save and on close, under the name RetroArch gives it. If the
  file on disk changed underneath a running game (Syncthing brought a newer save from the
  phone), the office asks which copy to keep and backs up the other, never silently
  overwriting either. A setup note covers Syncthing-Fork on Android, the folder pair, and
  the RetroArch settings that must match (the same core, saves sorted the same way).
- **Done when:** a save made on the TV loads in RetroArch on Steam and on the phone, and one
  made on the phone loads on the TV; a conflict is offered, not lost.

#### Step O5.3f — PlayStation and PSP (stretch)
- **Build:** PS1 through a libretro core (PCSX ReARMed), with the BIOS from RetroArch's
  system folder. PSP through PPSSPP, which needs WebAssembly threads, so the listener serves
  the office page cross-origin isolated (COOP/COEP headers). Measure whether either runs at
  full speed here. The big `.7z` images in the Drive look like PS2 games, which are out of
  reach in a browser.
- **Done when:** a PS1 game plays, and PSP is either working or written up as not viable
  with the reason.

### Step O5.4 — Whiteboard Pictionary with Duck
- **Build:** you draw, Duck guesses — or Duck draws (its drawing tools) and you guess.

### Step O5.5 — Morning standup
- **Build:** on request, idle workers gather at the standup table in Duck's office; each summarises yesterday's
  sessions of their project (Haiku over transcripts).

### Step O5.6 — D&D table (stretch, may need several passes)
- **Build:** an LLM dungeon master, idle workers as the party with their personas, a saved
  campaign, played in a side panel with dice.

### Step O5.7 — Meeting room: pitch an idea
- **Build:** a shortcut for brainstorming. From the sidebar (or by clicking the meeting room),
  write the idea, pick 2–6 participants and optionally a project for context. Whichever
  workers are free walk in and sit round the table. Each participant is a Workbench session
  (Claude Code, read-only in that project) with a role (builder, skeptic, user advocate…)
  from the worker's personality; they take turns on a shared thread run by the office, shown
  in the sidebar as a chat, and you can chime in or steer. While it runs, the meeting room's
  whiteboard shows the discussion: the idea's title and the options as they come up, as
  pixel scribbles. It ends with a written summary:
  options, risks, a recommendation, that you can copy or send to a project session as a task.
  Workers who are busy can't be taken; if too few are free, say so and offer fewer seats.
- **Done when:** a pitch with 3 participants runs to a summary; the workers sit in the
  meeting room while it runs and go back to idle after; cost per round is shown up front.

## Phase O6 — Polish
- **O6.1** Settings page (room mapping, roster names, chatter budget and model, open in browser
  vs window, ROM folder).
- **O6.2** Performance pass against the budget; record final numbers under "Measurements".
- **O6.3** Docs: a short section in the README and an architecture note.

---

## Measurements

_Filled in by O0.4 and O6.2._

**How to measure.** The office's HUD (`H`) shows the page's own work (draws/s, ms per
draw, steps/s, JS heap) and, every 3 s, what Workbench costs (`GET /office/api/stats`):
`cli` is the consoles (`claude`, shells, `ssh`, ConPTY's `conhost`, and all they
start), `app` the rest of Workbench's tree (itself, WebView2, the voice sidecar). CPU is a share of the whole machine, averaged since the previous reading.
The browser tab's own cost is in the browser's task manager (Chrome: Shift+Esc;
Firefox: `about:processes`). Take each number after a minute settled: with the office
closed, open and still, and open and busy.

- **O0.1, the page alone** (headless Chrome, 2× scale): the static office with its
  animations redraws ~21 times a second at ~0.4 ms a draw; paused, 0 draws; hidden, no
  frames and no steps. JS heap ~9.5 MB.
- **O0.4, baseline** (2026-10-26, debug build under `tauri dev`, Firefox, no live
  sessions, the office still): the page ~27 draws/s at ~0.3 ms. Workbench (`app`, 11
  processes) ~1.0 GB; CPU 1.6–2.0 % of the machine with the office tab showing, 1.5 %
  with it in the background (the HUD's polling stops; the snapshot still goes out).
  So the office adds ~0.3–0.5 %, most of it likely the HUD reading the process tree
  every 3 s. Firefox's own cost for the tab is not measured yet.

## Progress tracker

- [x] O0.1 Office page scaffold (`npm run dev:office`, port 1432; draws the static office)
- [x] O0.2 Serving, auth and "Open Office"
- [x] O0.3 Snapshot additions
- [x] O0.4 Measuring the cost
- [x] OD.1 Pixel format and palette
- [x] OD.2 Characters
- [x] OD.3 Furniture and tiles
- [x] OD.4 Duck the boss (sunglasses and a red bow tie)
- [x] OD.5 Floor plan
- [x] O1.1 Entities and rendering
- [x] O1.2 Movement
- [x] O1.3 Assignment engine
- [x] O1.4 Status → behaviour
- [x] O1.5 Hover and the sidebar
- [x] O1.6 Stats when nothing is selected
- [x] O2.1 Idle planner
- [x] O2.2 Group activities
- [x] O2.3 Reactions
- [x] O2.4 Ambience
- [x] O3.1 Duck in the boss office
- [x] O3.2 Giving tasks
- [x] O3.3 Answering from the bubbles
- [x] O4.1 Chatter service
- [x] O4.2 Playing scenes
- [x] O5.1 Game overlay (live test and gamepad owed)
- [x] O5.2 Kicker (live test and gamepad owed)
- [x] O5.3a Console shell
- [x] O5.3b Star run: flying and shooting (live play owed)
- [x] O5.3c Star run: perks and bosses (live play owed)
- [x] O5.3d Emulator (live play with a real image and gamepad owed)
- [ ] O5.3e Saves shared with RetroArch
- [ ] O5.3f PlayStation and PSP (stretch)
- [ ] O5.4 Whiteboard Pictionary with Duck
- [ ] O5.5 Morning standup
- [ ] O5.6 D&D table
- [ ] O5.7 Meeting room: pitch an idea
- [ ] O6.1 Settings
- [ ] O6.2 Performance pass
- [ ] O6.3 Docs
