// The hosted MCP servers' tools in the registry (step B2): at start and after
// every settings change, each opted-in server's list (cached by the backend, so
// nothing starts unless a server has never been listed) becomes Duck's
// `<server>__*` tools. "refresh" asks the server again, which starts it.
//
// The drawer's settings list the stdio servers in your Claude Code config with
// their state (`hosted` event): on or off, how many tools, running, the last error.

import type { HostableServer, HostedTools } from "../ipc/mcpHost";
import type { BrowserHost } from "./browser";
import type { HostedServerView } from "./protocol";
import type { DuckSettings } from "./settings";
import { hostedTools } from "./tools/mcpHost";
import type { Registry, ToolDef } from "./tools/registry";

export interface HostedDeps {
  registry: Pick<Registry, "setExternal">;
  settings: () => DuckSettings;
  listTools(server: string, refresh: boolean): Promise<HostedTools>;
  servers(): Promise<HostableServer[]>;
  running(): Promise<string[]>;
  refLine: BrowserHost["refLine"];
}

export interface HostedSync {
  /** Rebuild the registry's hosted tools; `refresh` asks that server again. */
  sync(refresh?: string): Promise<void>;
  view(): Promise<HostedServerView[]>;
}

export function createHostedSync(deps: HostedDeps): HostedSync {
  const state = new Map<string, { tools: number | null; error: string | null }>();
  let chain: Promise<void> = Promise.resolve();

  async function rebuild(refresh?: string) {
    const s = deps.settings();
    const defs: ToolDef[] = [];
    for (const name of s.mcpHost) {
      try {
        const r = await deps.listTools(name, name === refresh);
        const tools = hostedTools(name, r.tools, { isBrowser: name === s.firefox.server, refLine: deps.refLine });
        defs.push(...tools);
        state.set(name, { tools: tools.length, error: null });
      } catch (e) {
        state.set(name, { tools: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    deps.registry.setExternal(defs);
  }

  return {
    sync(refresh) {
      const next = chain.then(() => rebuild(refresh));
      chain = next.catch(() => {});
      return next;
    },
    async view() {
      const s = deps.settings();
      const [servers, running] = await Promise.all([deps.servers(), deps.running().catch(() => [] as string[])]);
      return servers.map((x) => ({
        name: x.name,
        command: x.command,
        on: s.mcpHost.includes(x.name),
        browser: x.name === s.firefox.server,
        running: running.includes(x.name),
        tools: state.get(x.name)?.tools ?? null,
        error: s.mcpHost.includes(x.name) ? (state.get(x.name)?.error ?? null) : null,
      }));
    },
  };
}
