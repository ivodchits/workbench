// Duck's own settings (step W2): what the confirmation policy and the action tools
// read. Kept in the prefs store under `assistant`; surfaces change them over the
// protocol (`settings.set`), never by writing the pref themselves, so the engine's
// copy is always the one in force.

import { getPref, setPref } from "../ipc/prefs";
import { DUCK_PERMISSION_MODES, SESSION_MODELS } from "../util/models";

export interface DuckSettings {
  /** Ask before every prompt Duck sends to a session. Off = only consequential
   *  actions ask. */
  confirmPrompts: boolean;
  /** The model a session Duck starts for coding or other professional work runs
   *  on, unless the request names one. */
  codingModel: (typeof SESSION_MODELS)[number];
  /** Answer Claude Code permission prompts under the trust policy (T2). Off, every
   *  project is in shadow mode for them: decided and logged, left to the user.
   *  Off until the user has checked the replay. */
  answerSessionPrompts: boolean;
  /** The permission mode such a session starts in (step M4); null leaves the
   *  project's default. */
  codingPermissionMode: (typeof DUCK_PERMISSION_MODES)[number] | null;
}

export const DEFAULT_SETTINGS: DuckSettings = {
  confirmPrompts: false,
  codingModel: "opus",
  answerSessionPrompts: false,
  codingPermissionMode: null,
};

/** Keep only known keys with valid values, so a hand-edited pref can't break Duck. */
export function cleanSettings(raw: unknown): Partial<DuckSettings> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<DuckSettings> = {};
  if (typeof r.confirmPrompts === "boolean") out.confirmPrompts = r.confirmPrompts;
  if (typeof r.answerSessionPrompts === "boolean") out.answerSessionPrompts = r.answerSessionPrompts;
  if (SESSION_MODELS.includes(r.codingModel as DuckSettings["codingModel"]))
    out.codingModel = r.codingModel as DuckSettings["codingModel"];
  const mode = r.codingPermissionMode;
  if (mode === null || DUCK_PERMISSION_MODES.includes(mode as (typeof DUCK_PERMISSION_MODES)[number]))
    out.codingPermissionMode = mode as DuckSettings["codingPermissionMode"];
  return out;
}

export interface SettingsStore {
  get(): DuckSettings;
  set(patch: Partial<DuckSettings>): Promise<DuckSettings>;
}

/** The settings, loaded once at start. `persist` false keeps them in memory (tests). */
export async function loadSettings(persist = true): Promise<SettingsStore> {
  let current: DuckSettings = {
    ...DEFAULT_SETTINGS,
    ...(persist
      ? cleanSettings(await getPref("assistant", {}).catch(() => ({})))
      : {}),
  };
  return {
    get: () => current,
    async set(patch) {
      current = { ...current, ...cleanSettings(patch) };
      if (persist) await setPref("assistant", current);
      return current;
    },
  };
}
