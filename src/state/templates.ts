// Prompt templates (step 3.4) — reusable prompts with positional `{0}`/`{1}`
// fill-ins, saved per-project or globally and inserted into any live console
// (design §7 prompt template library).
//
// Scope mirrors the design: a template is either **global** (available in every
// project) or **project** (only while that project is active). Scope is implied by
// where the template is stored — global templates under the `templates:global`
// key, a project's under `templates:<projectId>` — but each template also carries
// its `scope` so the merged on-screen list can route an edit/delete back to the
// right bucket.
//
// Persistence reuses the `layouts` key-value table (via `ipc/layout`), exactly as
// layout presets do (see `state/presets`), so no backend/schema change is needed.

import { useSyncExternalStore } from "react";
import { getLayout, setLayout } from "../ipc/layout";
import { getActiveProject } from "./activeProject";

export type TemplateScope = "global" | "project";

export interface PromptTemplate {
  id: string;
  name: string;
  /** The prompt body; may contain positional placeholders `{0}`, `{1}`, … */
  body: string;
  scope: TemplateScope;
}

interface TemplatesFile {
  version: number;
  templates: PromptTemplate[];
}

/** Bump if the on-disk templates blob shape changes incompatibly. */
const FILE_VERSION = 1;
const GLOBAL_KEY = "templates:global";
const projectKey = (projectId: string) => `templates:${projectId}`;

// --- placeholder helpers (pure) ---------------------------------------------

const PLACEHOLDER_RE = /\{(\d+)\}/g;

/** The distinct placeholder indices in `body`, ascending (e.g. "{1} {0} {1}" →
 *  [0, 1]). Drives the fill-in form: one field per index, in order. */
export function extractPlaceholders(body: string): number[] {
  const found = new Set<number>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** Substitute `{n}` with `values[n]` (missing values become empty strings). A
 *  literal `{n}` survives only if it was never a declared placeholder — every
 *  `{digits}` is replaced, so escaping isn't supported (positional fill is the
 *  whole feature; bodies needing literal braces use the console directly). */
export function fillTemplate(body: string, values: Record<number, string>): string {
  return body.replace(PLACEHOLDER_RE, (_, d: string) => values[Number(d)] ?? "");
}

// --- reactive store ---------------------------------------------------------
// Holds the global set (project-independent) plus the active project's set. The
// UI shows them merged/grouped; mutations target a bucket by the template's scope.

interface TemplatesState {
  /** The project whose templates are loaded (null = none / global-only). */
  projectId: string | null;
  global: PromptTemplate[];
  project: PromptTemplate[];
}

let state: TemplatesState = { projectId: null, global: [], project: [] };
const listeners = new Set<() => void>();

function emit(next: TemplatesState): void {
  state = next;
  for (const l of listeners) l();
}

async function readBucket(key: string, scope: TemplateScope): Promise<PromptTemplate[]> {
  let raw: string | null;
  try {
    raw = await getLayout(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TemplatesFile;
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.templates)) return [];
    return parsed.templates
      .filter(
        (t): t is PromptTemplate =>
          !!t && typeof t.id === "string" && typeof t.name === "string" && typeof t.body === "string",
      )
      // Normalize scope to the bucket we read it from — the key is authoritative.
      .map((t) => ({ ...t, scope }));
  } catch {
    return []; // corrupt blob — start this bucket empty
  }
}

async function persistBucket(
  projectId: string | null,
  scope: TemplateScope,
  templates: PromptTemplate[],
): Promise<void> {
  const key = scope === "global" ? GLOBAL_KEY : projectId ? projectKey(projectId) : null;
  if (!key) return;
  const file: TemplatesFile = { version: FILE_VERSION, templates };
  await setLayout(key, JSON.stringify(file)).catch(() => {
    // Best-effort: a failed write just means this edit isn't durable; the
    // in-memory store still reflects it for the session.
  });
}

/**
 * Load the global set plus `projectId`'s set into the store. Called when the
 * active project changes; a stale load (the active project moved on while we
 * awaited) is discarded so it can't clobber the store.
 */
export async function loadTemplatesFor(projectId: string | null): Promise<void> {
  const [global, project] = await Promise.all([
    readBucket(GLOBAL_KEY, "global"),
    projectId ? readBucket(projectKey(projectId), "project") : Promise.resolve([]),
  ]);
  if (getActiveProject() !== projectId) return; // superseded by a later switch
  emit({ projectId, global, project });
}

// Local id generator — templates are machine-local, so a timestamp + counter
// suffix is unique enough without a uuid dependency. (`Date.now()` is fine: this
// runs only in response to a user action, never during workflow replay.)
let seq = 0;
function newId(): string {
  return `t${Date.now().toString(36)}${(seq++).toString(36)}`;
}

function bucket(scope: TemplateScope): PromptTemplate[] {
  return scope === "global" ? state.global : state.project;
}

function setBucket(scope: TemplateScope, templates: PromptTemplate[]): void {
  emit(scope === "global" ? { ...state, global: templates } : { ...state, project: templates });
}

export interface NewTemplate {
  name: string;
  body: string;
  scope: TemplateScope;
}

/** Create a template in its scope's bucket. Project scope requires an active
 *  project; without one it falls back to global. Returns the created template. */
export async function saveTemplate(input: NewTemplate): Promise<PromptTemplate | null> {
  let scope = input.scope;
  if (scope === "project" && !state.projectId) scope = "global";
  const existing = bucket(scope);
  const template: PromptTemplate = {
    id: newId(),
    name: input.name.trim() || `template ${existing.length + 1}`,
    body: input.body,
    scope,
  };
  const next = [...existing, template];
  setBucket(scope, next);
  await persistBucket(state.projectId, scope, next);
  return template;
}

export interface TemplatePatch {
  name?: string;
  body?: string;
  scope?: TemplateScope;
}

/** Update a template; if `scope` changes, move it between buckets (e.g. promote a
 *  project template to global). A project→global... move with no active project is
 *  fine; global→project without one is ignored (nowhere to put it). */
export async function updateTemplate(id: string, patch: TemplatePatch): Promise<void> {
  const current =
    state.global.find((t) => t.id === id) ?? state.project.find((t) => t.id === id) ?? null;
  if (!current) return;

  const nextScope = patch.scope ?? current.scope;
  if (nextScope === "project" && !state.projectId) return; // no bucket to hold it

  const updated: PromptTemplate = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
    body: patch.body !== undefined ? patch.body : current.body,
    scope: nextScope,
  };

  if (nextScope === current.scope) {
    const next = bucket(current.scope).map((t) => (t.id === id ? updated : t));
    setBucket(current.scope, next);
    await persistBucket(state.projectId, current.scope, next);
    return;
  }

  // Scope changed — remove from the old bucket, add to the new one, persist both.
  const fromList = bucket(current.scope).filter((t) => t.id !== id);
  const toList = [...bucket(nextScope), updated];
  emit(
    current.scope === "global"
      ? { ...state, global: fromList, project: toList }
      : { ...state, global: toList, project: fromList },
  );
  await Promise.all([
    persistBucket(state.projectId, current.scope, fromList),
    persistBucket(state.projectId, nextScope, toList),
  ]);
}

/** Delete a template from whichever bucket holds it. */
export async function deleteTemplate(id: string): Promise<void> {
  const scope: TemplateScope | null = state.global.some((t) => t.id === id)
    ? "global"
    : state.project.some((t) => t.id === id)
      ? "project"
      : null;
  if (!scope) return;
  const next = bucket(scope).filter((t) => t.id !== id);
  setBucket(scope, next);
  await persistBucket(state.projectId, scope, next);
}

// --- React binding ----------------------------------------------------------

/** Subscribe a component to the templates store. */
export function useTemplates(): TemplatesState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
