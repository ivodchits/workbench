import { describe, expect, it } from "vitest";

import { SAFETY_RULES } from "./config";
import { MODE_IDS, MODES, modeOf, patienceFor, systemFor, thinksOnSession } from "./modes";
import { pickEffort } from "./routing";
import { DEFERRED, SERVER_TOOLS, TOOL_NAMES, TOOLS } from "./toolset";
import { createRegistry } from "./tools/registry";

describe("modes (S1)", () => {
  it("names only tools Duck has", () => {
    for (const id of MODE_IDS) for (const t of MODES[id].tools ?? []) expect(TOOL_NAMES.has(t), `${id}: ${t}`).toBe(true);
  });

  it("offers the web to the assistant and the chat, not the rubber duck (B1)", () => {
    const r = createRegistry(TOOLS, { deferred: DEFERRED, server: SERVER_TOOLS });
    const types = (tools: unknown[]) => tools.map((t) => (t as { type?: string }).type).filter(Boolean);
    expect(types(r.toolsFor(null))).toEqual(["tool_search_tool_regex_20251119", "web_search_20250305", "web_fetch_20250910"]);
    expect(types(r.toolsFor(MODES.chat.tools))).toEqual(["web_search_20250305", "web_fetch_20250910"]);
    expect(types(r.toolsFor(MODES.duck.tools))).toEqual([]);
    expect(r.toolsFor(null)[1]).toMatchObject({ name: "web_search", max_uses: 5 });
    expect(r.toolsFor(null)[2]).toMatchObject({ name: "web_fetch", max_uses: 8, max_content_tokens: 12_000 });
  });

  it("offers a mode's tools without the tool search, every one loaded", () => {
    const r = createRegistry(TOOLS, { deferred: DEFERRED });
    const duck = r.toolsFor(MODES.duck.tools);
    const names = duck.map((t) => (t as { name: string }).name);
    expect(names).toEqual([...(MODES.duck.tools ?? [])].sort());
    expect(duck.some((t) => (t as { defer_loading?: boolean }).defer_loading)).toBe(false);
    // The same objects every request (the cached prefix), and all for the assistant.
    expect(r.toolsFor(MODES.duck.tools)).toBe(duck);
    expect(r.toolsFor(null)).toBe(r.apiTools);
  });

  it("keeps the safety rules in every prompt of its own", () => {
    for (const id of MODE_IDS) {
      const p = MODES[id].systemPrompt;
      if (p) expect(p).toContain(SAFETY_RULES);
    }
    expect(systemFor(MODES.assistant, "the config's")).toBe("the config's");
    expect(systemFor(MODES.duck, "the config's")).toBe(MODES.duck.systemPrompt);
  });

  it("reads a thread from before modes, or one not known, as the assistant", () => {
    expect(modeOf(undefined).id).toBe("assistant");
    expect(modeOf("interviewer").id).toBe("assistant");
    expect(modeOf("duck").id).toBe("duck");
  });

  it("starts a duck at high effort, a chat at medium", () => {
    expect(pickEffort("the sync bug", "duck", "voice")).toBe("high");
    expect(pickEffort("how are you", "chat", "voice")).toBe("medium");
    expect(pickEffort("how are you", "duck", "event")).toBe("medium");
  });

  it("thinks on the subscription for the built-in modes the settings name, yours by their skill, never the assistant (D3)", () => {
    expect(thinksOnSession(MODES.duck, ["duck"])).toBe(true);
    expect(thinksOnSession(MODES.chat, ["duck"])).toBe(false);
    expect(thinksOnSession(MODES.assistant, ["assistant"])).toBe(false);
    const coach = { ...MODES.chat, id: "coach", backend: "session" as const };
    expect(thinksOnSession(coach, [])).toBe(true);
    expect(thinksOnSession({ ...coach, backend: undefined }, ["coach"])).toBe(false);
  });

  it("waits for the more patient of the mode's pauses and your setting", () => {
    expect(patienceFor(MODES.duck, "quick")).toBe("thinking");
    expect(patienceFor(MODES.chat, "quick")).toBe("patient");
    expect(patienceFor(MODES.chat, "thinking")).toBe("thinking");
    expect(patienceFor(MODES.assistant, "patient")).toBe("patient");
  });
});
