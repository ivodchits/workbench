# Workbench

A cross-platform (Windows + Linux) desktop **cockpit for supervising multiple Claude Code
agents across multiple projects**, with light editing built in.

Workbench is a supervision/orchestration workbench — not an IDE. You register projects, spin
up one or more Claude Code agents per project, and watch a single screen that answers one
question at a glance: **where is my attention needed?** You can drop into a shell or edit a
file without leaving the app.

## Status

🏗️ **Phase 0 — spike.** Step 0.1 (scaffold) done: a themed Tauri 2 + React/TS + Vite
window titled "Workbench" with the planned repo layout in place. Next: the PTY↔webview
bridge (0.2).

### Develop

```sh
npm install          # one-time
npm run tauri:dev    # run the app
npm run tauri:build  # produce a bundle
```

## Documentation

- [**Design document**](documentation/claude-code-workbench-design.md) — architecture,
  data model, UI, and settled decisions.
- [**Development plan**](documentation/claude-code-workbench-development-plan.md) — the
  step-by-step build plan (each step sized for a single Claude Code pass).

## Stack (planned)

Tauri 2 (Rust core + system webview) · React/TS frontend · `dockview` panels ·
`portable-pty` ↔ `xterm.js` terminals · CodeMirror 6 editor · SQLite state ·
`axum` local hook server.
