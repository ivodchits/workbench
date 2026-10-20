import { describe, expect, it, vi } from "vitest";

vi.mock("./duckState", () => ({ sendMessage: vi.fn(), setDrawerOpen: vi.fn() }));
vi.mock("../../state/registry", () => ({ getRegistry: () => ({ projects: [], instances: [] }) }));

import { messageFor } from "./voiceState";

describe("a transcript as a message", () => {
  it("is sent as said, or with the words as heard beside a fix", () => {
    expect(messageFor({ text: " What is api doing? " }, ["api"])).toBe("What is api doing?");
    expect(messageFor({ text: "Открой пул реквест для воркбенча" }, ["Workbench"])).toBe(
      'Открой pull request для Workbench\n\n(voice; as heard: "Открой пул реквест для воркбенча")',
    );
  });
});
