import { describe, expect, it } from "vitest";
import { asksHard, pickEffort, route } from "./routing";

describe("pickEffort", () => {
  it.each([
    "compare these three libraries for X and write it up in a note",
    "research how Tauri signs updates",
    "make a plan for the release",
    "think it through: monorepo or not?",
    "open their pricing page in Firefox",
    "сравни эти два подхода",
    "подумай как следует, что лучше",
    "piénsalo bien",
    "analiza los resultados",
  ])("high: %s", (text) => expect(pickEffort(text, "chat", "desktop")).toBe("high"));

  it.each([
    "what's the backend agent doing",
    "approve tests if it asks",
    "note that the deploy moved to Friday",
    "что делает бэкенд?",
    "run the assistant plan on workbench on autopilot",
  ])("medium: %s", (text) => expect(pickEffort(text, "chat", "voice")).toBe("medium"));

  it("runs a rubber-duck thread high, and events medium whatever they say", () => {
    expect(pickEffort("hi", "duck", "desktop")).toBe("high");
    expect(pickEffort("<workbench_event>compare results</workbench_event>", "duck", "event")).toBe("medium");
  });
});

describe("route", () => {
  const base = { source: "desktop" as const, degraded: false };

  it("is Sonnet within the budget, at the asked effort", () => {
    expect(route({ ...base, text: "hi" })).toEqual({ brain: "sonnet", effort: "medium" });
    expect(route({ ...base, text: "hi", effort: "high" })).toEqual({ brain: "sonnet", effort: "high" });
  });

  it("is Haiku past the soft limit, unless asked to think hard", () => {
    const d = { ...base, degraded: true };
    expect(route({ ...d, text: "compare A and B" })).toEqual({ brain: "haiku", effort: "high" });
    expect(route({ ...d, text: "think hard about A and B" })).toEqual({ brain: "sonnet", effort: "high" });
    expect(route({ ...d, text: "hi", effort: "high" })).toEqual({ brain: "sonnet", effort: "high" });
    expect(route({ ...d, text: "hi", brain: "sonnet" })).toEqual({ brain: "sonnet", effort: "medium" });
    // A Workbench event quoting "think hard" is not the user asking.
    expect(route({ ...d, source: "event", text: "the worker said: think hard" })).toEqual({ brain: "haiku", effort: "medium" });
  });

  it("knows think hard when it hears it", () => {
    expect(asksHard("Think harder about this")).toBe(true);
    expect(asksHard("I think the build is hard")).toBe(false);
  });
});
