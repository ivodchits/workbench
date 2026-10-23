// Images from an image model (step G6): moods, concepts, renders, anything a
// diagram can't be. Gemini through the Gemini API (`imagegen.rs`); its key lives in
// Credential Manager only. Each image lands as an `image` drawing: versions, the
// canvas, the phone, mark-up.
//
// A request takes longer than a tool's time budget, so it's a background job: the
// tool returns at once, and the images come as cards and a Workbench event. Up to
// the month's cap (`imageCapUsd`, list price) a request runs unasked; past it, each
// one asks.

import { z } from "zod";

import type { GeneratedImages } from "../../ipc/assistant";
import type { AttachmentRef } from "../attachments";
import { MAX_ATTACHMENTS } from "../attachments";
import { IMAGE_MODELS } from "../settings";
import { compact } from "./read";
import { defineTool } from "./registry";

/** What the tool needs of the image model. */
export interface ImageHost {
  /** Whether the key is stored. */
  key(): Promise<boolean>;
  generate(r: { prompt: string; refs: [string, string][]; aspect?: string; size?: string; model?: string; name: string }): Promise<GeneratedImages>;
}

/** The list price of one image, USD (as `imagegen.rs` `price`). */
export function imagePrice(model: string, size: string): number {
  const table: Record<string, Record<string, number>> = {
    "gemini-nano-banana-2.1": { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 },
    "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151 },
    "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
  };
  return table[model]?.[size] ?? 0.134;
}

export const ASPECTS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const SIZES = ["1K", "2K", "4K"] as const;

const NO_KEY =
  "There's no Gemini API key yet. Tell the user: make one in Google AI Studio (it bills the Google Cloud project behind it, where a Google AI subscription's developer credits may apply), then store it in a terminal with: cmdkey /generic:duck/gemini-api-key /user:duck /pass:<key>";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

interface Prepared {
  /** This month's image spend so far and this request's estimate, USD. */
  month: number;
  estimate: number;
  over: boolean;
}

export const generateImage = defineTool({
  name: "generate_image",
  description: [
    "Make pictures with an image model (Gemini, on the user's Google API key): moods, concepts, illustrations, icons, photoreal renders, a sketch turned into a render. Diagrams, schemas, wireframes and charts are `draw`, not this.",
    "Write `prompt` yourself, short and concrete: the subject, the style, the light, the composition. `count` makes that many separate images (\"three moods\" is count 3).",
    "`refs`: pictures it works from: attachment ids (a sketch, a photo) or drawing ids (one of Duck's drawings or images, its newest version). \"The second one, but flatter\" is that image's drawing id in refs, and `drawing` set to it so the result is its next version.",
    "It returns at once; the images come as cards on the canvas and a <workbench_event>. Then say in a few words that they're on the canvas.",
  ].join(" "),
  schema: z.object({
    title: z.string().trim().min(1).max(60).describe("A short name for the image's card (a number is added for each of several)."),
    prompt: z.string().trim().min(1).max(4000),
    count: z.number().int().min(1).max(4).default(1),
    refs: z.array(z.string().trim().min(1)).max(MAX_ATTACHMENTS).optional(),
    drawing: z.string().trim().min(1).optional().describe("An image drawing's id: the result is its next version (count 1)."),
    aspect: z.enum(ASPECTS).default("1:1"),
    size: z.enum(SIZES).default("1K"),
  }),
  tier: "reversible",
  // Within the month's cap it runs unasked; past it, every request asks.
  tierFor: (_input, _port, prepared?: Prepared) => (prepared?.over ? "consequential" : "reversible"),
  async prepare({ count, size }, port, env): Promise<Prepared> {
    const s = env?.settings;
    const estimate = imagePrice(s?.imageModel ?? IMAGE_MODELS[0], size) * count;
    const month = (await port.spend().catch(() => null))?.imageMonthUsd ?? 0;
    return { month, estimate, over: month + estimate > (s?.imageCapUsd ?? 10) };
  },
  describe: ({ title, count }, _port, p) =>
    `Make ${count === 1 ? "an image" : `${count} images`}: ${title} (about $${(p?.estimate ?? 0).toFixed(2)}${p?.over ? `, past this month's image cap: $${p.month.toFixed(2)} so far` : ""})`,
  async run({ title, prompt, count, refs, drawing, aspect, size }, ctx) {
    const images = ctx.images;
    const drawings = ctx.drawings;
    if (!images || !drawings) throw new Error("Images aren't available here.");
    if (drawing && count > 1) throw new Error("A new version of one image is count 1.");
    if (!(await images.key())) throw new Error(NO_KEY);
    const files = (refs ?? []).map((id): AttachmentRef => {
      const f = ctx.attachment?.(id);
      if (f) return f;
      const d = drawings.get(id);
      const png = d?.versions[d.versions.length - 1]?.png;
      if (png) return png;
      throw new Error(`There is no file or drawing ${id} in this thread: use an <attachment> id or a drawing's id.`);
    });
    const model = ctx.settings.imageModel;
    const threadId = ctx.threadId;
    const surface = ctx.surface;
    // The job: each image is a card as it comes; Duck hears once they're all in.
    void (async () => {
      const made: string[] = [];
      let usd = 0;
      const notes: string[] = [];
      for (let i = 0; i < count; i++) {
        const name = count > 1 ? `${title} ${i + 1}` : title;
        try {
          const r = await images.generate({ prompt, refs: files.map((f) => [f.id, f.name]), aspect, size, model, name: slug(name) });
          usd += r.usd;
          if (!r.images.length) notes.push(`image ${i + 1} came back empty${r.text ? `: "${r.text.slice(0, 200)}"` : ""}`);
          for (const img of r.images) {
            const d = drawings.addImage({ threadId, title: name, drawing, image: img, prompt, surface });
            made.push(`${d.id} ("${name}")`);
          }
        } catch (e) {
          notes.push(`image ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      ctx.later(
        made.length
          ? `The image${made.length === 1 ? "" : "s"} for "${title}" ${made.length === 1 ? "is" : "are"} on the canvas: ${made.join(", ")}, about $${usd.toFixed(2)} at list price.${notes.length ? ` Also: ${notes.join("; ")}.` : ""} Tell the user in a few words; changes go to generate_image with the image's drawing id in refs and as drawing.`
          : `No image came of "${title}": ${notes.join("; ")}. Tell the user.`,
      );
    })();
    return compact({
      making: count,
      model,
      note: "Making it now: say so in a few words. The images come as cards and an event.",
    });
  },
});

export const IMAGE_TOOLS = [generateImage];
