// The PC's tools (step H2): "launch Hades", "what have I been playing?", "pause
// the music", "open this on the PC". They run on the `pc` host (H1): the engine
// keeps their schemas, the desktop serves them in process (`pcHandlers`, wired
// in `index.ts`), over Steam (`steam.rs`) and Windows' media sessions
// (`media.rs`).
//
// A game is named the way people say it; `rankGames` finds it among the
// installed games (or the store's, to install one). A weak match doesn't guess:
// the call returns the choices, and the model asks.

import { z } from "zod";
import type { MediaAction, MediaSession, SteamGame, StoreHit } from "../../ipc/pc";
import type { HostHandler } from "../hosts";
import { defineTool, type ToolDef } from "./registry";

/** What the PC's tools run on: the app's commands, fakes in tests. */
export interface PcBackend {
  library(): Promise<SteamGame[]>;
  storeSearch(term: string): Promise<StoreHit[]>;
  activity(appid: number | null): Promise<Record<string, unknown>>;
  open(url: string): Promise<void>;
  nowPlaying(): Promise<MediaSession[]>;
  control(action: MediaAction): Promise<MediaSession>;
}

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

/** A name as words to compare: lowercase, no marks or punctuation, roman numerals
 *  as digits ("Hades II" and "hades 2" are the same). */
export function words(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ™®©]/g, "")
    .replace(/&/g, " and ")
    .replace(/'/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w);
}

/** Edits from `a` to `b`, a swap of two letters counting as one. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** How well `query` names `name`, 0 to 1. */
export function matchScore(query: string, name: string): number {
  const q = words(query);
  const n = words(name);
  if (!q.length || !n.length) return 0;
  const qs = q.join(" ");
  const ns = n.join(" ");
  if (qs === ns) return 1;
  const extra = Math.min(0.15, 0.03 * (n.length - q.length));
  // The start of the name: "witcher 3" for "The Witcher 3: Wild Hunt" after "the".
  const body = n[0] === "the" ? n.slice(1) : n;
  if (q.every((w, i) => body[i] === w) || q.every((w, i) => n[i] === w)) return 0.92 - extra;
  if (q.every((w) => n.includes(w))) return 0.85 - extra;
  const acronym = n.map((w) => (/^\d+$/.test(w) ? w : w[0])).join("");
  if (q.length === 1 && acronym.length > 1 && q[0] === acronym) return 0.8;
  const qc = q.join("");
  const nc = n.join("");
  if (qc.length >= 3 && nc.includes(qc)) return 0.75 - extra;
  // A typo: the closest stretch of the name of the query's length.
  let best = Infinity;
  for (let i = 0; i + qc.length <= nc.length || i === 0; i++) best = Math.min(best, editDistance(qc, nc.slice(i, i + qc.length)));
  return Math.max(0, 0.9 * (1 - best / Math.max(qc.length, 1)));
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** `items` by how well `query` names them, the best first; the weak left out. */
export function rankGames<T extends { name: string }>(query: string, items: readonly T[]): Ranked<T>[] {
  return items
    .map((item) => ({ item, score: matchScore(query, item.name) }))
    .filter((r) => r.score >= 0.4)
    .sort((a, b) => b.score - a.score);
}

/** The one the query means, when it's clear: a strong match, clearly ahead. */
export function clearPick<T>(ranked: Ranked<T>[]): T | null {
  const [a, b] = ranked;
  if (!a || a.score < 0.75) return null;
  if (a.score < 1 && b && b.score > a.score - 0.05) return null;
  return a.item;
}

const gb = (bytes: number) => Math.round(bytes / 1e8) / 10;
const day = (secs: number) => (secs ? new Date(secs * 1000).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "never");

const gameRef = {
  game: z.string().min(1).describe("The game as the user named it."),
  appid: z.number().int().positive().optional().describe("The Steam app id, when an earlier call's choices gave it."),
};

function choicesOf<T extends { appid: number; name: string }>(ranked: Ranked<T>[]) {
  return ranked.slice(0, 5).map((r) => ({ appid: r.item.appid, name: r.item.name }));
}

export const steamLibrary = defineTool({
  name: "steam_library",
  description:
    "The Steam games installed on the user's PC: name, app id, size, when last played, the last played first. With `query`, only the games it names. For \"what games do I have\", \"how big is X\", \"when did I last play X\".",
  schema: z.object({ query: z.string().optional().describe("Part of a game's name.") }),
  tier: "read",
  host: "pc",
  timeoutMs: 15_000,
});

export const steamLaunch = defineTool({
  name: "steam_launch",
  description:
    "Launch an installed Steam game on the user's PC by name (\"launch Hades\"). When the name could be more than one game, it returns the choices instead: ask which, then call again with its `appid`. A game that isn't installed is steam_install's.",
  schema: z.object(gameRef),
  tier: "reversible",
  host: "pc",
  timeoutMs: 15_000,
});

export const steamInstall = defineTool({
  name: "steam_install",
  description:
    "Start installing a Steam game on the user's PC by name: Steam opens its install dialog. The game is found in the Steam store's search; when the name could be more than one, it returns the choices: ask which, then call again with its `appid`. A game the user doesn't own opens to its store page instead.",
  schema: z.object(gameRef),
  tier: "reversible",
  host: "pc",
  timeoutMs: 20_000,
});

export const steamActivity = defineTool({
  name: "steam_activity",
  description:
    "The user's Steam activity through the Steam Web API: the games played in the last two weeks and for how long, the most played ever, how many games they own, friends online and what they play. With `game`, that game's achievements too. Needs the user's Steam Web API key; without one it says how to add it.",
  schema: z.object({ game: z.string().optional().describe("A game whose achievements to include.") }),
  tier: "read",
  host: "pc",
  timeoutMs: 30_000,
});

export const mediaNowPlaying = defineTool({
  name: "media_now_playing",
  description:
    "What's playing on the user's PC, in any app that shows in Windows' media controls (a YouTube Music or YouTube tab in the browser, Spotify, a video player): each app's title, artist and whether it plays or is paused.",
  schema: z.object({}),
  tier: "read",
  host: "pc",
  timeoutMs: 10_000,
});

export const mediaControl = defineTool({
  name: "media_control",
  description:
    "Play, pause, skip to the next or go back to the previous track on the user's PC, as the media keys do: it goes to the app that's playing (or the last one used). Returns what it acted on.",
  schema: z.object({ action: z.enum(["play", "pause", "toggle", "next", "previous"]) }),
  tier: "reversible",
  host: "pc",
  timeoutMs: 10_000,
});

export const openOnPc = defineTool({
  name: "open_on_pc",
  description:
    "Open a web link (http or https) in the default browser on the user's PC, or a Steam link for a game (steam://rungameid/<id>, steam://install/<id>, steam://store/<id>). Nothing else opens.",
  schema: z.object({ url: z.string().min(1) }),
  tier: "reversible",
  host: "pc",
  timeoutMs: 10_000,
});

export const PC_TOOLS = [steamLibrary, steamLaunch, steamInstall, steamActivity, mediaNowPlaying, mediaControl, openOnPc];

function session(s: MediaSession) {
  return { app: s.app, title: s.title, artist: s.artist || undefined, album: s.album || undefined, status: s.status };
}

/** The PC's side of its tools, over `b`: each tool's input is checked against its
 *  schema again here, as a host does with what it's sent. */
export function pcHandlers(b: PcBackend): Record<string, HostHandler> {
  const on = <S extends z.ZodType>(t: ToolDef<S, unknown>, run: (input: z.infer<S>) => Promise<unknown>): [string, HostHandler] => [
    t.name,
    async (input) => run(t.schema.parse(input)),
  ];
  const view = (g: SteamGame) => ({ appid: g.appid, name: g.name, sizeGB: gb(g.size), lastPlayed: day(g.lastPlayed), ...(!g.ready && { updating: true }) });

  return Object.fromEntries([
    on(steamLibrary, async ({ query }) => {
      const all = await b.library();
      const games = query ? rankGames(query, all).map((r) => r.item) : all;
      return { installed: all.length, games: games.slice(0, 60).map(view) };
    }),
    on(steamLaunch, async ({ game, appid }) => {
      const all = await b.library();
      const ranked = rankGames(game, all);
      const pick = appid ? all.find((g) => g.appid === appid) : clearPick(ranked);
      if (!pick) {
        if (appid) return `No installed game has app id ${appid}; steam_install can install it.`;
        if (!ranked.length) return `No installed game is called "${game}". steam_install can install it if it's on Steam.`;
        return { launched: null, note: "More than one game could be meant: ask which.", choices: choicesOf(ranked) };
      }
      await b.open(`steam://rungameid/${pick.appid}`);
      return { launched: pick.name, appid: pick.appid, ...(!pick.ready && { note: "Steam updates it first." }) };
    }),
    on(steamInstall, async ({ game, appid }) => {
      const installed = await b.library();
      const have = appid ? installed.find((g) => g.appid === appid) : clearPick(rankGames(game, installed));
      if (have) return `${have.name} is already installed; steam_launch starts it.`;
      let pick: StoreHit | null = null;
      let ranked: Ranked<StoreHit>[] = [];
      if (appid) pick = { appid, name: game };
      else {
        ranked = rankGames(game, await b.storeSearch(game));
        pick = clearPick(ranked);
      }
      if (!pick) {
        if (!ranked.length) return `The Steam store has nothing called "${game}".`;
        return { installing: null, note: "More than one game could be meant: ask which.", choices: choicesOf(ranked) };
      }
      await b.open(`steam://install/${pick.appid}`);
      return { installing: pick.name, appid: pick.appid, note: "Steam's install dialog is open on the PC; a game the user doesn't own opens to its store page." };
    }),
    on(steamActivity, async ({ game }) => {
      let appid: number | null = null;
      if (game) {
        appid = clearPick(rankGames(game, await b.library()))?.appid ?? clearPick(rankGames(game, await b.storeSearch(game)))?.appid ?? null;
        if (appid === null) throw new Error(`No game called "${game}" was found for its achievements.`);
      }
      return b.activity(appid);
    }),
    on(mediaNowPlaying, async () => {
      const all = await b.nowPlaying();
      if (!all.length) return "Nothing is playing or paused on the PC.";
      return { sessions: all.map(session) };
    }),
    on(mediaControl, async ({ action }) => ({ action, app: session(await b.control(action)) })),
    on(openOnPc, async ({ url }) => {
      await b.open(url.trim());
      return `Opened ${url.trim()} on the PC.`;
    }),
  ]);
}
