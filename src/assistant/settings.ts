// Duck's own settings (step W2): what the confirmation policy and the action tools
// read. Kept in the prefs store under `assistant`; surfaces change them over the
// protocol (`settings.set`), never by writing the pref themselves, so the engine's
// copy is always the one in force.

import { getPref, setPref } from "../ipc/prefs";
import { DUCK_PERMISSION_MODES, EFFORTS, SESSION_MODELS } from "../util/models";

/** A worker task's tier (step D1): how much model and effort it gets. */
export const TIERS = ["standard", "involved", "serious"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierSpec {
  model: (typeof SESSION_MODELS)[number];
  effort: (typeof EFFORTS)[number];
}

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
  /** Worker sessions running at once (step D1); more tasks wait for a free slot. */
  maxWorkers: number;
  /** Workers run headless (step D4): `claude -p` over stream-json, their console
   *  the transcript view. Off, each gets a terminal (D1). */
  headlessWorkers: boolean;
  /** Duck's workspace folder; null is the default (`~/repos/Duck`, `Duck.dev` in a
   *  dev build). */
  workspace: string | null;
  /** The model and effort of each tier. Data, so they can be retuned. */
  tiers: Record<Tier, TierSpec>;
  /** Summarize a session when it finishes a turn (step W3), and put the headline in
   *  the done alert instead of its last line. A Haiku call per alert. */
  summaryOnDone: boolean;
}

export const DEFAULT_TIERS: Record<Tier, TierSpec> = {
  standard: { model: "sonnet", effort: "medium" },
  involved: { model: "sonnet", effort: "high" },
  serious: { model: "opus", effort: "medium" },
};

export const DEFAULT_SETTINGS: DuckSettings = {
  confirmPrompts: false,
  codingModel: "opus",
  answerSessionPrompts: false,
  codingPermissionMode: null,
  maxWorkers: 3,
  headlessWorkers: true,
  workspace: null,
  tiers: DEFAULT_TIERS,
  summaryOnDone: false,
};

export const MAX_WORKERS = 5;

/** Keep only known keys with valid values, so a hand-edited pref can't break Duck. */
export function cleanSettings(raw: unknown): Partial<DuckSettings> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<DuckSettings> = {};
  if (typeof r.confirmPrompts === "boolean") out.confirmPrompts = r.confirmPrompts;
  if (typeof r.answerSessionPrompts === "boolean") out.answerSessionPrompts = r.answerSessionPrompts;
  if (typeof r.summaryOnDone === "boolean") out.summaryOnDone = r.summaryOnDone;
  if (typeof r.headlessWorkers === "boolean") out.headlessWorkers = r.headlessWorkers;
  if (SESSION_MODELS.includes(r.codingModel as DuckSettings["codingModel"]))
    out.codingModel = r.codingModel as DuckSettings["codingModel"];
  const mode = r.codingPermissionMode;
  if (mode === null || DUCK_PERMISSION_MODES.includes(mode as (typeof DUCK_PERMISSION_MODES)[number]))
    out.codingPermissionMode = mode as DuckSettings["codingPermissionMode"];
  if (typeof r.maxWorkers === "number" && Number.isInteger(r.maxWorkers))
    out.maxWorkers = Math.min(MAX_WORKERS, Math.max(1, r.maxWorkers));
  if (r.workspace === null) out.workspace = null;
  else if (typeof r.workspace === "string") out.workspace = r.workspace.trim() || null;
  if (r.tiers && typeof r.tiers === "object") {
    const t = r.tiers as Record<string, Partial<TierSpec> | undefined>;
    out.tiers = Object.fromEntries(
      TIERS.map((k) => {
        const m = t[k]?.model;
        const e = t[k]?.effort;
        return [
          k,
          {
            model: SESSION_MODELS.includes(m as TierSpec["model"]) ? m : DEFAULT_TIERS[k].model,
            effort: EFFORTS.includes(e as TierSpec["effort"]) ? e : DEFAULT_TIERS[k].effort,
          },
        ];
      }),
    ) as Record<Tier, TierSpec>;
  }
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
