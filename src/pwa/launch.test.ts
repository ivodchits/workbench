import { describe, expect, it } from "vitest";
import { launchOf, shareBody, shareLines, shareMessage } from "./launch";

describe("launching Duck (R3)", () => {
  it("reads the shortcut or share from the address", () => {
    expect(launchOf("?duck=talk")).toBe("talk");
    expect(launchOf("?x=1&duck=share")).toBe("share");
    expect(launchOf("?duck=share-lost")).toBe("share-lost");
    expect(launchOf("?duck=evil")).toBeNull();
    expect(launchOf("")).toBeNull();
  });

  it("says a shared page's link once, wherever the browser put it", () => {
    // Chrome on Android: the title, and the link in `text`.
    expect(shareLines({ title: "A post", text: "https://example.com/a", url: "" })).toEqual(["A post", "https://example.com/a"]);
    // Text around the link stays, the link on its own line.
    expect(shareLines({ title: "", text: "Look at this https://example.com/b please", url: "" })).toEqual([
      "https://example.com/b",
      "Look at this please",
    ]);
    expect(shareLines({ title: "T", text: "https://example.com/c", url: "https://example.com/c" })).toEqual(["T", "https://example.com/c"]);
    expect(shareLines({ title: " ", text: "just words", url: "" })).toEqual(["just words"]);
  });

  it("wraps what was shared, and puts the ask first", () => {
    const body = shareBody({ title: "A post", text: "", url: "https://example.com/a" });
    expect(body).toBe("Shared from my phone:\n<shared>\nA post\nhttps://example.com/a\n</shared>");
    expect(shareBody({ title: "", text: "", url: "" })).toBe("");
    expect(shareMessage("Summarize this for me.", body)).toBe(`Summarize this for me.\n\n${body}`);
    expect(shareMessage("  ", body)).toBe(body);
  });
});
