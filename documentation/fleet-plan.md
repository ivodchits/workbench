# The Fleet — Development Plan

Workbench on several machines at once: the desktop, the laptop and, later, a headless
home server. Each machine runs its own Workbench instance with its own projects and
sessions. **One Duck** serves them all, running on whichever instance is the **main**
one. The phone reaches every instance, picks which machine's sessions it manages, and
always talks to the one Duck.

This plan replaces the old H6 outline in `assistant-plan.md` ("Duck on the home
server"). That outline had Duck living permanently on the server; here Duck moves to
whichever instance is main.

Steps follow the main plan's format (`claude-code-workbench-development-plan.md`): one
step per Claude Code pass, each with **Depends on**, **Build**, **Key files**, **Done
when**. The main plan's Definition of Done applies. A step that can't be tried yet (the
PC isn't built, the server doesn't exist) is built against fakes and gets "live test
owed" in its Done when.

The order is deliberate. **F1–F4 work with a main you set by hand** (the desktop), so
cross-machine sessions and actions arrive as soon as the PC exists. The risky part (Duck's
state moving between machines, F5–F6) comes after them, and the server (F7–F8) is gated
on the hardware.

---

## Settled decisions (2026-11-19)

1. **One active Duck.** Only the main instance runs Duck's engine, writes `duck.db`, and
   fires reminders and routines. Every other instance is a **host**: it offers its
   machine's tools and its Workbench to the main over the Duck Protocol (H1's model,
   extended). Its drawer is a remote surface of the main's Duck, like the phone.
2. **Sessions belong to their machine.** Projects, Claude Code sessions, terminals and
   `workbench.db` stay local to each instance. The phone chooses which machine's sessions
   it manages. Duck can start and drive sessions on any connected machine.
3. **Who is main:** the first live, eligible instance in a priority list shared by the
   whole fleet. The default order is **desktop → server → laptop**. The laptop is last
   because, once the server proves itself as main, the laptop never needs to be main.
   The list is editable, and a **pin** ("main is X until I say otherwise") overrides it.
4. **Main moves back automatically.** When a higher-priority instance comes back, it
   catches up and then takes over between turns. There's no battery rule.
5. **The server is Fedora Linux and runs headless.** Its own sessions are only research
   or heavy-thinking work. Coding work goes to the desktop or the laptop.
6. **The desktop is usually off at night (S5), not asleep.** Wake-on-LAN from soft-off
   is tried (F4), but nothing depends on it. Work for a machine that's off **waits in a
   queue** and is sent when that machine connects, and Duck says so. Accepted.
7. **Instances talk over the tailnet only.** Funnel stays the phone's public way in.
   Peers authenticate with instance keys, and Tailscale's identity of the peer is
   checked as well.
8. **Speech is done at the edge when the edge can.** The desktop and the laptop
   transcribe and speak locally and send text to the main. The phone's audio goes to
   the main, as today. A main without the voice models (the server, until they're
   installed) forwards the phone's audio to a peer that has them.
9. **The phone brain (H7) stays the last fallback**, for when no instance can be
   reached.

## Architecture

```
            phone (loader: every instance's Funnel address)
              │  Duck socket ──────────────┐   sessions socket ──▶ the chosen machine
              ▼                            ▼
   ┌──────── main (desktop) ─────────┐   relayed by any instance to the main
   │ Duck engine, duck.db (writer),  │
   │ reminders, routines, proxy,     │◀── peer link (tailnet, instance keys) ──┐
   │ budget ledger, lease holder     │                                          │
   └───────────────┬─────────────────┘                                          │
                   │ repl log + Duck repo bundles                               │
        ┌──────────┴───────────┐                                   ┌───────────┴────────┐
        ▼                      ▼                                   │ host tools served:  │
   server (replica, host)   laptop (replica, host)  ── each one ──▶│ workbench:<name>    │
   research sessions        coding sessions                        │ pc:<name>           │
                                                                   └─────────────────────┘
```

- **The peer link.** A WebSocket from each instance to every other instance's remote
  server, on its tailnet address. It carries: heartbeats and lease messages, the
  replication log, host traffic (`hello`, `device.call`, `device.result`) from each
  host to the main, the relayed phone sockets, and snapshots for the phone's session
  picker.
- **Hosts are named.** H1's `pc` and `workbench` become `pc:<instance>` and
  `workbench:<instance>`. A tool that acts on a machine takes `device`. When it's left
  out, the device is the one you asked from, else the one that has the project, else
  the main.
- **Projects across machines** are matched by their git remote, so "the workbench
  project on the laptop" resolves even though the paths differ. Each host announces
  its projects, with their remotes, in `hello`.
- **Capabilities.** Each host announces what it has (`steam`, `gpu`, `voice-models`,
  `always-on`, `claude-code`, its OS). Duck reads these to choose a device by itself
  ("launch Hades" needs `steam`, and only the desktop has it).

### Fleet state

| What | Where | How it syncs |
|---|---|---|
| Members, priority list, pin, lease term | `fleet` table in each `workbench.db` | Last writer wins with a version, gossiped over the peer link |
| Paired phones and other devices | `remote_devices`, made fleet-wide | Same as the fleet config. A key-bound device's proof verifies anywhere |
| `duck.db` | The main writes; peers hold replicas | The replication log (F5) |
| Duck's repo (memory, `reminders.json`, config, tasks) | Each instance's Duck workspace | Git, as bundles over the peer link; the main is the only one that commits |
| Attachments, drawings, files | The instance that made them | Fetched from their origin on demand, cached |
| The API key | Each instance's keychain (Secret Service or a credentials file on the server) | Set on each machine by hand; never sent over the link |
| Budget ledger (`assistant_usage`, etc.) | `duck.db` | Replicated, so the cap covers the whole fleet |

## Main election

- **Lease.** The main holds a lease with a term number and renews it every 5 s over the
  peer link. Hosts and surfaces follow the highest term they've seen. A message from a
  lower term is refused, which fences off an old main that comes back.
- **Failover.** The main has been silent for 30 s → the next eligible live instance in
  the list bumps the term, takes over from its replica, and tells the surfaces.
- **Handover.** A higher-priority instance has been up for 2 minutes and has caught up
  → it asks for the lease. The main stops taking new turns, finishes its running ones
  (it waits up to 60 s; a turn still running past that is cancelled and noted in its
  thread), sends the rest of the log, and hands over. The surfaces reconnect.
- **The pin** removes everyone except the pinned instance from the election. If the
  pinned instance is unreachable, Duck is unavailable (the phone brain covers it), and
  the menu says why.

## Phase F0 — Design sign-off

This document. Done when you've approved it; then H6 in `assistant-plan.md` points here.

## Phase F1 — The fleet

### Step F1.1 — Instance identity and the peer link
- **Goal:** Instances know about each other and hold an authenticated link.
- **Depends on:** —
- **Build:**
  - **Identity.** Each instance gets an id, a name (default: the hostname, editable) and
    a P-256 instance key, stored the same way as the device keys.
  - **Joining.** "Add a machine" in Remote Access issues a code on one instance; the
    other enters it, both sides approve, and they swap public keys and tailnet
    addresses. A third machine joins through either one, and the member list gossips.
  - **The link.** A peer socket on the remote server's tailnet listener (never Funnel),
    mutually authenticated by signed challenges, with Tailscale `whois` checking that the
    peer belongs to the same tailnet user.
  - **What travels.** Heartbeats carrying each instance's capabilities and version.
  - **The menu.** A "Fleet" section in Remote Access: members, online or not, last seen,
    version, remove.
- **Key files:** `src-tauri/src/fleet/` (new: `identity.rs`, `peer.rs`, `config.rs`),
  `src-tauri/src/remote/auth.rs`, `src-tauri/src/db/mod.rs`, the Remote Access menu.
- **Done when:** two dev instances on one machine (separate profiles and ports) join,
  see each other online and offline, and refuse a peer with a wrong key. Live test owed:
  the desktop and the laptop.
- _(Built, 2026-11-19: `src-tauri/src/fleet/` — `proto.rs` (records, merge, frames,
  statements, join strings, whois parsing), `store.rs` (`fleet_members`, migration v18;
  the identity in `meta` like the VAPID key, not the keychain, so Fedora needs nothing
  more), `link.rs` (listener, dialer, handshake), `net.rs` (Tailscale), the Remote
  Access menu's "fleet" section (`src/ipc/fleet.ts`, `src/state/fleet.ts`).
  **Changed from the plan:**
  - The link has **its own listener** (`48955`, `49055` in a debug build) on the tailnet
    address only, not the remote server's. The remote server's loopback listener is
    what Funnel exposes, and the fleet shouldn't depend on phone access being on. It
    listens only while there's a member or a live code.
  - "Both sides approve" is the code itself: it's made on one machine and typed on the
    other, and the peer must be the same tailnet user (`tailscale whois`). A **tagged**
    node has no user and is refused, so the server must not be tagged.
  - A copied identity (a new PC set up from the laptop's app data) is caught: a peer
    with this machine's id sets a problem in the menu with "reset this machine's
    identity", and a join with an online member's id is refused.
  **Checked:** the fleet runs three instances in one process over loopback: join,
  one link per pair (the same one at both ends), beats, a third machine introduced by
  gossip, rename, removal everywhere (and staying removed), leaving and rejoining, a
  wrong code, someone else's machine, an impostor with a member's id and no key, a
  copied identity, the identity across a restart. Tailscale's JSON fields checked
  against this laptop's CLI. Not yet run in the app; live test owed: the desktop and
  the laptop once the PC exists (or this laptop's dev build and an installed release
  that has F1.1, on their two ports). On Windows the firewall may ask about the new
  port the first time.)_

### Step F1.2 — Fleet config and the priority list
- **Depends on:** F1.1.
- **Build:** The `fleet` table (members, priority, pin, eligibility), last writer wins
  with a version, gossiped. The menu edits the order, the pin and "can be main". The
  main is chosen by hand at this stage (it's the pin), with no election yet.
- **Done when:** an order or pin changed on one instance shows on the other within
  seconds, and survives a restart of either.
- _(Built, 2026-11-19: `FleetConfig` in `fleet/proto.rs` (`order`, `pin`, `not_main`,
  `updated_at`, `by`; `ranked`, `main_by_hand`, `first_choice`), kept as one JSON value
  in `meta` (`fleet_config`), sent as a `config` frame on connect and on every change
  and in a join's answer; the menu's "main · priority" list (↑/↓, "can be main", pin,
  default order).
  **Changed from the plan:**
  - Not a `fleet` table: one record for the whole fleet, and the newer
    `(updated_at, by)` wins it whole. Two machines edited while apart settle on the
    later edit; the earlier one is lost. Simple, and the settings are rarely edited.
  - Each member says what it is (`kind`: desktop, server, laptop; migration v19), and
    the default order is by kind, so a fleet nobody arranged is already desktop →
    server → laptop. The first record guesses: Linux is the server, a Windows PC with
    a battery the laptop, else a desktop. Editable for this machine in the list.
  - The hand-set order lists ids; machines missing from it (one that joined later)
    come after it, by kind.
  - Pinning a machine makes it able to be main; turning "can be main" off drops its
    pin. The list's first choice (first live machine that can be main) is shown but
    acts on nothing until F6.
  - Leaving the fleet or resetting the identity forgets the settings, so the next
    fleet's win at once.
  **Checked:** proto tests (default order, hand-set order skipping the gone, pin and
  first choice, the later edit winning, records from before `kind`); a loopback fleet
  test: order and pin set on the laptop reach the desktop, "can be main" off on the
  desktop reaches the laptop and drops the pin, a machine joining later gets the
  settings in its join's answer and is placed by kind, the settings and kind survive
  a restart, a kind change travels, leaving forgets the settings. Live test owed with
  F1.1's.)_

## Phase F2 — The phone across the fleet

### Step F2.1 — Pair once, reach every instance
- **Depends on:** F1.2.
- **Build:**
  - **Pairing and auth.** `remote_devices` is replicated with the fleet config: a phone
    paired on one instance is paired everywhere, and a revoke applies everywhere. Each
    instance verifies a key-bound phone's proof itself, and sessions stay per instance.
  - **Addresses.** The snapshot lists every member's Funnel address. The loader
    (`duck-android/web/loader.ts`) and the PWA keep that list, and they open whichever
    instance answers first, the main preferred.
- **Done when:** a phone paired on instance A opens instance B's page without pairing
  again, and a revoke on B locks it out of A.
- _(Built, 2026-11-19: `PairedDevice` and `merge_devices` in `fleet/proto.rs`, a
  `devices` frame on connect and on every change, the `DeviceBook` the remote server
  implements (`remote/mod.rs`); each member's `public_url`; `/api/fleet`
  (`Fleet::phone_list`); `src/pwa/fleetList.ts`, kept by the page on every connect
  and used by the loader. Migration v20.
  **Changed from the plan:**
  - Devices travel on the peer link, not in the fleet config: a newer version wins
    (pairing, approval, revoke), and the latest use (`last_seen`) is the largest heard
    anywhere, so every machine counts the 30 days unused from the same day. A removed
    device (revoked, denied, expired) keeps a tombstone row with no usable token.
    Tokens cross the link: it's the same user's machines, keyed and on WireGuard.
  - The list is its own route (`/api/fleet`), not part of the snapshot: the
    snapshot is the webview's and is about this machine's sessions.
  - Without a pin, the phone's main is the list's first choice.
  - **Pair once works in Duck's app**, where the token and the device key are the
    app's. A plain browser keeps them per address (origin), so there each machine's
    address is paired on its own; F2.2's picker reaches the other machines from the
    one the phone is on, so this rarely matters.
  - The loader asks every address at once and opens the best that answers (main,
    priority order, the typed address). The loader is in the APK: the phone needs
    a new build of Duck's app for this. An older app still opens the address typed
    into it, and pair-once already works there.
  - Push subscriptions stay with the machine they were made on.
  **Checked:** proto tests (versions, last use, revokes staying, records without a
  token); loopback fleet tests: a phone paired on the laptop before it joined
  reaches the desktop, approval on the desktop reaches the laptop, a third machine
  gets it through the laptop, a use on the server moves `last_seen` everywhere, a
  revoke on the server reaches all and stays; every member's public address reaches
  the others, and `phone_list` orders and marks the main (the first choice, then the
  pin). `fleetList.test.ts`: order, filtering, parallel probing. Live test owed:
  the phone against the desktop and the laptop, both with public access on.)_

### Step F2.2 — The machine picker and Duck's relay
- **Depends on:** F2.1.
- **Build:**
  - **The picker.** A machine picker in the phone's dashboard. It fetches the sessions
    list, a session's transcript, the actions and "new session" (with that machine's
    projects) from the chosen machine, directly or through the instance the phone is
    on. It remembers your last choice, and the main is the default.
  - **The relay.** The Duck socket and its audio, TTS, image and file routes on a
    non-main instance relay to the main over the peer link.
- **Key files:** `src/pwa/dashboard.ts`, `src/pwa/net.ts`, `src/pwa/newSession.ts`,
  `src-tauri/src/remote/server.rs`, `src-tauri/src/remote/assistant.rs`.
- **Done when:** from the phone, a session on the laptop is prompted and approved while
  the phone's page is served by the desktop; Duck answers the same from either
  instance's page.
- _(Built, 2026-11-19: `remote/relay.rs` (`/m/<machine>/…` and the Duck layer), the
  fleet's `ask`/`answer` frames, `Fleet::relay_target`, `relay_session`, `duck_main`,
  the remote port in each beat; `src/pwa/machine.ts` and the header's picker.
  **Changed from the plan:**
  - Always through the machine the phone is on, never directly: the page's token,
    key and cache are per address in a browser, and one origin needs no CORS.
  - The relay doesn't carry requests inside the peer link. The machine the phone is
    on checks the phone, asks the target over the link for a **session for that
    device** (kept an hour, asked again once if refused), then forwards the request
    or socket to the target's own remote server on its tailnet address. The
    target's own checks still apply, and every route is reused as it is. So the target
    needs remote access on (it does anyway, for the phone).
  - What's relayed is a whitelist: the dashboard socket, actions, consoles,
    transcripts, notes, uploads. Duck's routes go to the main (the pin, else the
    list's first choice) when it's another machine that can be reached; otherwise
    this machine's Duck answers. A relayed request carries a mark and is never
    relayed again, so two machines that briefly disagree about the main can't pass
    it back and forth.
  - Picking a machine reloads the page onto it; the kept snapshot is per machine.
    Duck's unread marks come only from the main's snapshot.
  - Not yet: the desktop's own drawer on a non-main machine still shows that
    machine's Duck (settled decision 1 makes it a remote surface; that comes with F5
    and F6, when Duck's state moves).
  **Checked:** fleet test: ports in beats, relay targets (a peer's tailnet address,
  its own loopback), Duck at the main and following the pin, relay sessions asked
  over the link, kept, refreshed, refused for unknown devices. `relay.rs` whitelist
  test; `machine.test.ts`. **Live, on this laptop's dev build relaying to itself**
  (the same code path, loopback target): `/m/<self>/api/notes` gives the same answer
  as `/api/notes`, a bad token 401, a route outside the list 404, an unknown machine
  502, a POST goes through, the dashboard socket opens relayed with the `wb`
  subprotocol and a bad token is refused. Live test owed: two machines, the phone
  on the desktop's page driving a laptop session, and Duck from the laptop's page.)_

## Phase F3 — Workbench as a remote host

### Step F3.1 — `port.remote` and named hosts
- **Depends on:** F1.2.
- **Build:**
  - **Named hosts.** Every non-main instance connects to the main as `workbench:<name>`
    and `pc:<name>`, and serves its `WorkbenchPort` over the protocol (`port.remote.ts`
    on the main, the host side next to `connectLocal`). The main's own Workbench stays
    in process.
  - **The `device` argument.** Workbench and PC tools take `device` and default as in
    the Architecture section. The tool list sent to the model stays fixed (host tools
    stay deferred), so the cache survives.
  - **Duck's drawer.** On a non-main instance the drawer becomes a remote surface of the
    main's Duck.
- **Key files:** `src/assistant/port.ts`, `port.remote.ts` (new), `hosts.ts`,
  `remoteBridge.ts`, `tools/pc.ts`, `tools/` (Workbench tools), `index.ts`.
- **Done when:** with the desktop as the main, Duck starts a session on the laptop,
  sends it a prompt, reads its summary and answers its permission question; "pause the
  music on the laptop" pauses the laptop's media.
- _(Built, 2026-11-19, all but the drawer (now F3.1b): `hosts.ts` (named hosts),
  `port.remote.ts`, `port.fleet.ts`, `fleetHosts.ts`, the fleet's `host` frame
  (`fleet_host_send`, the `fleet-host` event), `config.duck` in the fleet's status.
  **Changed from the plan:**
  - The hosts' traffic rides the peer link, not the Duck socket: the link is already
    authenticated both ways, so no machine needs a device token for another.
  - **No `device` argument on the Workbench tools.** The main's engine gets a fleet
    port (`port.fleet.ts`): every machine's projects and sessions, each with its
    machine's name, and a call goes to the machine that has the session or project
    it names (ids are unique across machines; `git` goes by folder). `list_projects`
    and `list_sessions` say the machine, and a project's name can carry it
    (`workbench@laptop`); a bare name several machines have is the main's. So the
    tool list didn't change, apart from the PC tools.
  - The PC tools take `device` (a machine's name), added in one place
    (`defineTool`), and default to the main's own PC.
  - The main mirrors each machine's projects and sessions (pushed on every change and
    every 3 s), so the port's synchronous reads answer at once. A session's screen
    (`readScreen`) isn't mirrored: it's null for another machine, and keys still go.
  - Members that take the engine's callbacks stay the main's own: the T4 holds, the
    done summary, plugin drafts and actions, task ends. Asked for another machine,
    they fail with a plain reason. Autopilot and the workers still drive only the
    main's own sessions.
  - A main that starts, or hears from a machine it doesn't know, asks it to say hello
    again (`port.resync`).
  **Checked:** `hosts.fleet.test.ts` (a PC tool by machine name or id, here by
  default, an unknown machine named in the error, a machine going and coming
  back); `fleetHosts.test.ts`: two machines back to back (both machines' projects
  listed with their names; on the laptop a session is created, prompted, read and
  its permission answered; a prompt's failure comes back; the laptop's phases heard;
  `git` routed by folder; plugin drafts refused for the laptop; the laptop's music
  paused by name; the laptop forgotten when its link goes); `read.fleet.test.ts`
  (`name@machine`); a Rust test of host traffic over the link. Live test owed: the
  Done when, on the desktop and the laptop.)_

### Step F3.1b — Duck's drawer on a machine that isn't the main
- **Depends on:** F3.1.
- **Build:** On a machine that isn't the main, the drawer is a remote surface of the
  main's Duck: its `Transport` (`protocol.ts`, what the drawer already talks through)
  goes over the fleet's link to the main's endpoint, as the phone's does over its
  socket. The local engine stays idle while another machine is main. Attachments,
  drawings and images come from the main (as the phone fetches them). Speech is done
  here (settled decision 8): this machine transcribes and speaks, and sends text.
  The drawer says which machine Duck is on, and falls back to the local engine when
  the main can't be reached.
- **Done when:** on the laptop, with the desktop as main, the drawer shows the
  desktop's threads, a message typed on the laptop is answered by the desktop's Duck,
  and with the desktop gone the laptop's drawer says so and answers itself.
- _(Built, 2026-11-19: `switchTransport.ts` (the drawer's transport, and one over the
  link), the `duck` channel in `fleetHosts.ts`, `duckWhere`/`onDuckSwitch`, the
  drawer's "Duck is on …" line.
  **Changed from the plan:**
  - The local engine isn't idled: it still runs this machine's own routines and
    reminders until Duck's state is one (F5, F6), and it's what the drawer falls back
    to. Only the drawer moves.
  - A message with files from a drawer whose Duck is elsewhere is refused with a
    plain reason (the files are stored on this machine); text and voice go.
    Pictures and files in the main's threads are fetched from this machine's disk, so
    they don't show here yet. Both come with F5.2 (files fetched from their origin).
  - On a switch the drawer starts over from the other engine's `sync`.
  **Checked:** `switchTransport.test.ts`: subscribers moved there and back, files
  refused, and the laptop's drawer through both machines' fleet links (the desktop's
  threads, a change at the desktop reaching it, its own Duck again once the desktop
  goes). Live test owed: the Done when, on the desktop and the laptop.)_

### Step F3.2 — Projects across machines and the waiting queue
- **Depends on:** F3.1.
- **Build:**
  - **Projects.** Hosts announce their projects with their git remotes, and Duck
    resolves a project by name or remote on a given machine, or picks the machine that
    has it.
  - **The waiting queue.** A call for a host that isn't connected can be queued instead
    of failing. Duck asks, or queues on its own for work you asked to have done
    "whenever". The queue is in `duck.db`, shown in the drawer, and sent when that host
    says `hello`, with a note in the thread when it goes.
  - **The prompt.** Duck's prompt gets the fleet: who's online, what each machine is for
    (the server: research and thinking only), and where coding goes.
- **Done when:** "fix the flaky test in workbench" with the laptop off is queued and
  runs when the laptop connects; a project only on the desktop is never sent to the
  laptop.
- _(Built, 2026-11-19: `remotes.ts` (projects' git remotes, `git_origin_url`),
  `fleet.ts` (the machines, the prompt's paragraph, the queue), `tools/fleet.ts`
  (`list_machines`, `wait_for_machine`, `drop_waiting`), `waiting.rs` (duck.db), the
  `waiting` event and the drawer's list.
  **Changed from the plan:**
  - Projects aren't announced in `hello`: they're in the remote port's mirror (F3.1)
    with their `gitRemote` (looked up once per folder, in the background). A
    project is found by id, name, `name@machine`, or repo (`owner/repo`, the URL).
    A project only on the desktop is never sent to the laptop because a call goes to
    the machine that has the project's id.
  - The queue holds **tasks, not calls**: "what to do there, in full". When the
    machine connects to the main (its host's hello), each task goes back to its
    thread as a Workbench event, and Duck does it then with the usual tools, through
    the usual gate. A call replayed later would skip the judgement of whether it
    still makes sense. A task whose thread is gone opens a new one.
  - The prompt's paragraph names the machines and their kinds only (where Duck
    runs, where coding goes, the server's role, how to wait), in the block after the
    system prompt, so who's on now doesn't break the cache; `list_machines` says that.
  **Checked:** `remotes.test.ts` (every URL form alike, `owner/repo` matching, one
  lookup per folder); `fleet.test.ts` (priority order, the paragraph and its
  stability, queue and hand-over to its thread when that machine connects and not
  another, refusals for a machine that's on or unknown, a gone thread, drop, the
  queue across a restart); `waiting.rs` test. Live test owed: the Done when on the
  desktop and the laptop.)_

## Phase F4 — Waking machines

### Step F4.1 — Wake-on-LAN
- **Depends on:** F3.2.
- **Build:**
  - **The packet.** Each host announces its MAC address. A call for a sleeping or off
    machine that allows waking sends the magic packet, from the main or from any online
    peer on the same LAN, then waits up to 90 s for `hello`, and says so in the thread.
    If the machine doesn't come up, the call falls back to the waiting queue.
  - **Settings.** "Can be woken" per machine, off by default.
- **Done when:** tested over a fake socket and a fake host. Live test owed: waking the
  desktop from sleep and from soft-off (S5). Soft-off needs the BIOS's Wake on LAN on,
  ErP/deep sleep off, wired Ethernet, and possibly Windows' Fast Startup off. If S5
  can't be woken, the setting stays off for it and the queue covers it.
- _(Built, 2026-11-19: `proto::Lan`, `parse_mac`, `magic_packet`, `pick_lan`;
  `net::local_lan` (sysinfo's `network` feature), `send_magic`; `Fleet::wake`, the
  `wake` ask; `config.wake`; migration v21; `fleet_wake`, `fleet_set_wakeable`;
  `wake_machine` (`tools/fleet.ts`); the menu's "wake" box and "wake now".
  **Changed from the plan:**
  - The MAC isn't in `hello`: each machine says its LAN interface (MAC, network,
    broadcast address) in its own fleet record, so it's known while the machine is
    off. The interface is the wired one with a private address (the wireless one
    if that's all), never a virtual or Tailscale one.
  - Who sends: this machine when it's on the sleeper's network, else a machine
    that's on and is (asked over the link). The packet goes to the network's
    broadcast address and to 255.255.255.255, port 9.
  - Waking is Duck's tool, not something every call does: `wake_machine` sends the
    packet and waits up to 90 s for the machine (its host's hello, or its link
    coming up, for a machine that outranks this one and becomes the main). Duck's
    prompt says to wake a machine that can be, and else offer the queue. Nothing
    else wakes a machine.
  - A machine that wakes up and becomes the main doesn't get the old main's queue:
    the queue moves with Duck's state (F5, F6).
  **Checked:** proto tests (MAC forms, the packet, the interface picked: wired over
  Wi-Fi, no virtual or Tailscale one, the broadcast address); the packet on a
  real UDP socket; a fleet test over fake networks (not allowed until set; from a
  laptop away, the server at home sends it; from the server, from itself; a machine
  that's on is on); `fleet.test.ts` (sends and waits for the hello or the link,
  gives up after the wait, refuses one not set). Live test owed: the desktop from
  sleep and from soft-off.)_

## Phase F5 — Duck's state on every machine

### Step F5.1 — The replication log
- **Depends on:** F1.1.
- **Build:**
  - **The log.** Triggers on `duck.db`'s replicated tables write `repl_log (seq, term,
    tbl, pk, op, row JSON)`. Each replica keeps the last `(term, seq)` it applied and
    streams from there over the peer link. A replica that's too far behind gets a
    snapshot instead (SQLite's backup API) and streams from then on.
  - **Excluded tables.** `mcp_tool_cache` and the FTS indexes stay out of the log; each
    machine rebuilds those from its own files.
  - **Paths.** Rows that hold absolute paths are audited and changed to workspace-relative
    paths, with the origin instance recorded for files fetched on demand.
- **Key files:** `src-tauri/src/assistant/db.rs`, `src-tauri/src/fleet/repl.rs` (new).
- **Done when:** a replica on a second dev instance matches the main row for row after a
  day of use, including after the replica was offline for an hour.
- _(Built, 2026-11-19: `src-tauri/src/fleet/repl.rs`; the `replLog` and
  `replSnapshot` asks; `Fleet::replicate`; `repl::install` in `DuckDb::open`; the
  menu's "Duck's state" line.
  **Changed from the plan:**
  - **The copy is its own file** (`duck.replica.db`), not the machine's `duck.db`:
    until the election (F6) every machine's Duck still writes its own, and a copy
    streamed into it would fight those writes. A machine becomes the main with the
    copy (F6.1).
  - No term in the log yet: an `epoch` (random, per database) says which history the
    `seq`s belong to, and the term comes with the election.
  - The replica pulls (every few seconds while Duck's main is another linked
    machine, up to 1000 entries a batch) instead of the main streaming, so a link
    that comes back just continues. A snapshot (`VACUUM INTO`, in 256 KB chunks) when
    the copy is of another main, another epoch, behind the log's start (it keeps
    100 000 entries), or can't take a change (a schema it doesn't have).
  - The triggers are made from the schema on every open, so no migration is needed
    when a table changes; a BLOB is logged as hex so no value can fail a write.
  - Also left out: `memory_index_files` and `meta`'s `memory_index_root:*` (this
    machine's folders).
  - **Paths, audited:** Duck's workspace in tasks, drawings and autopilots
    (`workspace`, `folder`, `planPath`); attachment files under the app's data folder
    in messages, tasks and drawings; session file paths in the decision log (about the
    project's machine; left as they are). Rather than every writer going relative,
    `rebase_paths` rewrites the old machine's workspace and data folder to this one's
    when a copy becomes the main (F6.1). The files themselves come with F5.2.
  **Checked:** `repl.rs` tests (inserts, updates incl. a key change, deletes, BLOBs,
  the left-out rows, epochs, a replica ahead or behind, a bad batch rolled back, the
  path rebase); a fleet test (the desktop's tables copied to the laptop row for row:
  first by snapshot, then by the log; again after a gap past the log's start and
  after a new epoch). **On a copy of this laptop's real `duck.db`:** every table's
  rows updated through the triggers with no failure (1533 rows, 1595 entries; the
  append-only messages refuse updates by their own rule, and the replica applies a
  change as delete + insert), and its 2.6 MB snapshot installed as a replica. Live
  test owed: two machines over a day, with the replica offline for an hour.)_

### Step F5.2 — Duck's repo and files
- **Depends on:** F5.1.
- **Build:**
  - **Duck's repo.** The main commits as today and offers git bundles; replicas fetch
    and fast-forward. A replica never commits. The backup remote (L4) is unchanged.
  - **Files.** Attachments, drawings and files are fetched from their origin on demand
    and cached.
- **Done when:** memory written on the main is recalled by a replica after it becomes
  the main; an attachment made on the desktop opens in a thread on the laptop.
- _(Built, 2026-11-19: `src-tauri/src/fleet/files.rs` (`bundle`, `apply_bundle`),
  the `repoBundle` and `fileChunk` asks, `Fleet::fetch_attachment`,
  `fleet::ensure_attachment` (in `assistant_attach_prepare`/`_data` and the phone's
  image and file routes), `fleet_set_workspace`.
  **Changed from the plan:**
  - Like the database, the repo's copy is **a mirror in its own folder**
    (`duck-replica-workspace`), not the machine's Duck workspace, which its own Duck
    still writes until F6. The mirror never commits; it fetches a bundle (since its
    head when that's an ancestor of the main's, else whole) and resets to the main's
    head, at most every 30 s.
  - Files are fetched by id from whichever machine has them (Duck's main first):
    an attachment's id is its SHA-256, so the bytes are checked against it. Not only
    from the origin, so it also works the other way: the laptop's drawer can send
    files again (F3.1b refused them), and the main's Duck fetches them from the
    laptop when it prepares the message. Drawings are attachments, so they come the
    same way. A worker's task folder isn't fetched (it lives in the workspace,
    mirrored with the repo once committed).
  - "Recalled after it becomes the main" needs the promotion (F6.1): this step keeps
    the mirror current; F6.1 makes it the workspace.
  **Checked:** `files.rs` test (a mirror made from a whole bundle, kept up by one since
  its head, up to date, and whole again on a history the repo doesn't have); a fleet
  test (the desktop's Duck repo mirrored on the laptop; an attachment made on the
  desktop fetched by the laptop, one made on the laptop fetched by the desktop, one
  nobody has refused with a reason). Live test owed: the Done when, on two
  machines.)_

## Phase F6 — The main moves

### Step F6.1 — Election, handover and failover
- **Depends on:** F5.2, F3.1.
- **Build:**
  - **The election.** The lease, failover and handover as in "Main election", replacing
    F1.2's hand-set main. Routines, reminders and the waiting queue run only under the
    lease.
  - **Surfaces.** They follow the term: the drawer switches between local and remote,
    and the phone's relay re-targets.
- **Done when:** the desktop stopped mid-conversation → the laptop is the main within
  35 s and the thread continues on it; the desktop started again → it takes over after
  catching up, with nothing lost or doubled; a reminder fires exactly once across a
  handover.
- _(Built, 2026-11-19: the lease in `fleet/mod.rs` (`elect`, `hear_lease`,
  `take_lease`, `ask_handover`/`give_handover`), `proto::Lease` and `desired`, the
  `handover` ask, the lease and dirs in each beat, `fleet_lease` in `meta`;
  `DuckDb::become_copy` and `promote_here` (the copy installed, paths rebased, the
  workspace moved to the mirror's head); the webview's drain, reload on
  `duck-promoted`, and routines, reminders and the queue gated on the lease;
  `fleet_set_offline`.
  **Changed from the plan:**
  - The lease rides the beats (every 5 s), not its own message: the holder's beat
    renews it, and every beat says which term it follows. The failover is the
    holder unheard for 30 s, counted from when a machine took up the lease too, so
    one heard of through another machine gets time to link to its holder.
  - Two machines that took the same term apart (each started alone) settle on the
    one the list puts first (the pin, else by priority); what the other did alone
    is F6.2's to merge.
  - A pin elsewhere moves the lease by a handover (the pinned machine asks). While
    the pinned machine can't be reached, the holder keeps Duck rather than nobody
    having it.
  - **Taking over from another machine** (`promote_here`): the old `duck.db` is kept
    beside it (`duck.db.before-term-N`), the copy installed with a fresh log (the
    others take a snapshot of the new main), the old main's workspace and data paths
    rebased to this machine's, and Duck's workspace reset to the mirror's head with
    the old head kept on `fleet/before-term-N`. Then the webview reloads, so Duck
    starts on its new state. A machine that takes the first lease, or takes over
    with no copy of the old holder, keeps its own state.
  - The handover's catching up is the copy reaching the head the holder said after
    its turns ended (up to 60 s); a turn still running then isn't cancelled by the
    holder, which only stops taking new ones; its end is in the log the new main
    gets, and F6.2 covers what's written after.
  - "Surfaces follow the term" came for free: the drawer, the phone's relay and the
    hosts all go by `config.duck`, which is now the lease's holder.
  **Checked:** a fleet test of three machines: the laptop alone takes the lease; the
  desktop, first in the list, joins and gets it by a handover with the laptop's
  copy promoted (and its folders to rebase from); the desktop goes offline and the
  server (next) takes over by failover; the desktop comes back, follows, and takes
  it back by a handover; every machine follows every term. A pinned laptop keeps
  Duck from the desktop. `become_copy`: the copy installed with a fresh log, the old
  state kept, and a copy that can't be installed puts the live one back. Live test
  owed: the Done when on the desktop and the laptop; the reminder fired exactly once
  depends on `reminders.json` having been committed and mirrored before the
  handover, worth watching in that test.)_

### Step F6.2 — Merging after a split
- **Depends on:** F6.1.
- **Build:**
  - **The merge.** An old main that comes back with log entries the new main never got
    merges them. Messages are appended; when both sides wrote the same `(thread, seq)`,
    its side becomes a forked thread, "… (from <machine>)". Records keyed by id are
    last writer wins on `updated_at`, the usage tables are a union, and `meta` is last
    writer wins.
  - **Telling you.** A notice tells you what was merged.
- **Done when:** a scripted split (both mains write for a minute while cut off from each
  other) merges with no lost message, and a forked thread for the conflict.
- _(Built, 2026-11-19: `src-tauri/src/fleet/merge.rs` (`merge_tail`, the split
  mark), `Fleet::merge_due`/`merge_from`, the split recorded in `take_lease`, the
  `fleet-merged` notice in Duck's latest thread.
  **Changed from the plan:**
  - The new main pulls the old one's tail (its log after the `seq` the copy had
    when it took over, by the old log's epoch), rather than the old one pushing: the
    mark is kept in the new main's log state until the merge is done.
  - The fork holds the old main's side from the first message both wrote, with the
    thread's history up to there, so it reads whole on its own.
  - Usage tables are a union; so are timings, recall and the decision log (rows that
    stand alone). `meta` keeps this machine's value and adds the other's new keys:
    there's no clock on a `meta` row to pick a later writer by.
  - Deletes the old main made apart aren't repeated (nothing is lost; a thread it
    deleted apart is still here).
  - If the old main's history moved on before it came back (it took over again, or
    its log was trimmed past the mark), nothing can be merged; the notice says so.
  **Checked:** `merge.rs` tests (a scripted split: the thread both wrote to forked
  with its history, a thread made apart and a message in an untouched thread added,
  the newer record winning, spend from both sides, a delete not repeated, merging
  twice adding nothing new; the mark kept and cleared); a fleet test of a real
  split (the desktop, holding Duck, goes offline and writes on; the server takes
  over and writes too; the desktop comes back: the server has both sides, the
  shared thread forked, one notice, the mark gone). Live test owed: a split
  between the desktop and the laptop.)_

### Step F6.3 — Duck restarts without reloading the window
- **Depends on:** F6.1.
- **Why:** taking Duck over (`promote_here` → `duck-promoted`) reloads the whole main
  window, so Duck starts again on the installed copy. That resets everything else on
  the page too: the drawer, editors, panels, scroll positions. `b24c0cc` made consoles
  and shells reattach to their live PTYs after a reload, but the reload itself still
  happens on every move, on both machines.
- **What has to restart.** The backend already swapped `duck.db` under the same
  connection (`DuckDb::become_copy`), so it needs nothing. What's stale is what the
  page loaded from the old state in `initAssistant` (`src/assistant/index.ts`):
  - **Read from `duck.db`:** the thread store (`createThreadStore`), settings, the trust
    store, tasks, drawings, autopilots, routines, the decisions log, the waiting queue
    (`fleetTools.load`), kept read positions (`readAloud` pref), the consolidator's
    state, timings.
  - **Read from Duck's workspace (reset to the mirror's head):** reminders and timers,
    skills, memory, config.
  - **Built on those:** the engine, the endpoint (`epRef`), the policy gate, the
    delegate and trust watchers, the promoter, the replayer, the reminder clock,
    housekeeping, `tickRoutines`, the nightly tidy.
  - **Module globals pointing into them:** `consolidator`, `reminderAction`, `duck`'s
    local endpoint, `viewing`.
- **Build:**
  - **A shell and a core.** Split `initAssistant` in two.
    - **The shell** starts once and lives as long as the page: the fleet link and hub,
      `hosts` and the PC tools, the hosted MCP sync and browser host, the reader and
      announcer, desktop speech, the remote bridge, and the drawer's switch transport.
    - **The core** is everything in "What has to restart". `startCore(shell)` returns
      `{ endpoint, stop() }`.
    - The shell's callbacks that now close over `engineRef`/`epRef` read the current
      core instead.
  - **A scope for every side effect.** The core registers each Tauri `listen`,
    `setInterval`/`setTimeout`, store `subscribe`, `localPort.on…` and watcher start
    through one `Scope`, and `stop()` undoes them all. The factories that start their
    own timers or listeners take a `signal` or return a `dispose`. By the count today:
    - `engine.ts` (4)
    - `port.local.ts` (6, of which the core's registrations are the ones to scope)
    - `tasks.ts` (2)
    - `trust/watcher.ts` (2)
    - `autopilot.ts`, `reminders.ts`, `announce.ts`, `fleet.ts` (1 each)
    - `index.ts`'s own 6

    A leak here is a doubled reminder, routine or permission answer, so the scope is
    the step's main risk.
  - **Stopping the core.** It stops taking turns (as the drain does), waits for running
    turns up to 60 s, and aborts the rest. Then it disposes the scope and drops the
    globals. Worker PTYs and tasks are the backend's and keep running; the new core's
    `tasks.load()` finds them as a reload would.
  - **The swap.** On `duck-promoted`, the shell stops the core, starts a new one, and
    points the hub (`hub.setEndpoint`), the remote bridge's `duck`, and the switch
    transport's local side at the new endpoint. The drawer starts over the way it
    does on a switch (`onDuckSwitch`), and the phones re-sync as on a reconnect.
    Replaces `location.reload()` at `index.ts:1092`.
  - **Restart, not reload, for the rest.** A failed restart (the new core can't load)
    leaves Duck off with a notice in the drawer and a "start Duck" retry. It doesn't
    fall back to reloading the window.
- **Key files:** `src/assistant/index.ts` (the split), a new `src/assistant/scope.ts`,
  the factories above, `src/assistant/switchTransport.ts` (a `setLocal(t)` that
  resubscribes like `use` does), `src/assistant/remoteBridge.ts`.
- **Done when:**
  - A test starts the core, stops it, and starts it again on fakes. One registration
    of each listener and timer is left, and a reminder that comes due fires once.
  - A turn running at stop either finishes or is aborted with its notice.
  - Taking Duck over leaves the window as it was: consoles, editors and panels
    untouched, and only the drawer starts over, showing the new main's threads.
  - Live test owed: a handover and a failover between the desktop and the laptop.
    Neither window reloads (the consoles' scrollback isn't replayed, the drawer shows
    the moved threads), and a reminder fires once across the move.

## Phase F7 — Workbench on Linux (gate: the server exists)

_(Deferred, 2026-11-19: F1–F6 are built and merged into main; F7 and F8 wait
for later, with the server.)_

### Step F7.1 — The Fedora build
- **Depends on:** —
- **Build:**
  - **The port.** `cfg` gates or replacements for the Windows-only code: the keychain
    (Secret Service, or a `0600` credentials file or `systemd-creds` when headless),
    WebView2's flags (WebKitGTK's own), the PTY (`portable-pty` is already
    cross-platform), the tray, accelerators, `attention.rs`, `sys/`, voice capture, and
    media sessions (MPRIS, or nothing). Tools that only make sense on Windows (Steam's
    launcher, the media keys) aren't announced on Linux.
  - **Packaging.** An RPM from `tauri build`.
- **Done when:** the app builds and runs on Fedora, opens a session, and serves the
  phone. Live test owed until the server exists. A Fedora VM can stand in for it.

## Phase F8 — The server (gate: the server exists)

### Step F8.1 — The windowless instance
- **Depends on:** F7.1, F6.1.
- **Build:**
  - **The service.** Workbench as a systemd user service, under a headless Wayland
    compositor (`cage`, or `weston --backend=headless`) or Xvfb, with its webview never
    shown. The webview still owns the status and the engine, as everywhere else, so the
    code stays the same.
  - **Restarts.** Restart on failure; the renderer watchdog applies.
  - **The fallback route.** If WebKitGTK headless proves unreliable, Duck's engine moves
    to Node and the Rust core runs without Tauri. That's a large refactor, decided only
    if this step fails.
- **Done when:** the server reboots and comes back as a fleet member on its own, and is
  the main while the desktop is off.

### Step F8.2 — The server's own role
- **Depends on:** F8.1, F3.2.
- **Build:**
  - **Role and capabilities.** The server announces `always-on`, `research` and
    `no-code`.
  - **What Duck runs there.** Only research and thinking sessions (no project worktrees),
    in Duck's workspace. Coding work is routed to the desktop or the laptop, or queued
    for them.
  - **Voice.** STT and TTS models are installed if the CPU keeps up; otherwise the
    phone's audio is forwarded to a peer that has them.
- **Done when:** with the PC asleep, the phone sets a reminder and plays music; a
  research question becomes a server session; "fix X in workbench" is queued for the
  desktop and runs when it boots; a thread started on the phone continues in the
  desktop's drawer.

## Later

- **One sessions list for the whole fleet** on the phone, grouped by machine, as well as
  the picker.
- **The office showing several machines** (one floor per machine).
- **Moving a session's work between machines** (push the branch from one, pick it up on
  the other).

## Open questions

- The server's hardware: whether it can run Parakeet and Kokoro fast enough (F8.2).
- Whether the desktop's BIOS and NIC wake from S5 (F4.1).
