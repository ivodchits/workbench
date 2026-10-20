---
name: plugins
description: Draft a Workbench project toolbar change (plugins.json and the scripts its actions call) in the draft folder Workbench gave this session. Use when the prompt starts with /workbench:plugins.
argument-hint: <what the toolbar should do>
---

# Drafting a Workbench toolbar

Workbench draws a toolbar for each project from a JSON file, `plugins.json`. Each
plugin is a group of fields and buttons; each button runs a command (an argv, never a
shell string) in a task panel. The user asked for this change:

$ARGUMENTS

You write a **draft**. Workbench shows the user a diff of your draft against the live
toolbar, and only their approval puts it live. So:

- Work only in the draft folder named in the prompt. It already holds a copy of the
  live `plugins.json` (if the project has one) and the scripts in `scripts/`. Edit
  those files in place, or create them.
- Never edit the live toolbar, and don't run the actions you add: the user runs them
  from the toolbar after approving.
- Read the project (its package.json, build files, existing scripts, README) to find
  the real commands. Don't guess a command you can check.
- Keep what is already in the file unless the request asks to change it.

## Steps

1. Read `reference.md` (next to this file) for the file format and its rules.
2. Read the draft folder's `plugins.json` and `scripts/`, and the parts of the project
   the request touches.
3. Write the new `plugins.json` (the whole file, `"version": 1`). Put anything longer
   than one command into a script in the draft's `scripts/` folder and call it as
   `{data}/scripts/<name>` (`{data}` is where the live file lives; the script goes
   there with it). Script names are plain file names: letters, digits, `.`, `_`, `-`.
4. Check the file is valid JSON and follows `reference.md`. A field's value must never
   be the program or go into an argument an interpreter reads as code; call a script
   instead.
5. Finish with a short summary: what you added or changed, and each new action's
   command. That ends your turn; Workbench takes it from there. If Workbench sends you
   problems it found in the draft, fix them in the draft and finish again.
