import { describe, expect, it } from "vitest";
import type { YoutubeVideo } from "../../ipc/music";
import { connectLocal, createHosts, type HostHandler } from "../hosts";
import { coverage, length, pickItem, type MediaItem, type MediaKind } from "../music/provider";
import { youtubeMusic, youtubeUrl } from "../music/youtube";
import type { Surface } from "../protocol";
import { toolsOn, type ToolContext, type ToolDef } from "./registry";
import { findVideo, MEDIA_TOOLS, playMusic, playVideo } from "./media";
import { PC_TOOLS } from "./pc";

const yt = (id: string, title: string, channel: string, seconds = 200, live = false): YoutubeVideo => ({ id, title, channel, seconds, live });

const QUEEN = [
  yt("fJ9rUzIMcZQ", "Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official", 367),
  yt("yk3prd8GER4", "Bohemian Rhapsody (Remastered 2011)", "Queen", 355),
];
const LOFI = [yt("jfKfPfyJRdk", "lofi hip hop radio 📚 beats to relax/study to", "Lofi Girl", 0, true)];
const NOISE = [yt("aaaaaaaaaaa", "Top 10 hits of the summer", "Hits"), yt("bbbbbbbbbbb", "Chill mix", "Mixes")];

function setup(surface: Surface = "desktop", phone = false) {
  const searches: [string, MediaKind][] = [];
  const opened: string[] = [];
  let clock = 0;
  const music = youtubeMusic({
    now: () => clock,
    search: async (q, kind) => {
      searches.push([q, kind]);
      if (/bohemian/i.test(q)) return QUEEN;
      if (/lo-?fi/i.test(q)) return LOFI;
      if (/nothing/i.test(q)) return [];
      return NOISE;
    },
  });
  const hosts = createHosts((h) => toolsOn([...PC_TOOLS, ...MEDIA_TOOLS], h));
  const open =
    (device: string): HostHandler =>
    async (input) =>
      void opened.push(`${device} ${(input as { url: string }).url}`);
  connectLocal(hosts, "pc", { open_on_pc: open("pc") });
  if (phone) connectLocal(hosts, "phone", { open_on_phone: open("phone") });
  const ctx = { music, hosts, surface, signal: new AbortController().signal } as unknown as ToolContext & { prepared: undefined };
  const run = (t: ToolDef, input: unknown) => t.run(t.schema.parse(input), ctx);
  return { searches, opened, run, tick: (ms: number) => (clock += ms) };
}

describe("what was asked for", () => {
  const item = (title: string, artist: string): MediaItem => ({ id: "x", kind: "music", title, artist, seconds: 0 });

  it("matches the request's words, not its filler", () => {
    expect(coverage("play bohemian rhapsody by queen", item("Bohemian Rhapsody (Remastered 2011)", "Queen"))).toBe(1);
    expect(coverage("some lo-fi", item("lofi hip hop radio", "Lofi Girl"))).toBe(1);
    expect(coverage("bohemian rhapsody", item("Top 10 hits", "Hits"))).toBe(0);
    expect(pickItem("chill jazz piano", [item("Chill mix", "Mixes")])).toBeNull();
  });

  it("says a length the way it's read", () => {
    expect(length({ seconds: 355 })).toBe("5:55");
    expect(length({ seconds: 3723 })).toBe("1:02:03");
    expect(length({ seconds: 0, live: true })).toBe("live");
  });

  it("opens YouTube Music for a song and YouTube for a video, only for a real id", () => {
    expect(youtubeUrl({ id: "yk3prd8GER4", kind: "music" })).toBe("https://music.youtube.com/watch?v=yk3prd8GER4");
    expect(youtubeUrl({ id: "yk3prd8GER4", kind: "video" })).toBe("https://www.youtube.com/watch?v=yk3prd8GER4");
    expect(() => youtubeUrl({ id: "x&list=1", kind: "video" })).toThrow();
  });
});

describe("the music tools", () => {
  it("plays the top match on the PC when asked from the desktop", async () => {
    const t = setup();
    const r = (await t.run(playMusic, { query: "Bohemian Rhapsody" })) as Record<string, unknown>;
    expect(r).toMatchObject({ playing: { id: "fJ9rUzIMcZQ", artist: "Queen Official", length: "6:07" }, on: "the PC", in: "YouTube Music" });
    expect(r.then).toMatch(/media_control/);
    expect(t.opened).toEqual(["pc https://music.youtube.com/watch?v=fJ9rUzIMcZQ"]);
    expect(t.searches).toEqual([["Bohemian Rhapsody", "music"]]);
  });

  it("plays on the phone when asked from it, and on the device named", async () => {
    const t = setup("phone", true);
    await t.run(playMusic, { query: "some lo-fi" });
    await t.run(playMusic, { query: "some lo-fi", on: "pc" });
    expect(t.opened).toEqual(["phone https://music.youtube.com/watch?v=jfKfPfyJRdk", "pc https://music.youtube.com/watch?v=jfKfPfyJRdk"]);
    // The same search within the hour costs no quota…
    expect(t.searches).toHaveLength(1);
    // …an hour later it's asked again.
    t.tick(61 * 60_000);
    await t.run(playMusic, { query: "Some lo-fi " });
    expect(t.searches).toHaveLength(2);
  });

  it("gives the choices when nothing clearly matches, and plays the one picked", async () => {
    const t = setup();
    const r = (await t.run(playMusic, { query: "chill jazz piano" })) as { playing: null; choices: { id: string }[] };
    expect(r.playing).toBeNull();
    expect(r.choices.map((c) => c.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(t.opened).toEqual([]);
    await t.run(playMusic, { query: "chill jazz piano", id: "bbbbbbbbbbb" });
    expect(t.opened).toEqual(["pc https://music.youtube.com/watch?v=bbbbbbbbbbb"]);
    expect(await t.run(playMusic, { query: "nothing at all" })).toBe('YouTube Music found nothing for "nothing at all".');
  });

  it("says so when the phone isn't there", async () => {
    const t = setup("phone");
    await expect(t.run(playMusic, { query: "bohemian rhapsody" })).rejects.toThrow("the phone isn't connected");
  });

  it("finds videos and plays one by id", async () => {
    const t = setup();
    const r = (await t.run(findVideo, { query: "bohemian rhapsody making of" })) as { videos: { id: string; length: string }[] };
    expect(r.videos.map((v) => v.id)).toEqual(["fJ9rUzIMcZQ", "yk3prd8GER4"]);
    expect(t.searches).toEqual([["bohemian rhapsody making of", "video"]]);
    await expect(t.run(playVideo, { id: "yk3prd8GER4", on: "pc" })).resolves.toMatchObject({ playing: "yk3prd8GER4", on: "the PC" });
    expect(t.opened).toEqual(["pc https://www.youtube.com/watch?v=yk3prd8GER4"]);
    expect(() => playVideo.schema.parse({ id: "../etc" })).toThrow();
  });
});
