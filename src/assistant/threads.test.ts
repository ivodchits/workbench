import { describe, expect, it } from "vitest";
import { IMAGE_GONE, withoutImages } from "./threads";

describe("withoutImages", () => {
  it("puts a line in place of every image, in tool results and parked batches", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const result = { type: "tool_result", tool_use_id: "u", content: [{ type: "text", text: "Captured" }, image] };
    expect(withoutImages([result])).toEqual([
      { ...result, content: [{ type: "text", text: "Captured" }, { type: "text", text: IMAGE_GONE }] },
    ]);
    const calls = [{ id: "u", name: "screenshot", input: {}, state: "done", result }];
    expect(JSON.stringify(withoutImages(calls))).not.toContain("AAAA");
    // Anything without images is left as it is.
    const plain = [{ type: "text", text: "hi" }];
    expect(withoutImages(plain)).toEqual(plain);
    expect(withoutImages("text")).toBe("text");
  });
});
