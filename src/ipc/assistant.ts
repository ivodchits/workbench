// Typed access to Duck's backend (step A1): the API key's presence in Windows
// Credential Manager, the loopback proxy the SDK talks to, and the usage ledger /
// monthly budget. The key itself never comes back to the webview: the proxy swaps it
// in for a per-launch token. Each metered call emits `assistant-usage`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ReplayCall } from "../assistant/trust/replay";

export interface ProxyInfo {
  /** `http://127.0.0.1:<port>/anthropic`, the SDK's `baseURL`. */
  baseUrl: string;
  /** The per-launch token, the SDK's `apiKey`. */
  token: string;
}

export interface KeyStatus {
  present: boolean;
  /** The credential name (`duck/anthropic-api-key`, or `duck-dev/…` in a dev build). */
  target: string;
}

export interface Limits {
  hardCapUsd: number;
  /** The soft limit as a fraction of the cap. */
  softRatio: number;
}

export interface Bucket {
  key: string;
  calls: number;
  costUsd: number;
}

export interface Spend {
  todayUsd: number;
  monthUsd: number;
  byModel: Bucket[];
  byPurpose: Bucket[];
  limits: Limits;
  softReached: boolean;
  capReached: boolean;
}

export interface UsageRecord {
  ts: number;
  model: string;
  purpose: string;
  costUsd: number;
}

export const getProxyInfo = (): Promise<ProxyInfo> =>
  invoke("assistant_proxy_info");
export const getKeyStatus = (): Promise<KeyStatus> =>
  invoke("assistant_key_status");
export const setKey = (key: string): Promise<KeyStatus> =>
  invoke("assistant_key_set", { key });
export const clearKey = (): Promise<KeyStatus> => invoke("assistant_key_clear");
export const getSpend = (): Promise<Spend> => invoke("assistant_spend");
export const setBudget = (limits: Limits): Promise<Limits> =>
  invoke("assistant_budget_set", { limits });

// Threads (step A2), stored in duck.db. Messages are append-only: `seq` must be the
// thread's next, or the append is refused.

export interface ThreadRow {
  id: string;
  title: string;
  mode: string;
  created: number;
  updated: number;
}

/** `notice` is shown in the thread but never sent to the API. */
export type StoredRole = "user" | "assistant" | "system" | "notice";

export interface StoredMessage {
  threadId: string;
  seq: number;
  ts: number;
  role: StoredRole;
  /** API content blocks (or a notice's payload), as JSON. */
  content: unknown;
  /** Where the message came from: `desktop`, `phone`, `voice`, `duck`, … */
  source: string;
}

export interface PendingRow {
  id: string;
  threadId: string;
  created: number;
  data: unknown;
}

export const threadCreate = (id: string, mode: string): Promise<ThreadRow> =>
  invoke("assistant_thread_create", { id, mode });
export const threadList = (): Promise<ThreadRow[]> =>
  invoke("assistant_thread_list");
export const threadMessages = (threadId: string): Promise<StoredMessage[]> =>
  invoke("assistant_thread_messages", { threadId });
export const threadTitle = (threadId: string, title: string): Promise<void> =>
  invoke("assistant_thread_title", { threadId, title });
/** Delete a thread with its messages and parked batches (step A4). */
export const threadDelete = (threadId: string): Promise<void> =>
  invoke("assistant_thread_delete", { threadId });
export const messageAppend = (message: StoredMessage): Promise<void> =>
  invoke("assistant_message_append", { message });
export const pendingPut = (
  id: string,
  threadId: string,
  data: unknown,
): Promise<void> => invoke("assistant_pending_put", { id, threadId, data });
export const pendingList = (): Promise<PendingRow[]> =>
  invoke("assistant_pending_list");
export const pendingClear = (id: string): Promise<void> =>
  invoke("assistant_pending_clear", { id });

// Trust (step T1), stored in duck.db: the rules, each project's mode when it isn't
// `live`, the floor entries turned off, the kill switch, and the decision log.

export interface RuleRow {
  id: string;
  effect: "allow" | "ask" | "deny";
  pattern: string;
  /** null: global. */
  projectId: string | null;
  created: number;
}

export interface TrustStateRow {
  paused: boolean;
  rules: RuleRow[];
  modes: { projectId: string; mode: "off" | "shadow" | "live" }[];
  floorOff: string[];
  seeded: boolean;
}

export interface DecisionRow {
  id: number;
  ts: number;
  threadId: string;
  toolUseId: string;
  projectId: string | null;
  /** `assistant:<tool>`. */
  tool: string;
  /** The card's sentence, or the tool name. */
  summary: string;
  input: unknown;
  decision: "allow" | "ask" | "deny";
  layer: string;
  reason: string;
  ruleId: string | null;
  /** Logged only: the card showed anyway. */
  shadow: boolean;
  /** How a Claude Code prompt was answered (T4): the hook's decision or keys into
   *  its menu; null (or absent) when it wasn't answered. */
  answeredBy?: "hook" | "keys" | null;
}

export const trustLoad = (): Promise<TrustStateRow> => invoke("assistant_trust_load");
export const trustSeed = (rules: RuleRow[]): Promise<TrustStateRow> =>
  invoke("assistant_trust_seed", { rules });
export const trustPause = (paused: boolean): Promise<boolean> =>
  invoke("assistant_trust_pause", { paused });
export const ruleAdd = (rule: RuleRow): Promise<void> => invoke("assistant_rule_add", { rule });
export const ruleRemove = (id: string): Promise<void> => invoke("assistant_rule_remove", { id });
export const trustModeSet = (
  projectId: string,
  mode: "off" | "shadow" | null,
): Promise<void> => invoke("assistant_trust_mode_set", { projectId, mode });
export const floorSet = (id: string, enabled: boolean): Promise<string[]> =>
  invoke("assistant_floor_set", { id, enabled });
export const decisionAdd = (decision: DecisionRow): Promise<number> =>
  invoke("assistant_decision_add", { decision });
export const decisions = (before: number | null, limit: number): Promise<DecisionRow[]> =>
  invoke("assistant_decisions", { before, limit });

/** A session's mandate (step T2), as stored JSON; null removes it. */
export const mandateSet = (instanceId: string, mandate: string | null): Promise<void> =>
  invoke("assistant_mandate_set", { instanceId, mandate });
export const mandateGet = (instanceId: string): Promise<string | null> =>
  invoke("assistant_mandate_get", { instanceId });

/** A session's last summary (step W3), as stored JSON; null removes it. */
export const summarySet = (instanceId: string, summary: string | null): Promise<void> =>
  invoke("assistant_summary_set", { instanceId, summary });
export const summaryGet = (instanceId: string): Promise<string | null> =>
  invoke("assistant_summary_get", { instanceId });

/** The past `days`' Claude Code tool calls, for the trust replay (step T2). */
export const replayCalls = (days: number, max: number): Promise<ReplayCall[]> =>
  invoke("assistant_replay_calls", { days, max });

// ── worker sessions (step D1) ──

/** Make Duck's workspace (`dir`, else the default) and return its path. */
export const workspacePrepare = (dir: string | null): Promise<string> =>
  invoke("assistant_workspace_prepare", { dir });
/** A new task folder (`tasks/<date>-<slug>`) with its brief; returns the folder. */
export const taskFolder = (workspace: string, date: string, title: string, brief: string): Promise<string> =>
  invoke("assistant_task_folder", { workspace, date, title, brief });

export interface TaskResultFiles {
  json: string | null;
  /** When `result.json` was last written, epoch ms. */
  jsonModified: number | null;
  md: string | null;
}
export const taskResult = (workspace: string, folder: string): Promise<TaskResultFiles> =>
  invoke("assistant_task_result", { workspace, folder });
/** Write a task's `result.md` and `result.json` (the API worker's, step D2). */
export const taskWriteResult = (workspace: string, folder: string, md: string, json: string): Promise<void> =>
  invoke("assistant_task_write_result", { workspace, folder, md, json });

/** How a worker launches: its task folder, effort, and kind (`browser` keeps your
 *  MCP servers, `code` works in a project in its own mode). */
export interface WorkerSpec {
  workspace: string;
  folder: string;
  effort: string;
  kind: string;
}
export const workerRegister = (instanceId: string, spec: WorkerSpec): Promise<void> =>
  invoke("assistant_worker_register", { instanceId, spec });
export const taskPut = (id: string, data: string): Promise<void> => invoke("assistant_task_put", { id, data });
export const taskList = (limit: number): Promise<string[]> => invoke("assistant_task_list", { limit });

// Plan autopilot records (step P1), one per session.
export const autopilotPut = (instanceId: string, data: string): Promise<void> =>
  invoke("assistant_autopilot_put", { instanceId, data });
export const autopilotList = (): Promise<string[]> => invoke("assistant_autopilot_list");
export const autopilotDelete = (instanceId: string): Promise<void> =>
  invoke("assistant_autopilot_delete", { instanceId });

/** The kill switch flipped (from the tray, or any surface). */
export function onTrustPaused(cb: (paused: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("assistant-trust-paused", (event) => cb(event.payload));
}

export function onUsage(cb: (r: UsageRecord) => void): Promise<UnlistenFn> {
  return listen<UsageRecord>("assistant-usage", (event) => cb(event.payload));
}

/** A one-token streamed Haiku call through the proxy: checks the key, the token,
 *  CORS and the ledger end to end. Resolves to the error message on failure. */
export async function testCall(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const { baseUrl, token } = await getProxyInfo();
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": token,
        "x-wb-purpose": "test",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1,
        stream: true,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` };
    }
    // Drain the stream: the ledger row is written when it ends.
    await res.text();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** One JSON-RPC request to an external MCP server (step X1), made by the backend:
 *  its `result`, or a rejection with the error's text. `tokenEnv` names the
 *  environment variable that holds the server's bearer token, if it needs one. */
export const mcpRequest = (
  url: string,
  tokenEnv: string | null,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> =>
  invoke("assistant_mcp_request", { url, tokenEnv, method, params, timeoutMs });

/** The morning routine's Google access: whether it's connected and whether the
 *  OAuth client's secret is stored (`secretTarget` names the credential for
 *  `cmdkey`). Tokens never come back to the webview. */
export interface GoogleStatus {
  connected: boolean;
  secretStored: boolean;
  secretTarget: string;
}

export interface SheetCell {
  address: string;
  /** As the sheet shows it. */
  value: string;
  /** The formula, when the cell holds one. */
  formula?: string;
}

export interface SheetCells {
  name: string;
  modified?: string;
  cells: SheetCell[];
}

/** The cells, and where the local copy of the sheet went. */
export interface SheetExport extends SheetCells {
  csv: string;
  xlsx: string;
  sidecar: string;
}

export const googleStatus = (): Promise<GoogleStatus> => invoke("assistant_google_status");

/** Sign in to Google in the browser; resolves once the consent comes back. */
export const googleConnect = (clientId: string): Promise<GoogleStatus> =>
  invoke("assistant_google_connect", { clientId });

export const googleDisconnect = (): Promise<GoogleStatus> => invoke("assistant_google_disconnect");

export const sheetCells = (clientId: string, sheetId: string, tab: string, addresses: string[]): Promise<SheetCells> =>
  invoke("assistant_sheet_cells", { clientId, sheetId, tab, addresses });

export const sheetExport = (
  clientId: string,
  workspace: string,
  date: string,
  sheetId: string,
  tab: string,
  addresses: string[],
): Promise<SheetExport> => invoke("assistant_sheet_export", { clientId, workspace, date, sheetId, tab, addresses });

/** A copy of the invoice sheet Duck made (phase 3), with its configured cells. */
export interface SheetDraft {
  id: string;
  name: string;
  url: string;
  month: string;
  /** `copy` (Drive's copy) or `upload` (the xlsx export, converted). */
  how: string;
  created: number;
  cells: SheetCell[];
}

export interface CellValue {
  address: string;
  value: string;
}

/** Copy the sheet into the drafts folder and set `updates` in the copy; `expect` is
 *  the original's cells as the card showed them. */
export const sheetDraft = (
  clientId: string,
  sheetId: string,
  tab: string,
  folder: string,
  title: string,
  month: string,
  expect: CellValue[],
  updates: CellValue[],
): Promise<SheetDraft> =>
  invoke("assistant_sheet_draft", { clientId, sheetId, tab, folder, title, month, expect, updates });

/** This month's draft, read back; null when there is none in Drive. */
export const sheetDraftFind = (
  clientId: string,
  sheetId: string,
  tab: string,
  month: string,
  addresses: string[],
): Promise<SheetDraft | null> => invoke("assistant_sheet_draft_find", { clientId, sheetId, tab, month, addresses });
