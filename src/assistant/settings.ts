// Duck's own settings (step W2): what the confirmation policy and the action tools
// read. Kept in the prefs store under `assistant`; surfaces change them over the
// protocol (`settings.set`), never by writing the pref themselves, so the engine's
// copy is always the one in force.

import { getPref, setPref } from "../ipc/prefs";
import { DEFAULT_ANNOUNCE, type AnnounceSettings, type SpeakWhen } from "./announce";
import { DUCK_PERMISSION_MODES, EFFORTS, SESSION_MODELS } from "../util/models";
import { BRAIN_POLICIES, type BrainPolicy } from "./brain/policy";
import { DEFAULT_FIREFOX, siteOf, type FirefoxSettings } from "./browser";

/** A worker task's tier (step D1): how much model and effort it gets. */
export const TIERS = ["standard", "involved", "serious"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierSpec {
  model: (typeof SESSION_MODELS)[number];
  effort: (typeof EFFORTS)[number];
}

/** An external MCP server Duck may use (step X1), over Streamable HTTP. */
export interface McpServerSpec {
  /** What Duck calls it in `mcp_*` calls: lowercase, digits, `_` and `-`. */
  name: string;
  url: string;
  enabled: boolean;
  /** The environment variable holding its bearer token; null when it needs none.
   *  The token itself is never stored here. */
  tokenEnv: string | null;
  /** The tools that only read, which `mcp_read` runs without asking. Every other
   *  tool goes through `mcp_call`, a consequential call. */
  readTools: string[];
  /** One line on what it's for: the `<mcp_servers>` block's line for it, the only
   *  thing about a server every request carries (its tools are fetched by
   *  `mcp_tools` when a request needs them). Empty when there's none. */
  description: string;
  /** The server's tools this entry offers, when it's one part of a bigger server
   *  (Gmail of a Google Workspace server); null for all of them. */
  tools: string[] | null;
}

/** The user's Quest Log desktop app (calendar, agenda, notes): its embedded server
 *  on loopback, no token, up while the app is open and signed in. */
export const QUEST_LOG: McpServerSpec = {
  name: "quest_log",
  url: "http://127.0.0.1:7437/mcp",
  enabled: true,
  tokenEnv: null,
  description: "Quest Log: the user's calendar and agenda, tasks/quests (completing one awards XP/gold), notes and projects.",
  tools: null,
  readTools: [
    "get_agenda",
    "get_calendar_occurrences",
    "list_entries",
    "get_entry",
    "search",
    "list_notes",
    "get_note",
    "list_projects",
    "get_project_overview",
    "list_folders",
    "list_chains",
    "get_chain",
    "get_stats",
    "whoami",
  ],
};

/** Gmail, Drive and Docs, over one Google Workspace MCP server the user runs
 *  (`workspace-mcp`, github.com/taylorwilsdon/google_workspace_mcp) with their
 *  own OAuth client. The server does the Google sign-in, in the user's browser,
 *  and keeps the tokens: Duck never sees a credential. One entry per service, so
 *  each is turned on or off by itself; off until the user has the server running. */
export const GOOGLE_MCP_URL = "http://localhost:8000/mcp";
export const GOOGLE_MCP_COMMAND = "uvx workspace-mcp --transport streamable-http --tools gmail drive docs";

const google = (name: string, description: string, tools: string[], readTools: string[]): McpServerSpec => ({
  name,
  url: GOOGLE_MCP_URL,
  enabled: false,
  tokenEnv: null,
  description,
  tools,
  readTools,
});

export const GMAIL = google(
  "gmail",
  "The user's Gmail: search and read mail and threads, labels; draft and send.",
  [
    "search_gmail_messages",
    "get_gmail_message_content",
    "get_gmail_messages_content_batch",
    "get_gmail_attachment_content",
    "get_gmail_thread_content",
    "get_gmail_threads_content_batch",
    "list_gmail_labels",
    "list_gmail_filters",
    "send_gmail_message",
    "draft_gmail_message",
    "modify_gmail_message_labels",
    "batch_modify_gmail_message_labels",
    "manage_gmail_label",
    "manage_gmail_filter",
    "start_google_auth",
  ],
  [
    "search_gmail_messages",
    "get_gmail_message_content",
    "get_gmail_messages_content_batch",
    "get_gmail_attachment_content",
    "get_gmail_thread_content",
    "get_gmail_threads_content_batch",
    "list_gmail_labels",
    "list_gmail_filters",
  ],
);

export const GOOGLE_DRIVE = google(
  "google_drive",
  "The user's Google Drive: find, list and read files; create, copy, update and share them.",
  [
    "search_drive_files",
    "get_drive_file_content",
    "get_drive_file_download_url",
    "list_drive_items",
    "get_drive_file_permissions",
    "check_drive_file_public_access",
    "get_drive_shareable_link",
    "create_drive_file",
    "create_drive_folder",
    "import_to_google_doc",
    "import_to_google_slides",
    "import_to_google_sheets",
    "copy_drive_file",
    "update_drive_file",
    "manage_drive_access",
    "set_drive_file_permissions",
  ],
  [
    "search_drive_files",
    "get_drive_file_content",
    "get_drive_file_download_url",
    "list_drive_items",
    "get_drive_file_permissions",
    "check_drive_file_public_access",
  ],
);

export const GOOGLE_DOCS = google(
  "google_docs",
  "The user's Google Docs: find and read docs and their comments; create and edit them.",
  [
    "search_docs",
    "get_doc_content",
    "get_doc_as_markdown",
    "list_docs_in_folder",
    "list_document_comments",
    "inspect_doc_structure",
    "debug_table_structure",
    "create_doc",
    "modify_doc_text",
    "find_and_replace_doc",
    "insert_doc_elements",
    "insert_doc_image",
    "update_paragraph_style",
    "update_doc_headers_footers",
    "batch_update_doc",
    "create_table_with_data",
    "manage_doc_tab",
    "manage_document_comment",
    "export_doc_to_pdf",
  ],
  [
    "search_docs",
    "get_doc_content",
    "get_doc_as_markdown",
    "list_docs_in_folder",
    "list_document_comments",
    "inspect_doc_structure",
    "debug_table_structure",
  ],
);

export const GOOGLE_MCP_SERVERS = [GMAIL, GOOGLE_DRIVE, GOOGLE_DOCS];
/** The servers Duck knows: a saved one by these names without a description gets
 *  the known one's. */
const KNOWN_SERVERS = [QUEST_LOG, ...GOOGLE_MCP_SERVERS];

/** Duck's Google access (Drive and Sheets: the morning routine's invoice). The OAuth
 *  client's secret, if it has one, and the refresh token live in Credential
 *  Manager, never here. */
export interface GoogleSettings {
  /** The Desktop OAuth client id from the user's Google Cloud project. */
  clientId: string | null;
}

export const DEFAULT_GOOGLE: GoogleSettings = { clientId: null };

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
  /** A session's plan (step T3): Duck reviews it against the session's task and
   *  `show`s the review beside the plan, or `approve`s a plan that passes (with
   *  "Yes, manually approve edits") and shows the rest. */
  planApproval: "show" | "approve";
  /** Promotion offers taken or dismissed (step T3), `<projectId> <pattern>`. */
  settledPromotions: string[];
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
  /** The weekly housekeeping (step L4) deletes Duck threads with no activity for
   *  this many days ("Delete threads idle for"); 0 never. */
  deleteIdleThreadsDays: number;
  /** How Duck announces news (step V5). */
  announce: AnnounceSettings;
  /** Duck's Do Not Disturb (V5): nothing is spoken until this moment (epoch ms);
   *  null is off. Set from the phone too (`dnd`). */
  dndUntil: number | null;
  /** External MCP servers (step X1). */
  mcpServers: McpServerSpec[];
  /** The stdio servers from your Claude Code config Duck hosts (step B2), by
   *  name; each is opted in, so a new server isn't exposed by itself. */
  mcpHost: string[];
  /** Duck in your Firefox (B2): the bridge, the agent and personal profiles. */
  firefox: FirefoxSettings;
  /** Duck's skills turned off in the settings (step S2), by name. */
  disabledSkills: string[];
  /** A thread whose request has grown past this many input tokens is compacted
   *  once its turn is over (step A6); 0 never. */
  compactAt: number;
  /** Google access (Drive and Sheets). */
  google: GoogleSettings;
  /** Which brain answers (step M3): `auto` moves to the subscription when the API
   *  credits run low and back when they allow; `api` / `subscription` pin one. */
  brainPolicy: BrainPolicy;
  /** The built-in modes whose threads think on your subscription (step D3, an
   *  experiment): `chat`, `duck`. Your own modes say so in their skill. */
  sessionModes: string[];
  /** The model those threads think on. */
  sessionModel: "sonnet" | "opus";
  /** Where the user lives, as a place name ("Lisbon", "Portland, Oregon"): the
   *  weather's place when none is named (step H2); null unset. */
  home: string | null;
  /** The general reminders come up on your first message after this many minutes
   *  without one (step H8), as well as in a new thread. */
  reminderSpellMinutes: number;
  /** Duck reads a message's attachments itself up to about this many tokens (step
   *  G1); the rest are referenced, for a worker. */
  attachmentTokens: number;
  /** The image model `generate_image` uses (step G6). */
  imageModel: (typeof IMAGE_MODELS)[number];
  /** Images this month up to this many USD at list price run unasked; past it,
   *  each request asks (step G6). */
  imageCapUsd: number;
}

/** The Gemini image models Duck offers (step G6), the default first. */
export const IMAGE_MODELS = ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3-pro-image"] as const;

export const DEFAULT_TIERS: Record<Tier, TierSpec> = {
  standard: { model: "sonnet", effort: "medium" },
  involved: { model: "sonnet", effort: "high" },
  serious: { model: "opus", effort: "medium" },
};

export const DEFAULT_SETTINGS: DuckSettings = {
  confirmPrompts: false,
  codingModel: "opus",
  answerSessionPrompts: false,
  planApproval: "show",
  settledPromotions: [],
  codingPermissionMode: null,
  maxWorkers: 3,
  headlessWorkers: true,
  workspace: null,
  tiers: DEFAULT_TIERS,
  summaryOnDone: false,
  workerIdleStopMinutes: 30,
  closeFinishedHours: 24,
  deleteIdleThreadsDays: 7,
  announce: DEFAULT_ANNOUNCE,
  dndUntil: null,
  mcpServers: [QUEST_LOG, ...GOOGLE_MCP_SERVERS],
  mcpHost: [],
  firefox: DEFAULT_FIREFOX,
  disabledSkills: [],
  compactAt: 100_000,
  google: DEFAULT_GOOGLE,
  brainPolicy: "auto",
  sessionModes: [],
  sessionModel: "sonnet",
  home: null,
  reminderSpellMinutes: 30,
  attachmentTokens: 20_000,
  imageModel: "gemini-nano-banana-2.1",
  imageCapUsd: 10,
};

/** Do Not Disturb "until I turn it off". */
export const DND_FOREVER = 8.64e15;

/** The choices the settings offer for the two tidy-up waits. */
export const IDLE_STOP_CHOICES = [10, 30, 60, 180, 0] as const;
export const CLOSE_CHOICES = [4, 24, 72, 168, 0] as const;
/** The choices for deleting idle threads (step L4), in days; 0 never. */
export const DELETE_IDLE_CHOICES = [7, 14, 30, 90, 0] as const;

export const MAX_WORKERS = 5;

/** The thresholds the settings offer for compacting a thread (step A6). */
export const COMPACT_CHOICES = [60_000, 100_000, 150_000, 0] as const;
/** The lowest threshold a hand-edited pref may set: below it, a thread would be
 *  compacted every few turns. */
export const COMPACT_MIN = 20_000;

/** Keep only known keys with valid values, so a hand-edited pref can't break Duck. */
export function cleanSettings(raw: unknown): Partial<DuckSettings> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<DuckSettings> = {};
  if (typeof r.confirmPrompts === "boolean") out.confirmPrompts = r.confirmPrompts;
  if (typeof r.answerSessionPrompts === "boolean") out.answerSessionPrompts = r.answerSessionPrompts;
  if (r.planApproval === "show" || r.planApproval === "approve") out.planApproval = r.planApproval;
  if (Array.isArray(r.settledPromotions))
    out.settledPromotions = [...new Set(r.settledPromotions.filter((k): k is string => typeof k === "string" && k.length <= 600))].slice(-500);
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
  const idleDays = whole(r.deleteIdleThreadsDays, 3650);
  if (idleDays !== undefined) out.deleteIdleThreadsDays = idleDays;
  if (r.dndUntil === null) out.dndUntil = null;
  else if (typeof r.dndUntil === "number" && r.dndUntil > 0) out.dndUntil = Math.min(r.dndUntil, DND_FOREVER);
  if (r.announce && typeof r.announce === "object") out.announce = cleanAnnounce(r.announce as Record<string, unknown>);
  if (r.workspace === null) out.workspace = null;
  else if (typeof r.workspace === "string") out.workspace = r.workspace.trim() || null;
  if (Array.isArray(r.mcpServers)) out.mcpServers = cleanMcpServers(r.mcpServers);
  if (Array.isArray(r.mcpHost))
    out.mcpHost = [...new Set(r.mcpHost.filter((n): n is string => typeof n === "string" && HOSTED_NAME.test(n)))].slice(0, 20);
  if (r.firefox && typeof r.firefox === "object") out.firefox = cleanFirefox(r.firefox as Record<string, unknown>);
  if (Array.isArray(r.disabledSkills))
    out.disabledSkills = [...new Set(r.disabledSkills.filter((n): n is string => typeof n === "string" && n.length <= 64))].slice(0, 200);
  const compact = whole(r.compactAt, 900_000);
  if (compact !== undefined) out.compactAt = compact === 0 ? 0 : Math.max(COMPACT_MIN, compact);
  if (BRAIN_POLICIES.includes(r.brainPolicy as BrainPolicy)) out.brainPolicy = r.brainPolicy as BrainPolicy;
  if (Array.isArray(r.sessionModes))
    out.sessionModes = [...new Set(r.sessionModes.filter((m): m is string => m === "chat" || m === "duck"))];
  if (r.sessionModel === "sonnet" || r.sessionModel === "opus") out.sessionModel = r.sessionModel;
  const spell = whole(r.reminderSpellMinutes, 24 * 60);
  if (spell !== undefined) out.reminderSpellMinutes = Math.max(5, spell);
  const reads = whole(r.attachmentTokens, 150_000);
  if (reads !== undefined) out.attachmentTokens = reads;
  if (IMAGE_MODELS.includes(r.imageModel as DuckSettings["imageModel"])) out.imageModel = r.imageModel as DuckSettings["imageModel"];
  if (typeof r.imageCapUsd === "number" && Number.isFinite(r.imageCapUsd) && r.imageCapUsd >= 0 && r.imageCapUsd <= 1000)
    out.imageCapUsd = r.imageCapUsd;
  if (r.home === null) out.home = null;
  else if (typeof r.home === "string") out.home = r.home.trim().slice(0, 100) || null;
  if (r.google && typeof r.google === "object") out.google = cleanGoogle(r.google as Record<string, unknown>);
  // The branch's first build kept the client id under `morning`.
  else if (r.morning && typeof r.morning === "object")
    out.google = cleanGoogle({ clientId: (r.morning as Record<string, unknown>).googleClientId });
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

const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** A server's line in the `<mcp_servers>` block stays one short line. */
const MCP_DESCRIPTION_MAX = 160;

/** Servers with a valid name (unique) and an http(s) URL; the rest are dropped. */
export function cleanMcpServers(raw: unknown[]): McpServerSpec[] {
  const out: McpServerSpec[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!MCP_NAME.test(name) || out.some((s) => s.name === name)) continue;
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
    const env = typeof r.tokenEnv === "string" ? r.tokenEnv.trim() : "";
    const known = KNOWN_SERVERS.find((s) => s.name === name);
    const names = (v: unknown) =>
      Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string" && TOOL_NAME.test(t)))] : [];
    out.push({
      name,
      url,
      enabled: r.enabled !== false,
      tokenEnv: ENV_NAME.test(env) ? env : null,
      readTools: names(r.readTools),
      description:
        typeof r.description === "string"
          ? r.description.replace(/\s+/g, " ").trim().slice(0, MCP_DESCRIPTION_MAX)
          : (known?.description ?? ""),
      tools: r.tools === null ? null : Array.isArray(r.tools) ? names(r.tools) : (known?.tools ?? null),
    });
  }
  return out;
}

/** A server's name in your Claude Code config. */
const HOSTED_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PROFILE_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

function cleanFirefox(r: Record<string, unknown>): FirefoxSettings {
  const text = (v: unknown, ok: (s: string) => boolean, d: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && ok(s) ? s : d;
  };
  const sites = Array.isArray(r.personalSites)
    ? [...new Set(r.personalSites.filter((x): x is string => typeof x === "string").map((x) => siteOf(x)).filter((x): x is string => !!x))]
    : [];
  return {
    server: text(r.server, (s) => HOSTED_NAME.test(s), DEFAULT_FIREFOX.server),
    agentProfile: text(r.agentProfile, (s) => PROFILE_NAME.test(s), DEFAULT_FIREFOX.agentProfile),
    agentBrowser: text(r.agentBrowser, (s) => s.length <= 64, ""),
    personalBrowser: text(r.personalBrowser, (s) => s.length <= 64, ""),
    personalSites: sites.slice(0, 100),
  };
}

const CLIENT_ID = /^[A-Za-z0-9._-]{8,200}$/;
const SHEET_ID = /^[A-Za-z0-9_-]{20,128}$/;
const CELL = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/;

/** A sheet id, or the id out of a pasted docs.google.com URL. */
export function sheetIdOf(v: string): string | null {
  const s = v.trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? s;
  return SHEET_ID.test(id) ? id : null;
}

/** An A1 cell address, uppercase without `$`; null when it isn't one cell. */
export function cellOf(v: string): string | null {
  const m = CELL.exec(v.trim().toUpperCase());
  return m ? `${m[1]}${m[2]}` : null;
}

export function cleanGoogle(r: Record<string, unknown>): GoogleSettings {
  const id = typeof r.clientId === "string" ? r.clientId.trim() : "";
  return { clientId: CLIENT_ID.test(id) ? id : null };
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
