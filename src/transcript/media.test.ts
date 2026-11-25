// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachMediaViewer, mediaStrip, type MediaRef } from "./media";

const refs: MediaRef[] = [
  { kind: "image", src: "data:image/png;base64,AAAA", label: "first" },
  { kind: "image", src: "data:image/png;base64,BBBB", label: "second" },
  { kind: "image", src: "data:image/png;base64,CCCC", label: "third" },
];

function setup() {
  const host = document.createElement("div");
  const scope = document.createElement("div");
  // Two items' strips: the viewer moves through all of the session's media.
  scope.append(mediaStrip(refs.slice(0, 2), "two shots"), mediaStrip(refs.slice(2)));
  host.append(scope);
  document.body.append(host);
  const detach = attachMediaViewer(scope, host);
  return { host, scope, detach };
}

const viewer = (host: HTMLElement) => host.querySelector<HTMLElement>(".wb-media-viewer");
const shown = (host: HTMLElement) => host.querySelector<HTMLImageElement>(".wb-media-img")?.getAttribute("src");
const key = (host: HTMLElement, k: string) =>
  viewer(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

afterEach(() => document.body.replaceChildren());

describe("the media strip and viewer", () => {
  it("has a thumbnail per item and the caption", () => {
    const strip = mediaStrip(refs.slice(0, 2), "two shots");
    expect(strip.querySelectorAll(".wb-tx-thumb")).toHaveLength(2);
    expect(strip.querySelector(".wb-tx-media-caption")?.textContent).toBe("two shots");
  });

  it("opens over the host at the clicked picture, and the arrows go through them all", () => {
    const { host, scope } = setup();
    scope.querySelectorAll<HTMLElement>(".wb-tx-thumb")[1].click();
    expect(viewer(host)).not.toBeNull();
    expect(shown(host)).toBe(refs[1].src);
    expect(host.querySelector(".wb-media-count")?.textContent).toBe("2 / 3");
    key(host, "ArrowRight");
    expect(shown(host)).toBe(refs[2].src);
    key(host, "ArrowRight");
    expect(shown(host)).toBe(refs[0].src);
    key(host, "ArrowLeft");
    expect(shown(host)).toBe(refs[2].src);
  });

  it("closes on Esc, and keeps its keys from the transcript", () => {
    const { host, scope } = setup();
    let heard = 0;
    host.addEventListener("keydown", () => heard++);
    scope.querySelector<HTMLElement>(".wb-tx-thumb")!.click();
    key(host, "x");
    key(host, "Escape");
    expect(viewer(host)).toBeNull();
    expect(heard).toBe(0);
  });

  it("is one viewer per host, and detaching closes it", () => {
    const { host, scope, detach } = setup();
    const thumbs = scope.querySelectorAll<HTMLElement>(".wb-tx-thumb");
    thumbs[0].click();
    thumbs[2].click();
    expect(host.querySelectorAll(".wb-media-viewer")).toHaveLength(1);
    detach();
    expect(viewer(host)).toBeNull();
  });
});

describe("video, sound and files in the viewer (S2)", () => {
  const files: MediaRef[] = [
    { kind: "video", src: "http://wbmedia.localhost/v", label: "clip.mp4", id: "v" },
    { kind: "audio", src: "http://wbmedia.localhost/a", label: "take.wav", id: "a" },
    { kind: "file", src: "", label: "report.pdf", id: "f", size: 2048 },
    { kind: "image", src: "", label: "old.png", id: "g", gone: true, note: "file gone" },
  ];

  function open(actions = {}) {
    const host = document.createElement("div");
    const scope = document.createElement("div");
    scope.append(mediaStrip(files));
    host.append(scope);
    document.body.append(host);
    attachMediaViewer(scope, host, actions);
    return { host, scope, thumbs: scope.querySelectorAll<HTMLElement>(".wb-tx-thumb") };
  }

  it("draws each kind's thumbnail", () => {
    const { scope } = open();
    expect(scope.querySelector(".wb-tx-thumb-video video")?.getAttribute("src")).toBe("http://wbmedia.localhost/v#t=0.1");
    expect(scope.querySelector(".wb-tx-thumb-audio audio")).not.toBeNull();
    expect(scope.querySelector(".wb-tx-thumb-file")?.textContent).toContain("2.0 KB");
    expect(scope.querySelector(".wb-tx-thumb-gone")?.textContent).toContain("file gone");
  });

  it("plays a video with its controls, and a sound's own player doesn't open the viewer", () => {
    const { host, thumbs } = open();
    thumbs[1].querySelector("audio")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(viewer(host)).toBeNull();
    thumbs[0].click();
    const video = host.querySelector<HTMLVideoElement>(".wb-media-video");
    expect(video?.controls).toBe(true);
    expect(host.querySelector<HTMLElement>(".wb-media-zoom")?.hidden).toBe(true);
  });

  it("offers the host's actions for a file, and pops out what can be", () => {
    const open_ = vi.fn();
    const reveal = vi.fn();
    const popOut = vi.fn();
    const { host, thumbs } = open({ open: open_, reveal, popOut });
    thumbs[2].click();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".wb-media-file .wb-media-btn")];
    expect(buttons.map((b) => b.textContent)).toEqual(["open externally", "show in folder"]);
    buttons[0].click();
    buttons[1].click();
    expect(open_).toHaveBeenCalledWith(files[2]);
    expect(reveal).toHaveBeenCalledWith(files[2]);
    // A gone file has nothing to open or pop out.
    key(host, "ArrowRight");
    expect(host.querySelectorAll(".wb-media-file .wb-media-btn")).toHaveLength(0);
    const pop = [...host.querySelectorAll<HTMLButtonElement>(".wb-media-btn")].find((b) => b.textContent === "pop out")!;
    expect(pop.hidden).toBe(true);
    key(host, "ArrowLeft");
    expect(pop.hidden).toBe(false);
    pop.click();
    expect(popOut).toHaveBeenCalledWith(files[2]);
    expect(viewer(host)).toBeNull();
  });
});
