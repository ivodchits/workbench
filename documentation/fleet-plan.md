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

### Step F5.2 — Duck's repo and files
- **Depends on:** F5.1.
- **Build:**
  - **Duck's repo.** The main commits as today and offers git bundles; replicas fetch
    and fast-forward. A replica never commits. The backup remote (L4) is unchanged.
  - **Files.** Attachments, drawings and files are fetched from their origin on demand
    and cached.
- **Done when:** memory written on the main is recalled by a replica after it becomes
  the main; an attachment made on the desktop opens in a thread on the laptop.

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

## Phase F7 — Workbench on Linux (gate: the server exists)

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
