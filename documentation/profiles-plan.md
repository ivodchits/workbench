# Claude Profiles — Development Plan

Some projects now run under a separate Claude account (the team one) rather than the
personal one. Workbench lets each project choose a **profile**: a Claude Code config
dir, passed to that project's consoles as `CLAUDE_CONFIG_DIR`.

Steps follow the main plan's format (`claude-code-workbench-development-plan.md`). The
main plan's Definition of Done applies.

---

## Settled decisions (2026-11-20)

1. **The mechanism is a config dir (`CLAUDE_CONFIG_DIR`).** Each profile has its own
   `.credentials.json`, logged in normally with `/login`, so every Claude Code feature
   works (connectors, Remote Control, `/schedule`). The token route
   (`CLAUDE_CODE_OAUTH_TOKEN`) was considered and rejected: under it those features
   don't work.
2. **Profiles are chosen per project.** Every console in a project uses the project's
   profile. A project with no profile uses **Personal**, the default profile. Personal
   is whatever `claude` uses without Workbench: `CLAUDE_CONFIG_DIR` from Workbench's
   own environment if set, else `~/.claude`.
3. **An existing dir can be adopted.** "Add profile" accepts a dir you already set up
   (for example `~/.claude-tinywizard`), and Workbench leaves its layout as it is.
4. **A new dir is seeded by copying from Personal**: `settings.json`, `CLAUDE.md`,
   `skills/`, `agents/`, `commands/`, `rules/`, `output-styles/`, `keybindings.json`,
   and the user `mcpServers` from `.claude.json`. Credentials, transcripts, history and
   `plugins/` are not copied. Plugin installs record absolute paths, so plugins are
   installed again inside the profile. After seeding, the two profiles change
   independently.
5. **Duck stays on Personal.** Its own brain, and the transcripts it scans for itself,
   use the Personal profile. **The usage-limit meter is per profile**, because each
   account has its own limits.
6. **Remote (ssh) projects ignore the profile.** The remote machine has its own config.
7. **Profiles are local to each machine.** They aren't replicated across the fleet,
   just like projects.

## Linked dirs: the case that shapes the code

`~/.claude-tinywizard` shares most of its contents with `~/.claude`:

```
.claude-tinywizard/
  .claude.json        own (MCP servers, account)        .credentials.json  own, after /login
  settings.json  ──symlink──▶  ~/.claude/settings.json
  skills/ plugins/ plans/ projects/  ──junction──▶  ~/.claude/…
```

So every per-profile path is **resolved through links before use**:

- **Writers resolve before they write.** The hook and statusline installers write
  through a temp file and a rename, which would replace a symlink with a plain file
  and quietly break the share. They write to the link's target instead, and handle
  each real `settings.json` once.
- **Readers de-duplicate.** Transcript scanning, the resume picker and skills work on
  the set of *distinct real* dirs, so a shared `projects/` isn't scanned twice.
- **Identity comes from the console, not the file.** A shared statusline script can't
  tell from its file alone which account it runs under. It sends
  `process.env.CLAUDE_CONFIG_DIR`, which Workbench sets on each console's process, and
  Workbench maps that dir back to a profile. Hook events are tied to a profile through
  their instance id (instance → project → profile).

## Phase P1 — Choosing a profile

### Step P1.1 — Profiles, the project setting, and the launch
- **Goal:** A project set to a profile launches its consoles under that account.
- **Depends on:** —
- **Build:**
  - **Data.** Migration: a `profiles` table (`id`, `name`, `config_dir`, `created_at`)
    and a nullable `projects.profile_id` (`ON DELETE SET NULL`).
  - **`profiles` module** (new). Personal (implicit, no row) and the stored profiles,
    each with its resolved config dir. It provides `config_dir_for_project`,
    `distinct_dirs()` (de-duplicated after resolving links) and
    `logged_in(dir)` (`.credentials.json` exists).
  - **Launch.** A local Claude spawn for a project with a profile sets
    `CLAUDE_CONFIG_DIR` to the profile's absolute dir. A shell or task console in that
    project gets it too, so a `claude` started by hand matches. Personal sets nothing.
  - **UI.** A "claude profile" picker in the project dialog (local projects only).
    "+ new profile…" takes a name and a folder; an existing folder is adopted as it
    is, and a missing one is created empty (seeding comes in step P2.1). The picker
    shows the dir and whether it's logged in. "forget" removes a profile: its
    projects go back to Personal and the dir stays on disk. *(Built that way: there
    is no separate Profiles menu yet. Renaming exists in the backend only.)*
  - **Logging in.** A profile that isn't logged in shows "Open a console to log in".
    The first `claude` launched in it shows Claude Code's own login.
- **Key files:** `src-tauri/src/profiles/` (new), `src-tauri/src/db/mod.rs`,
  `src-tauri/src/registry/mod.rs`, `src-tauri/src/pty/mod.rs`, `src/ipc/registry.ts`,
  `src/panels/InstanceManager/ProjectDialog.tsx`.
- **Done when:** A project set to tinywizard launches `claude`, and `/status` there
  shows the team account while other projects show Personal (**live test owed**).
  Unit tests cover: `dedupe_real` collapsing a junctioned dir, profile resolution
  and removal, adopting and creating dirs, and login detection.
- **Until P1.2, with tinywizard's linked layout:** hooks and the statusline already
  reach it through the shared `settings.json`. Hook-reported transcript paths under
  `.claude-tinywizard\projects` fail the path check, so the stream finds the file
  by session id through the junction instead. The usage meter shows whichever
  account rendered a statusline last.

### Step P1.2 — Hooks, statusline and transcripts in every profile
- **Goal:** A team-profile console gets live status, usage, transcripts and the resume
  picker, the same as a personal one.
- **Depends on:** P1.1
- **Build:**
  - **Install everywhere.** `hooks::init` and `statusline::install` run for every
    distinct real `settings.json`, after resolving links. Adding a profile installs
    into it. The dev build's exit cleanup uninstalls from all of them. The statusline
    script is written next to each real `settings.json`.
  - **Transcripts.** `claude_projects_dir()` becomes `projects_dirs()` (distinct).
    `resolve_transcript` searches all of them. `accept_hook_path` accepts a path under
    any of them. The resume picker lists the project's own profile's dir only.
  - **Usage limits per profile.** The statusline script POSTs `CLAUDE_CONFIG_DIR` along
    with the payload. `LimitsState` becomes a map from profile to limits, persisted per
    profile. The meter shows the focused project's profile, labelled when it isn't
    Personal.
- **Key files:** `src-tauri/src/hooks/{mod,install}.rs`, `src-tauri/src/statusline/mod.rs`,
  `src-tauri/src/transcript/{mod,stream}.rs`, the usage meter.
- **Done when:** In a separate (non-linked) profile, a console goes busy and idle, its
  transcript streams, and resume lists its sessions. Two accounts show two meters.
  Tests: installing through a symlinked `settings.json` keeps the symlink;
  `accept_hook_path` accepts a path in a second dir.

## Phase P2 — Profile contents

### Step P2.1 — Seeding a new profile
- **Goal:** "New profile" makes a dir that starts like Personal.
- **Depends on:** P1.1
- **Build:** The copy in decision 4. It goes into an empty dir only, never overwrites
  an existing file, and skips Workbench's own hook and statusline entries, because
  P1.2 installs fresh ones.
- **Key files:** `src-tauri/src/profiles/seed.rs` (new).
- **Done when:** Tests cover a seed from a fake Personal (files copied, credentials
  and transcripts not copied, MCP servers carried over) and a refusal to seed into a
  non-empty dir.

### Step P2.2 — MCP and Skills managers follow the project's profile
- **Goal:** The MCP and Skills managers show and edit the selected project's profile.
- **Depends on:** P1.1
- **Build:** User and local MCP scope read and write `<dir>/.claude.json` (Personal
  default: `~/.claude.json`). Every `claude mcp …` call gets the project's
  `CLAUDE_CONFIG_DIR`. User skills and plugin skills come from `<dir>/skills` and
  `<dir>/plugins`. Writes go through resolved links, so a shared `skills/` stays
  shared.
- **Key files:** `src-tauri/src/mcp/mod.rs`, `src-tauri/src/skills/mod.rs`.
- **Done when:** In a tinywizard project, the MCP manager lists tinywizard's own
  `mcpServers`, and the skills manager lists the shared skills once.

## Open questions

- Plugins in a seeded (not linked) profile: is installing them again inside the
  profile enough, or should seeding offer a junction for `plugins/` the way
  tinywizard does?
