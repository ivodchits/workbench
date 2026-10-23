import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaSession, SteamGame } from "../../ipc/pc";
import { connectLocal, createHosts } from "../hosts";
import { DEFAULT_SETTINGS, cleanSettings } from "../settings";
import { createRegistry, toolsOn, type ToolContext, type ToolDef } from "./registry";
import { clearPick, matchScore, PC_TOOLS, pcHandlers, rankGames, type PcBackend } from "./pc";
import { weather } from "./weather";

const game = (appid: number, name: string, lastPlayed = 0): SteamGame => ({ appid, name, size: 2e9, lastPlayed, ready: true });

const LIBRARY = [
  game(1145360, "Hades", 1_760_000_000),
  game(292030, "The Witcher 3: Wild Hunt"),
  game(271590, "Grand Theft Auto V"),
  game(620, "Portal 2"),
  game(400, "Portal"),
  game(105600, "Terraria"),
];

function fakePc(over: Partial<PcBackend> = {}) {
  const opened: string[] = [];
  const b: PcBackend = {
    library: async () => LIBRARY,
    storeSearch: async () => [
      { appid: 1145350, name: "Hades II" },
      { appid: 1145360, name: "Hades" },
    ],
    activity: async (appid) => ({ appid }),
    open: async (url) => void opened.push(url),
    nowPlaying: async () => [],
    control: async () => ({ app: "Firefox", title: "Song", artist: "Band", album: "", status: "playing", current: true }),
    ...over,
  };
  const h = pcHandlers(b);
  const signal = new AbortController().signal;
  return { opened, backend: b, run: (tool: string, input: unknown) => h[tool](input, signal) };
}

describe("naming a game", () => {
  it("finds a game the way people say it", () => {
    const top = (q: string) => clearPick(rankGames(q, LIBRARY))?.name ?? null;
    expect(top("hades")).toBe("Hades");
    expect(top("witcher 3")).toBe("The Witcher 3: Wild Hunt");
    expect(top("the witcher")).toBe("The Witcher 3: Wild Hunt");
    expect(top("gta 5")).toBeNull(); // "gta" isn't the acronym of the whole name with "5"…
    expect(top("gta5")).toBe("Grand Theft Auto V"); // …but one word is
    expect(top("grand theft auto 5")).toBe("Grand Theft Auto V");
    expect(top("terarria")).toBe("Terraria");
    expect(top("portal 2")).toBe("Portal 2");
    expect(top("portal")).toBe("Portal");
    expect(top("minecraft")).toBeNull();
  });

  it("an exact name wins over a longer one; two near names are a choice", () => {
    expect(matchScore("hades", "Hades")).toBe(1);
    expect(matchScore("hades", "Hades II")).toBeLessThan(1);
    expect(matchScore("hades 2", "Hades II")).toBe(1);
    const two = [game(1, "Dark Souls II"), game(2, "Dark Souls III")];
    expect(clearPick(rankGames("dark souls", two))).toBeNull();
  });
});

describe("the PC's tools", () => {
  it("launches an installed game by name, and gives the choices when it can't tell", async () => {
    const pc = fakePc({ library: async () => [...LIBRARY, game(1, "Dark Souls II"), game(2, "Dark Souls III")] });
    await expect(pc.run("steam_launch", { game: "Hades" })).resolves.toEqual({ launched: "Hades", appid: 1145360 });
    const r = (await pc.run("steam_launch", { game: "dark souls" })) as { launched: null; choices: { appid: number }[] };
    expect(r.launched).toBeNull();
    expect(r.choices.map((c) => c.appid).sort()).toEqual([1, 2]);
    await pc.run("steam_launch", { game: "dark souls", appid: 2 });
    expect(await pc.run("steam_launch", { game: "minecraft" })).toMatch(/No installed game is called "minecraft"/);
    expect(pc.opened).toEqual(["steam://rungameid/1145360", "steam://rungameid/2"]);
  });

  it("installs from the store by name, and doesn't install what's there", async () => {
    const pc = fakePc({ library: async () => [game(620, "Portal 2")] });
    await expect(pc.run("steam_install", { game: "hades 2" })).resolves.toMatchObject({ installing: "Hades II", appid: 1145350 });
    expect(await pc.run("steam_install", { game: "portal 2" })).toMatch(/already installed/);
    expect(pc.opened).toEqual(["steam://install/1145350"]);
  });

  it("lists the library, finds a game's id for its achievements, and checks its input", async () => {
    const pc = fakePc();
    const lib = (await pc.run("steam_library", { query: "portal" })) as { installed: number; games: { name: string }[] };
    expect(lib.installed).toBe(6);
    expect(lib.games.map((g) => g.name)).toEqual(["Portal", "Portal 2"]);
    await expect(pc.run("steam_activity", { game: "terraria" })).resolves.toEqual({ appid: 105600 });
    await expect(pc.run("steam_activity", {})).resolves.toEqual({ appid: null });
    await expect(pc.run("media_control", { action: "stop" })).rejects.toThrow();
  });

  it("says what's playing and pauses it", async () => {
    const playing: MediaSession = { app: "Firefox", title: "Bohemian Rhapsody", artist: "Queen", album: "", status: "playing", current: true };
    const pc = fakePc({ nowPlaying: async () => [playing] });
    await expect(pc.run("media_now_playing", {})).resolves.toEqual({
      sessions: [{ app: "Firefox", title: "Bohemian Rhapsody", artist: "Queen", album: undefined, status: "playing" }],
    });
    await expect(pc.run("media_control", { action: "pause" })).resolves.toMatchObject({ action: "pause", app: { app: "Firefox" } });
    expect(await fakePc().run("media_now_playing", {})).toBe("Nothing is playing or paused on the PC.");
  });

  it("are the pc host's, deferred, and reach the desktop through the hosts", async () => {
    expect(PC_TOOLS.every((t) => t.host === "pc")).toBe(true);
    const reg = createRegistry([...PC_TOOLS, weather], { deferred: new Set(["weather"]) });
    expect(reg.apiTools.filter((t) => !("defer_loading" in t)).map((t) => t.type)).toEqual(["tool_search_tool_regex_20251119"]);
    const hosts = createHosts((h) => toolsOn(PC_TOOLS, h));
    const pc = fakePc();
    connectLocal(hosts, "pc", pcHandlers(pc.backend));
    const launch = PC_TOOLS.find((t) => t.name === "steam_launch") as ToolDef;
    const ctx = { hosts, signal: new AbortController().signal } as unknown as ToolContext & { prepared: undefined };
    await expect(launch.run({ game: "portal 2" }, ctx)).resolves.toEqual({ launched: "Portal 2", appid: 620 });
    expect(pc.opened).toEqual(["steam://rungameid/620"]);
  });
});

describe("weather", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubOpenMeteo() {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const body = url.includes("geocoding")
        ? {
            results: [
              { name: "Portland", latitude: 45.5, longitude: -122.7, country: "United States", country_code: "US", admin1: "Maine" },
              { name: "Portland", latitude: 45.52, longitude: -122.68, country: "United States", country_code: "US", admin1: "Oregon" },
            ],
          }
        : {
            current: { time: "2026-10-23T17:15", temperature_2m: 12.8, apparent_temperature: 9.8, precipitation: 0, weather_code: 61, wind_speed_10m: 13.5 },
            hourly: { time: ["2026-10-23T17:00", "2026-10-23T18:00"], precipitation_probability: [58, 20], precipitation: [0.2, 0] },
            daily: {
              time: ["2026-10-23"],
              weather_code: [80],
              temperature_2m_max: [13.5],
              temperature_2m_min: [6.1],
              precipitation_probability_max: [58],
              precipitation_sum: [0.1],
            },
          };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    return urls;
  }

  const ctx = (home: string | null) =>
    ({ settings: { ...DEFAULT_SETTINGS, home }, signal: new AbortController().signal }) as unknown as ToolContext & { prepared: undefined };

  it("answers for home and for a named place, picking the region named", async () => {
    const urls = stubOpenMeteo();
    const r = (await weather.run({ place: "Portland, Oregon" }, ctx(null))) as Record<string, unknown>;
    expect(r.place).toBe("Portland, Oregon, United States");
    expect(r.now).toEqual({ conditions: "light rain", temperature: 12.8, feelsLike: 9.8, windKmh: 13.5, precipitationMm: 0 });
    expect(r.nextHours).toEqual([
      { time: "17:00", rainChance: 58, rainMm: 0.2 },
      { time: "18:00", rainChance: 20, rainMm: 0 },
    ]);
    expect(urls[1]).toContain("latitude=45.52");
    const home = (await weather.run({}, ctx("Portland"))) as Record<string, unknown>;
    expect(home.place).toBe("Portland, Maine, United States");
    await expect(weather.run({}, ctx(null))).rejects.toThrow("no home is set");
  });

  it("keeps Home as a trimmed place name", () => {
    expect(cleanSettings({ home: "  Lisbon " }).home).toBe("Lisbon");
    expect(cleanSettings({ home: "   " }).home).toBeNull();
    expect(cleanSettings({ home: 4 }).home).toBeUndefined();
  });
});
