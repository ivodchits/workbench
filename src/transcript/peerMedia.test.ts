// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { attachMediaViewer, mediaStrip } from "./media";
import { heldActions, peerRef, type PeerMedia } from "./peerMedia";

const info = (kind: PeerMedia["kind"], size: number, state: PeerMedia["state"] = "ok"): PeerMedia => ({
  id: "ab",
  kind,
  mime: "",
  name: `x.${kind}`,
  size,
  caption: null,
  state,
});
const url = (id: string, big?: boolean) => `u/${id}${big ? "?big" : ""}`;
const MB = 1024 * 1024;

describe("another machine's files in the strip (S3)", () => {
  it("fetches pictures up to 20 MB and video or sound up to 50 MB", () => {
    expect(peerRef(info("image", 20 * MB), "ab", "laptop", url)).toMatchObject({ kind: "image", src: "u/ab" });
    expect(peerRef(info("video", 30 * MB), "ab", "laptop", url)).toMatchObject({ kind: "video", src: "u/ab" });
    expect(peerRef(info("audio", 50 * MB, "changed"), "ab", "laptop", url).note).toBe("changed since it was shown");
  });

  it("makes a bigger one a card that says where it is", () => {
    const ref = peerRef(info("video", 1288490189), "ab", "laptop", url);
    expect(ref).toMatchObject({ kind: "file", src: "", held: "video", note: "video on laptop", size: 1288490189 });
    // A file that can't play here is a card with nothing to fetch.
    expect(peerRef(info("file", 10), "ab", "laptop", url)).toMatchObject({ kind: "file", held: undefined, note: "file on laptop" });
  });

  it("says when it's gone or not known there", () => {
    expect(peerRef(info("image", 10, "gone"), "ab", "laptop", url)).toMatchObject({ gone: true, note: "file gone" });
    expect(peerRef(undefined, "ab", "laptop", url)).toMatchObject({ gone: true, note: "not known on laptop" });
  });

  it("offers open there and fetch anyway, and shows what was fetched", async () => {
    const openThere = vi.fn();
    const ref = peerRef(info("video", 1 << 30), "ab", "laptop", url);
    const actions = heldActions("laptop", openThere, async (r) => ({ ...r, kind: r.held!, held: undefined, src: url(r.id!, true) }));
    const host = document.createElement("div");
    const scope = document.createElement("div");
    scope.append(mediaStrip([ref]));
    host.append(scope);
    document.body.append(host);
    attachMediaViewer(scope, host, actions);
    scope.querySelector<HTMLElement>(".wb-tx-thumb")!.click();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".wb-media-file .wb-media-btn")];
    expect(buttons.map((b) => b.textContent)).toEqual(["open on laptop", "fetch anyway"]);
    buttons[0].click();
    expect(openThere).toHaveBeenCalledWith(ref);
    buttons[1].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector<HTMLVideoElement>(".wb-media-video")?.getAttribute("src")).toBe("u/ab?big");
  });
});
