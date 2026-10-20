# plugins.json reference

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "build",
      "label": "build",
      "controls": [
        { "type": "select", "id": "target", "label": "target", "options": ["installer", "portable"] },
        { "type": "checkbox", "id": "release", "label": "release", "on": "--release", "off": "" },
        { "type": "button", "action": "go" }
      ],
      "actions": [
        { "id": "go", "label": "build", "run": ["npm", "run", "build:{target}", "{release}"] },
        { "id": "dev", "label": "dev server", "run": ["npm", "run", "dev"], "long": true },
        {
          "id": "deploy",
          "label": "deploy",
          "run": ["pwsh", "-File", "{data}/scripts/deploy.ps1", "-Env", "{target}"],
          "confirm": "Deploy {target}?"
        }
      ]
    }
  ]
}
```

## The file

- `version`: always `1`.
- `plugins`: an array. Plugin ids are unique.
- Ids (plugins, controls, actions) start with a letter and hold only letters, digits,
  `-` and `_`. Unknown fields are errors.

## A plugin

- `id`, `label` (optional; the id is shown otherwise).
- `controls` (optional): the fields, in order.
- `actions`: at least one.

## Controls

- `select`: `id`, `label`?, `options` (strings, no repeats), `default`? (one of the
  options; the first otherwise).
- `text`: `id`, `label`?, `placeholder`?, `default`? (`""` otherwise), `pattern`? (a
  regular expression the value must match before any action runs).
- `checkbox`: `id`, `label`?, `default`? (`false`), `on` (its text when ticked; `"true"`
  otherwise), `off` (when not; `"false"` otherwise). An argument that is exactly
  `{id}` and comes out empty is dropped, so `"on": "--release", "off": ""` adds a flag
  or nothing.
- `button`: `action` (an action id of this plugin): places that action's button among
  the fields. Actions no button places come after the fields.
- A control's id can't be `root`, `data` or `branch`.

## Actions

- `id`, `label`? (the id otherwise).
- `run`: the argv, an array of strings. Never a shell string: `["npm", "run", "build"]`,
  not `["npm run build"]`.
- `cwd`?: the working directory, absolute or relative to the project root (the root
  otherwise).
- `env`?: `{ "NAME": "value" }`.
- `confirm`?: a question the user answers before it runs. Use it for anything that
  deploys, publishes, deletes or pushes.
- `long`?: `true` for something that runs until stopped (a dev server, a watcher).

## Placeholders

In `run`, `cwd`, `env` values and `confirm`:

- `{id}`: a field's value (a checkbox's `on` or `off` text).
- `{root}`: the project folder. `{data}`: the folder of the live plugins.json, where
  `scripts/` is. `{branch}`: the current git branch.
- `{{` and `}}` are literal braces. Any other `{…}` is an error.

## Safety rules (the file is refused otherwise)

- The program (`run[0]`) can't come from a field: only literal text, `{root}`, `{data}`
  and `{branch}`.
- A field's value can't go into an argument an interpreter reads as code
  (`cmd /c …`, `pwsh -Command …`, `bash -c …`, `node -e …`, `python -c …`, …). Put
  the logic in a script and pass the value as a script argument.
- A batch file (`npm` is `npm.cmd` on Windows) refuses field values holding any of
  `& | < > ^ ( ) % ! "`. Use a `pattern` on text fields to keep values plain.

## Scripts

- Live in `{data}/scripts/`; in the draft, in the draft folder's `scripts/`.
- Call a PowerShell script as `["pwsh", "-File", "{data}/scripts/x.ps1", ...]` (a
  `.ps1` as the program also works), a Node script as `["node", "{data}/scripts/x.mjs"]`.
- Scripts run with the action's `cwd` (the project root by default).
