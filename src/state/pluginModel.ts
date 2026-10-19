// The project toolbar's view of a plugin (step K1), as pure functions: the order
// its fields and buttons are drawn in, the value a field shows, whether a text
// field's value lets the actions run, and the text a confirm question shows. The
// backend repeats every check before it spawns anything; these only draw.

import type { Control, Plugin, PluginAction } from "../ipc/plugins";

/** A stored field value: text for a select or text field, a flag for a checkbox. */
export type FieldValue = string | boolean;

/** One thing in a plugin's group, in drawing order. */
export type Item = { kind: "field"; control: Exclude<Control, { type: "button" }> } | { kind: "action"; action: PluginAction };

/** The fields in file order, a `button` standing in for its action, then every
 *  action no button placed. */
export function itemsOf(plugin: Plugin): Item[] {
  const byId = new Map(plugin.actions.map((a) => [a.id, a]));
  const placed = new Set<string>();
  const items: Item[] = [];
  for (const c of plugin.controls) {
    if (c.type === "button") {
      const action = byId.get(c.action);
      if (action && !placed.has(action.id)) {
        placed.add(action.id);
        items.push({ kind: "action", action });
      }
    } else {
      items.push({ kind: "field", control: c });
    }
  }
  for (const a of plugin.actions) if (!placed.has(a.id)) items.push({ kind: "action", action: a });
  return items;
}

/** What a field shows: the stored value when it still fits the field, else the
 *  file's default (a select whose option went away falls back, like the backend). */
export function fieldValue(control: Exclude<Control, { type: "button" }>, stored: FieldValue | undefined): FieldValue {
  switch (control.type) {
    case "select":
      return typeof stored === "string" && control.options.includes(stored) ? stored : control.default;
    case "text":
      return typeof stored === "string" ? stored : control.default;
    case "checkbox":
      return typeof stored === "boolean" ? stored : control.default;
  }
}

/** Whether a text field's value lets the actions run. A pattern JavaScript can't
 *  read (the backend accepted it) is left to the backend to judge. */
export function patternOk(pattern: string | null, value: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/** The values to send for a run: every field, a checkbox's as "true"/"false". */
export function runValues(plugin: Plugin, stored: Record<string, FieldValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of plugin.controls) {
    if (c.type === "button") continue;
    out[c.id] = String(fieldValue(c, stored[c.id]));
  }
  return out;
}

/** The text fields whose value keeps the plugin's actions from running. */
export function blockingFields(plugin: Plugin, stored: Record<string, FieldValue>): string[] {
  const out: string[] = [];
  for (const c of plugin.controls) {
    if (c.type !== "text") continue;
    if (!patternOk(c.pattern, String(fieldValue(c, stored[c.id])))) out.push(c.label ?? c.id);
  }
  return out;
}

/** Fill a template's `{id}` placeholders for display, with the same reading as the
 *  backend: only `{` + an id + `}` is a placeholder, `{{`/`}}` are literal braces,
 *  and anything unknown stays as written. A checkbox shows its on/off text. */
export function fillForDisplay(template: string, plugin: Plugin, stored: Record<string, FieldValue>): string {
  const shown = new Map<string, string>();
  for (const c of plugin.controls) {
    if (c.type === "button") continue;
    const v = fieldValue(c, stored[c.id]);
    shown.set(c.id, c.type === "checkbox" ? (v ? c.on : c.off) : String(v));
  }
  return template.replace(/\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (m, name: string | undefined) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    return name !== undefined && shown.has(name) ? shown.get(name)! : m;
  });
}

/** The task panel id for an action: one per action, so running it again reuses the
 *  panel (and is also the PTY's key). */
export function taskIdFor(projectId: string, pluginId: string, actionId: string): string {
  return `task:${projectId}:${pluginId}:${actionId}`;
}

/** The action's name in the palette and on its task panel. */
export function actionTitle(plugin: Plugin, action: PluginAction): string {
  return `${plugin.label ?? plugin.id}: ${action.label}`;
}
