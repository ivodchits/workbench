# Transcript and hook fixtures (step T0)

Real output from **Claude Code 2.1.296** (Sonnet 5.5, Windows), captured on 2026-10-13 by
driving one interactive TUI session in a PTY with `--permission-mode default`. Findings
are written up in `documentation/workbench-improvement-plan.md` under T0 **As built**.

## Files

- `NN-*.jsonl` — one scenario each, cut from a single session transcript at prompt
  boundaries. Concatenating `01` … `15` in order reproduces that session's file line for
  line, so they double as a "long session" fixture.
- `11-subagent.sidechain.jsonl` + `.meta.json` — the subagent's own transcript. On disk it
  lives at `<session-id>/subagents/agent-<agentId>.jsonl`, next to the session file.
- `16-clear-new-session.jsonl` — the **new** transcript file that `/clear` started (new
  session id). `/compact` (`15`) stays in the same file.
- `hooks/hook-events.jsonl` — every hook payload of the same session in arrival order,
  as `{ "t": <seconds since the first event>, "payload": <verbatim body> }`.

## Sanitizing

- Paths: the working directory is rewritten to `C:\Users\dev\proj`, the user name to `dev`.
- Bulky or machine-specific `attachment` lines (`prompt_snapshot`, `skill_listing`,
  `mcp_instructions_delta`, `deferred_tools_delta`, `agent_listing_delta`,
  `session_context`, `credential_org`, `environment`, `remote_session_change`, `model`,
  `plan_mode`) keep their envelope, but the body is `{ "type", "redacted": "<n> bytes" }`.
- The `/context` output in `13` is clipped to 400 characters.
- Everything else is verbatim, including the `hook_success` attachment lines (one per
  hook per event — a real Workbench session has these too).
