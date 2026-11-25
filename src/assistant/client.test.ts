import { describe, expect, it } from "vitest";
import { noThinking } from "./client";

describe("turning thinking off", () => {
  it("uses between_tools on Sonnet 5.5, which refuses disabled", () => {
    expect(noThinking("claude-sonnet-5-5")).toBe("between_tools");
    expect(noThinking("claude-haiku-5-5")).toBe("disabled");
  });
});
