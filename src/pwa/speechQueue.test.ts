import { describe, expect, it, vi } from "vitest";
import { SpeechQueue, type Out } from "./speechQueue";

function out() {
  const said: string[] = [];
  const ends: (() => void)[] = [];
  const o: Out = {
    play: (b) =>
      new Promise((r) => {
        said.push(`play:${(b as unknown as { name: string }).name}`);
        ends.push(r);
      }),
    say: (text, lang) =>
      new Promise((r) => {
        said.push(`say:${lang}:${text}`);
        ends.push(r);
      }),
    cut: () => ends.splice(0).forEach((e) => e()),
  };
  const next = () => ends.shift()?.();
  return { o, said, next };
}

const buf = (name: string) => Promise.resolve({ name } as unknown as AudioBuffer);

describe("SpeechQueue", () => {
  it("plays the parts in order, each after the one before, though a later one loads first", async () => {
    const { o, said, next } = out();
    let first!: (b: AudioBuffer) => void;
    const changed = vi.fn();
    const q = new SpeechQueue(o, changed);
    q.add({ audio: new Promise((r) => (first = r)), text: "One.", lang: "en" });
    q.add({ audio: buf("two"), text: "Two.", lang: "en" });
    expect(q.speaking).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(said).toEqual([]);
    first({ name: "one" } as unknown as AudioBuffer);
    await vi.waitFor(() => expect(said).toEqual(["play:one"]));
    next();
    await vi.waitFor(() => expect(said).toEqual(["play:one", "play:two"]));
    next();
    await vi.waitFor(() => expect(q.speaking).toBe(false));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("says a part with the phone's voice when its audio can't be had", async () => {
    const { o, said, next } = out();
    const q = new SpeechQueue(o);
    q.add({ audio: Promise.reject(new Error("404")), text: "Привет.", lang: "ru" });
    q.add({ audio: Promise.resolve(null), text: "Hi.", lang: "en" });
    await vi.waitFor(() => expect(said).toEqual(["say:ru:Привет."]));
    next();
    await vi.waitFor(() => expect(said).toEqual(["say:ru:Привет.", "say:en:Hi."]));
  });

  it("stops what's playing and drops what's queued", async () => {
    const { o, said } = out();
    const q = new SpeechQueue(o);
    q.add({ audio: buf("a"), text: "", lang: "en" });
    q.add({ audio: buf("b"), text: "", lang: "en" });
    await vi.waitFor(() => expect(said).toEqual(["play:a"]));
    q.stop();
    expect(q.speaking).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(said).toEqual(["play:a"]);
    // And it speaks again afterwards.
    q.add({ audio: buf("c"), text: "", lang: "en" });
    await vi.waitFor(() => expect(said).toEqual(["play:a", "play:c"]));
  });
});
