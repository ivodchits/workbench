import { describe, expect, it } from "vitest";
import { cellOf, cleanSettings, sheetIdOf } from "./settings";

const ID = "1AbC_defGhIjKlMnOpQrStUvWxYz0123456789";

describe("the Google settings", () => {
  it("keeps the modes that think on the subscription to chat and duck, and its model (D3)", () => {
    expect(cleanSettings({ sessionModes: ["duck", "assistant", "duck", 3, "chat"], sessionModel: "opus" })).toEqual({
      sessionModes: ["duck", "chat"],
      sessionModel: "opus",
    });
    expect(cleanSettings({ sessionModes: "duck", sessionModel: "haiku" })).toEqual({});
  });

  it("keeps the hosted servers' names and Firefox's profiles (B2)", () => {
    expect(
      cleanSettings({
        mcpHost: ["firefox", "firefox", "bad name!", 4],
        firefox: { server: "", agentProfile: "x\" -url", agentBrowser: " Firefox 2 ", personalSites: ["https://YouTrack.cloud/x", "", 3] },
      }),
    ).toEqual({
      mcpHost: ["firefox"],
      firefox: { server: "firefox", agentProfile: "claude-agent", agentBrowser: "Firefox 2", personalBrowser: "", personalSites: ["youtrack.cloud"] },
    });
  });

  it("takes a sheet id or the id out of its URL", () => {
    expect(sheetIdOf(ID)).toBe(ID);
    expect(sheetIdOf(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(sheetIdOf("short")).toBeNull();
    expect(sheetIdOf("https://example.com/x")).toBeNull();
  });

  it("reads one A1 cell, without $", () => {
    expect(cellOf("b2")).toBe("B2");
    expect(cellOf(" $F$10 ")).toBe("F10");
    expect(cellOf("B2:C3")).toBeNull();
    expect(cellOf("B0")).toBeNull();
    expect(cellOf("Sheet1!B2")).toBeNull();
  });

  it("keeps a valid client id, and takes it over from the first build's morning setting", () => {
    expect(cleanSettings({ google: { clientId: " 123-abc.apps.googleusercontent.com " } }).google).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
    });
    expect(cleanSettings({ google: { clientId: "no spaces allowed" } }).google).toEqual({ clientId: null });
    const old = cleanSettings({ morning: { googleClientId: "123-abc.apps.googleusercontent.com", invoice: { tab: "T" } } });
    expect(old.google).toEqual({ clientId: "123-abc.apps.googleusercontent.com" });
    expect(old).not.toHaveProperty("morning");
  });
});
