// Music and video (step H3): "play Bohemian Rhapsody", "play some lo-fi on the PC",
// "put on that video about …". The provider (`music/`, YouTube Music for now)
// searches; playing opens its link on a device through that device's host tool
// (`open_on_pc`, H2; `open_on_phone`, which the phone serves from H5). It plays
// where the user asked from unless they name a device. After it starts, pause,
// skip and "what's this" are the media tools (H2's on the PC).

import { z } from "zod";
import { coverage, length, pickItem, type Device, type MediaItem, type Opener } from "../music/provider";
import { VIDEO_ID } from "../music/youtube";
import { defineTool, type ToolContext } from "./registry";

const NAMES: Record<Device, string> = { pc: "the PC", phone: "the phone" };

const on = z
  .enum(["pc", "phone"])
  .optional()
  .describe("The device it plays on. Leave it out unless the user names one: it then plays where they asked from.");

function provider(ctx: ToolContext) {
  if (!ctx.music) throw new Error("no music provider here");
  return ctx.music;
}

const where = (ctx: ToolContext, device: Device | undefined): Device => device ?? (ctx.surface === "phone" ? "phone" : "pc");

/** Open a link on a device through its host's tool. */
const opener =
  (ctx: ToolContext): Opener =>
  async (device, url) => {
    if (!ctx.hosts) throw new Error("no host can open it here");
    await ctx.hosts.call(device, device === "pc" ? "open_on_pc" : "open_on_phone", { url }, ctx.signal);
  };

const view = (i: MediaItem) => ({ id: i.id, title: i.title, artist: i.artist, length: length(i) });

/** After a start: what controls it from here. */
const after = (device: Device) =>
  device === "pc" ? "media_control pauses or skips it; media_now_playing says what's on." : undefined;

export const playMusic = defineTool({
  name: "play_music",
  description:
    "Play a song, an artist, an album or a kind of music in YouTube Music (\"play Bohemian Rhapsody\", \"play some lo-fi on the PC\"). It searches and plays the top match; when no result clearly matches, it returns the choices instead: ask which, then call again with its `id`. Not the user's library or playlists (there's no access to them).",
  schema: z.object({
    query: z.string().min(1).describe("What to play, as the user said it, with the artist when they gave one."),
    id: z.string().regex(VIDEO_ID).optional().describe("A choice's id, from an earlier call."),
    on,
  }),
  tier: "reversible",
  timeoutMs: 20_000,
  async run({ query, id, on: device }, ctx) {
    const music = provider(ctx);
    const target = where(ctx, device);
    const found = await music.search(query, "music", ctx.signal);
    const pick = id ? (found.find((i) => i.id === id) ?? { id, kind: "music" as const, title: query, artist: "", seconds: 0 }) : pickItem(query, found);
    if (!pick) {
      if (!found.length) return `${music.name} found nothing for "${query}".`;
      return {
        playing: null,
        note: "None of these clearly matches: ask which, or search again with the artist.",
        choices: found.slice(0, 5).map(view),
      };
    }
    await music.play(pick, target, opener(ctx));
    return {
      playing: view(pick),
      on: NAMES[target],
      in: music.name,
      ...(!id && coverage(query, pick) < 1 && { note: "The best match, not word for word: say so if it isn't what was asked." }),
      ...(after(target) && { then: after(target) }),
    };
  },
});

export const findVideo = defineTool({
  name: "find_video",
  description:
    "Search YouTube for videos (\"that video about the Roman concrete\"): up to eight, each with its id, title, channel and length. play_video plays one.",
  schema: z.object({ query: z.string().min(1).describe("What the video is about, or its title or channel.") }),
  tier: "read",
  timeoutMs: 15_000,
  async run({ query }, ctx) {
    const found = await provider(ctx).search(query, "video", ctx.signal);
    if (!found.length) return `YouTube found nothing for "${query}".`;
    return { videos: found.map(view) };
  },
});

export const playVideo = defineTool({
  name: "play_video",
  description: "Play a YouTube video, by the id find_video gave, on the PC or the phone.",
  schema: z.object({ id: z.string().regex(VIDEO_ID).describe("The video's id."), on }),
  tier: "reversible",
  timeoutMs: 15_000,
  async run({ id, on: device }, ctx) {
    const target = where(ctx, device);
    await provider(ctx).play({ id, kind: "video", title: "", artist: "", seconds: 0 }, target, opener(ctx));
    return { playing: id, on: NAMES[target], ...(after(target) && { then: after(target) }) };
  },
});

export const openOnPhone = defineTool({
  name: "open_on_phone",
  description:
    "Open a web link (http or https) on the user's phone: the app that handles it opens it (a music.youtube.com link plays in YouTube Music).",
  schema: z.object({ url: z.string().min(1) }),
  tier: "reversible",
  host: "phone",
  timeoutMs: 10_000,
});

export const MEDIA_TOOLS = [playMusic, findVideo, playVideo, openOnPhone];
