// Duck's own settings (step W2): what the confirmation policy and the action tools
// read. Kept in the prefs store under `assistant`; surfaces change them over the
// protocol (`settings.set`), never by writing the pref themselves, so the engine's
// copy is always the one in force.

import { getPref, setPref } from "../ipc/prefs";
import { DEFAULT_ANNOUNCE, type AnnounceSettings, type SpeakWhen } from "./announce";
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
  /** A finished task's worker process is stopped after this many minutes idle (a
   *  follow-up resumes its session); 0 never. */
  workerIdleStopMinutes: number;
  /** A finished task is closed, and its session taken off the rail, after this many
   *  hours (its files and transcript stay); 0 never. */
  closeFinishedHours: number;
  /** How Duck announces news (step V5). */
  announce: AnnounceSettings;
  /** Duck's Do Not Disturb (V5): nothing is spoken until this moment (epoch ms);
   *  null is off. Set from the phone too (`dnd`). */
  dndUntil: number | null;
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
  workerIdleStopMinutes: 30,
  closeFinishedHours: 24,
  announce: DEFAULT_ANNOUNCE,
  dndUntil: null,
};

/** Do Not Disturb "until I turn it off". */
export const DND_FOREVER = 8.64e15;

/** The choices the settings offer for the two tidy-up waits. */
export const IDLE_STOP_CHOICES = [10, 30, 60, 180, 0] as const;
export const CLOSE_CHOICES = [4, 24, 72, 168, 0] as const;

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
  const whole = (v: unknown, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
  const idle = whole(r.workerIdleStopMinutes, 24 * 60);
  if (idle !== undefined) out.workerIdleStopMinutes = idle;
  const close = whole(r.closeFinishedHours, 24 * 90);
  if (close !== undefined) out.closeFinishedHours = close;
  if (r.dndUntil === null) out.dndUntil = null;
  else if (typeof r.dndUntil === "number" && r.dndUntil > 0) out.dndUntil = Math.min(r.dndUntil, DND_FOREVER);
  if (r.announce && typeof r.announce === "object") out.announce = cleanAnnounce(r.announce as Record<string, unknown>);
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

function cleanAnnounce(r: Record<string, unknown>): AnnounceSettings {
  const d = DEFAULT_ANNOUNCE;
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
  const when = (v: unknown, def: SpeakWhen): SpeakWhen => (v === "never" || v === "around" ? v : def);
  const sp = (r.speak && typeof r.speak === "object" ? r.speak : {}) as Record<string, unknown>;
  const q = (r.quietHours && typeof r.quietHours === "object" ? r.quietHours : {}) as Record<string, unknown>;
  return {
    speak: { info: when(sp.info, d.speak.info), report: when(sp.report, d.speak.report), needs_you: when(sp.needs_you, d.speak.needs_you) },
    waitForGap: bool(r.waitForGap, d.waitForGap),
    followFocus: bool(r.followFocus, d.followFocus),
    quietHours: {
      on: bool(q.on, d.quietHours.on),
      from: num(q.from, d.quietHours.from, 0, 24 * 60 - 1),
      to: num(q.to, d.quietHours.to, 0, 24 * 60 - 1),
    },
    fullScreenQuiet: bool(r.fullScreenQuiet, d.fullScreenQuiet),
    batchSeconds: num(r.batchSeconds, d.batchSeconds, 0, 600),
    repeatMinutes: num(r.repeatMinutes, d.repeatMinutes, 0, 240),
    aroundMinutes: num(r.aroundMinutes, d.aroundMinutes, 1, 60),
    pushWhenAway: bool(r.pushWhenAway, d.pushWhenAway),
  };
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
