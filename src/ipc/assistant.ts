// Typed access to Duck's backend (step A1): the API key's presence in Windows
// Credential Manager, the loopback proxy the SDK talks to, and the usage ledger /
// monthly budget. The key itself never comes back to the webview: the proxy swaps it
// in for a per-launch token. Each metered call emits `assistant-usage`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
