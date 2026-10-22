import { describe, expect, it } from "vitest";

import { DEFAULT_FIREFOX } from "./browser";
import { createHostedSync } from "./hosted";
import { DEFAULT_SETTINGS, type DuckSettings } from "./settings";
import { createRegistry } from "./tools/registry";

describe("the hosted servers in the registry (B2)", () => {
  it("lists each opted-in server's tools (from the cache unless refreshed), and reports the rest", async () => {
    let settings: DuckSettings = { ...DEFAULT_SETTINGS, mcpHost: ["firefox", "broken"], firefox: DEFAULT_FIREFOX };
    const asked: string[] = [];
    const registry = createRegistry([]);
    const sync = createHostedSync({
      registry,
      settings: () => settings,
      async listTools(server, refresh) {
        asked.push(`${server}${refresh ? " (refresh)" : ""}`);
        if (server === "broken") throw new Error("`npx` isn't on PATH");
        return { tools: [{ name: "tabs_list" }, { name: "browsers_select" }], at: 1, cached: !refresh };
      },
      servers: async () => [
        { name: "firefox", command: "uvx" },
        { name: "broken", command: "npx.cmd" },
        { name: "other", command: "docker" },
      ],
      running: async () => ["firefox"],
      refLine: () => undefined,
    });
    await sync.sync();
    expect(registry.apiTools.map((t) => ("name" in t ? t.name : ""))).toEqual(["tool_search_tool_regex", "firefox__tabs_list"]);
    expect(await sync.view()).toEqual([
      { name: "firefox", command: "uvx", on: true, browser: true, running: true, tools: 1, error: null },
      { name: "broken", command: "npx.cmd", on: true, browser: false, running: false, tools: null, error: "`npx` isn't on PATH" },
      { name: "other", command: "docker", on: false, browser: false, running: false, tools: null, error: null },
    ]);
    await sync.sync("firefox");
    expect(asked).toEqual(["firefox", "broken", "firefox (refresh)", "broken"]);

    settings = { ...settings, mcpHost: [] };
    await sync.sync();
    expect(registry.apiTools).toEqual([]);
  });
});
