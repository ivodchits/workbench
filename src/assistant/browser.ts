// Duck in your Firefox (step B2), over the bridge Claude Code already uses
// (`mcp-bridge-for-firefox`), which Duck hosts as its own process
// (`mcp_host.rs`). The bridge acts on one connected browser at a time, each
// Firefox profile with the add-on being one; this is the part that keeps each
// thread in its profile:
//
// - **Agent** is the default: the `claude-agent` profile, the one with the add-on
//   (X0). When a call needs it and it isn't connected (after a few seconds' grace:
//   the add-on reconnects to a bridge Duck has just started), Duck starts it
//   (`firefox.exe -P claude-agent --no-remote`) and waits for the add-on.
// - **Personal** is your everyday profile. A thread gets there only through
//   `use_personal_browser` (a card unless a rule or the site list allows it) or
//   the login card's "use my personal profile".
//
// `browsers_select` is Duck's, not the model's: before each call the host selects
// the thread's profile, so a page can't talk Duck into your personal browser.
// Calls are one at a time, since the selection is the bridge's.
//
// Snapshots are remembered per tab (ref → its line), so a click on a ref can be
// tiered by what the element is (`tools/mcpHost.ts`).

import type { HostedTool } from "../ipc/mcpHost";

export type Profile = "agent" | "personal";

export interface FirefoxSettings {
  /** The bridge's name in your Claude Code MCP config. */
  server: string;
  /** The Firefox profile Duck starts for the agent (`firefox.exe -P <it>`). */
  agentProfile: string;
  /** The agent's name or id as `browsers_list` shows it; empty: the connected
   *  browser that isn't the personal one. */
  agentBrowser: string;
  /** Your personal profile's name or id in `browsers_list`; empty: not set up. */
  personalBrowser: string;
  /** Sites `use_personal_browser` may use without asking (hosts; subdomains too). */
  personalSites: string[];
}

export const DEFAULT_FIREFOX: FirefoxSettings = {
  server: "firefox",
  agentProfile: "claude-agent",
  agentBrowser: "",
  personalBrowser: "",
  personalSites: [],
};

export interface ConnectedBrowser {
  name: string;
  id: string;
}

/** The browsers in `browsers_list`'s text ("- Firefox 2: id ae62b9aa, add-on …"). */
export function parseBrowsers(text: string): ConnectedBrowser[] {
  const out: ConnectedBrowser[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*]\s+(.+?):\s+id\s+([0-9a-f]+)\b/i.exec(line);
    if (m) out.push({ name: m[1].trim(), id: m[2].toLowerCase() });
  }
  return out;
}

const same = (b: ConnectedBrowser, want: string) => {
  const w = want.trim().toLowerCase();
  return !!w && (b.name.toLowerCase() === w || b.id.startsWith(w));
};

/** The connected browser that is `profile`, or null. */
export function findBrowser(
  list: readonly ConnectedBrowser[],
  profile: Profile,
  fx: FirefoxSettings,
): ConnectedBrowser | null {
  if (profile === "personal") return fx.personalBrowser ? (list.find((b) => same(b, fx.personalBrowser)) ?? null) : null;
  if (fx.agentBrowser) return list.find((b) => same(b, fx.agentBrowser)) ?? null;
  const notPersonal = list.filter((b) => !fx.personalBrowser || !same(b, fx.personalBrowser));
  const named = notPersonal.find((b) => b.name.toLowerCase().includes(fx.agentProfile.toLowerCase()));
  if (named) return named;
  // The add-on is only in the agent profile unless you named another: one
  // connected browser that isn't the personal one is the agent.
  return notPersonal.length === 1 ? notPersonal[0] : null;
}

/** An MCP `CallToolResult`, loosely. */
export interface McpCallResult {
  content?: { type?: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface BrowserDeps {
  call(server: string, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  startProfile(profile: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface BrowserHost {
  profileOf(threadId: string): Profile;
  setProfile(threadId: string, profile: Profile): void;
  /** Run a tool of the browser server for the thread, in its profile. */
  run(
    threadId: string,
    fx: FirefoxSettings,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ result: McpCallResult; profile: Profile }>;
  /** Whether `profile` is connected now (lists the browsers). */
  connected(fx: FirefoxSettings, profile: Profile): Promise<boolean>;
  /** The line the tab's latest snapshot gave this ref, if any. */
  refLine(tabId: unknown, ref: unknown): string | undefined;
}

/** How long the agent profile gets to connect after Duck starts it. */
export const START_WAIT_MS = 25_000;
/** A bridge Duck has just started sees no browser until the add-on reconnects
 *  (~5 s): wait this long before deciding the profile is closed. */
export const CONNECT_WAIT_MS = 8_000;
const POLL_MS = 1_500;
/** A selection is trusted this long before the browsers are listed again. */
const FRESH_MS = 20_000;
const MAX_TABS = 20;

export function textOf(r: McpCallResult | null | undefined): string {
  const parts = (r?.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text!);
  if (parts.length) return parts.join("\n");
  return r?.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "";
}

export function createBrowserHost(deps: BrowserDeps): BrowserHost {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const profiles = new Map<string, Profile>();
  const snapshots = new Map<string, Map<string, string>>();
  let selected: { id: string; profile: Profile; at: number } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function list(fx: FirefoxSettings): Promise<ConnectedBrowser[]> {
    const r = (await deps.call(fx.server, "browsers_list", {}, 15_000)) as McpCallResult;
    return parseBrowsers(textOf(r));
  }

  async function select(fx: FirefoxSettings, profile: Profile): Promise<void> {
    if (selected?.profile === profile && now() - selected.at < FRESH_MS) return;
    let b = findBrowser(await list(fx), profile, fx);
    const poll = async (ms: number) => {
      for (let waited = 0; !b && waited < ms; waited += POLL_MS) {
        await sleep(POLL_MS);
        b = findBrowser(await list(fx), profile, fx);
      }
    };
    if (!b && profile === "agent") await poll(CONNECT_WAIT_MS);
    if (!b && profile === "agent") {
      await deps.startProfile(fx.agentProfile);
      await poll(START_WAIT_MS);
      if (!b)
        throw new Error(
          `Duck started Firefox's "${fx.agentProfile}" profile, but its add-on didn't connect in ${START_WAIT_MS / 1000} s. Is the add-on installed there? (If the profile was already open, it may need a restart.)`,
        );
    }
    if (!b)
      throw new Error(
        fx.personalBrowser
          ? `Your personal profile ("${fx.personalBrowser}") isn't connected: open Firefox, and check the bridge add-on is installed there.`
          : "Your personal profile isn't set up for Duck: install the bridge add-on in it and name it in Duck's settings (skills → Firefox).",
      );
    if (selected?.id !== b.id) {
      const r = (await deps.call(fx.server, "browsers_select", { browser: b.id }, 15_000)) as McpCallResult;
      if (r?.isError) throw new Error(`selecting the ${profile} profile failed: ${textOf(r)}`);
    }
    selected = { id: b.id, profile, at: now() };
  }

  function remember(tabId: unknown, text: string) {
    const lines = new Map<string, string>();
    for (const line of text.split("\n")) {
      const m = /\b(r\d+)\b/.exec(line);
      if (m && !lines.has(m[1])) lines.set(m[1], line.trim().slice(0, 300));
    }
    const key = String(tabId);
    snapshots.delete(key);
    snapshots.set(key, lines);
    while (snapshots.size > MAX_TABS) snapshots.delete(snapshots.keys().next().value!);
  }

  return {
    profileOf: (threadId) => profiles.get(threadId) ?? "agent",
    setProfile(threadId, profile) {
      if (profile === "agent") profiles.delete(threadId);
      else profiles.set(threadId, profile);
    },
    run(threadId, fx, tool, args, timeoutMs) {
      const profile = profiles.get(threadId) ?? "agent";
      return serial(async () => {
        try {
          await select(fx, profile);
          const result = ((await deps.call(fx.server, tool, args, timeoutMs)) ?? {}) as McpCallResult;
          if (tool === "content_snapshot" && !result.isError) remember(args.tab_id, textOf(result));
          return { result, profile };
        } catch (e) {
          // The browser may have gone: list again next time.
          selected = null;
          throw e;
        }
      });
    },
    connected(fx, profile) {
      return serial(async () => !!findBrowser(await list(fx), profile, fx));
    },
    refLine(tabId, ref) {
      if (typeof ref !== "string") return undefined;
      return snapshots.get(String(tabId))?.get(ref);
    },
  };
}

/** The host of a URL or a bare site name, lowercase; null when it's neither. */
export function siteOf(v: string | undefined): string | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname || null;
  } catch {
    return null;
  }
}

/** Whether the settings let the personal profile be used for `site` unasked. */
export function personalAllowed(site: string | null, sites: readonly string[]): boolean {
  if (!site) return false;
  return sites.some((s) => {
    const h = siteOf(s);
    return !!h && (site === h || site.endsWith(`.${h}`));
  });
}

/** A hosted tool's description, trimmed for the API. */
export function hostedDescription(t: HostedTool): string {
  const d = (t.description ?? t.annotations?.title ?? t.name).trim();
  return d.length > 1_000 ? `${d.slice(0, 1_000)}…` : d;
}
