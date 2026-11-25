// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

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
