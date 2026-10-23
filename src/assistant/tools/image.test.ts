// Images (G6): the key, references from attachments and drawings, the background
// job's cards and report, failures, and the month's cap.

import { describe, expect, it } from "vitest";

import type { GeneratedImages, Spend } from "../../ipc/assistant";
import type { AttachmentRef } from "../attachments";
import type { Drawings, ImageVersion } from "../drawings";
import { fakePort, toolCtx } from "../fakePort.test-util";
import { DEFAULT_SETTINGS } from "../settings";
import { generateImage, imagePrice, type ImageHost } from "./image";

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const png = (id: string, name = `${id}.png`): AttachmentRef => ({ id, name, mime: "image/png", size: 100 });

function setup(opts: { key?: boolean; fail?: number[]; refused?: boolean } = {}) {
  const asked: { prompt: string; refs: [string, string][]; name: string; model?: string }[] = [];
  const images: ImageHost = {
    key: () => Promise.resolve(opts.key ?? true),
    generate: (r) => {
      asked.push(r);
      const i = asked.length;
      if (opts.fail?.includes(i)) return Promise.reject(new Error("the Gemini API answered 429: quota"));
      const out: GeneratedImages = opts.refused
        ? { images: [], model: r.model ?? "", usd: 0, text: "I can't make that." }
        : { images: [{ ...png(`img${i}`), path: `C:\\a\\img${i}.png` }], model: r.model ?? "", usd: 0.0336, text: "" };
      return Promise.resolve(out);
    },
  };
  const added: ImageVersion[] = [];
  const drawings = {
    get: (id: string) => (id === "dr000001" ? { versions: [{ png: png("old", "concept-2.png") }] } : undefined),
    addImage: (v: ImageVersion) => {
      added.push(v);
      return { id: `dr${added.length}` };
    },
  } as unknown as Drawings;
  const port = fakePort({});
  const ctx = {
    ...toolCtx(port),
    threadId: "th1",
    images,
    drawings,
    surface: "phone" as const,
    attachment: (id: string) => (id === "sk1" ? png("sk1", "sketch.png") : undefined),
    prepared: { month: 0, estimate: 0.03, over: false },
  };
  return { ctx, asked, added };
}

const input = (over: Partial<Parameters<typeof generateImage.run>[0]> = {}) =>
  generateImage.schema.parse({ title: "App icon mood", prompt: "a calm duck, flat, teal", ...over });

describe("generate_image (G6)", () => {
  it("makes each image a card on the canvas, then tells Duck once they're all in", async () => {
    const s = setup();
    const out = await generateImage.run(input({ count: 3 }), s.ctx);
    expect(out).toMatchObject({ making: 3, model: DEFAULT_SETTINGS.imageModel });
    await settle();
    expect(s.asked.map((a) => a.name)).toEqual(["app-icon-mood-1", "app-icon-mood-2", "app-icon-mood-3"]);
    expect(s.added.map((a) => a.title)).toEqual(["App icon mood 1", "App icon mood 2", "App icon mood 3"]);
    expect(s.added[0]).toMatchObject({ threadId: "th1", surface: "phone", prompt: "a calm duck, flat, teal" });
    expect(s.ctx.posted).toEqual([expect.stringMatching(/are on the canvas: dr1 \("App icon mood 1"\), dr2 .*about \$0\.10/)]);
  });

  it("works from a sketch and from one of Duck's images, as its next version", async () => {
    const s = setup();
    await generateImage.run(input({ refs: ["sk1", "dr000001"], drawing: "dr000001", prompt: "the second one, but flatter" }), s.ctx);
    await settle();
    expect(s.asked[0].refs).toEqual([
      ["sk1", "sketch.png"],
      ["old", "concept-2.png"],
    ]);
    expect(s.added[0].drawing).toBe("dr000001");
    await expect(generateImage.run(input({ refs: ["nope"] }), s.ctx)).rejects.toThrow("no file or drawing nope");
    await expect(generateImage.run(input({ drawing: "dr000001", count: 2 }), s.ctx)).rejects.toThrow("count 1");
  });

  it("says how to store the key when there's none", async () => {
    const s = setup({ key: false });
    await expect(generateImage.run(input(), s.ctx)).rejects.toThrow("cmdkey /generic:duck/gemini-api-key");
  });

  it("reports failures and refusals instead of cards", async () => {
    const s = setup({ fail: [2] });
    await generateImage.run(input({ count: 2 }), s.ctx);
    await settle();
    expect(s.added).toHaveLength(1);
    expect(s.ctx.posted[0]).toContain("image 2 failed: the Gemini API answered 429");
    const r = setup({ refused: true });
    await generateImage.run(input(), r.ctx);
    await settle();
    expect(r.ctx.posted[0]).toMatch(/No image came of "App icon mood": image 1 came back empty: "I can't make that\."/);
  });

  it("asks past the month's cap", async () => {
    const spend = (imageMonthUsd: number) => ({ imageMonthUsd }) as Spend;
    const env = { settings: { ...DEFAULT_SETTINGS, imageCapUsd: 1 } } as Parameters<NonNullable<typeof generateImage.prepare>>[2];
    const under = await generateImage.prepare!(input({ count: 3 }), fakePort({ spend: spend(0.5) }), env);
    expect(generateImage.tierFor!(input(), fakePort({}), under)).toBe("reversible");
    const over = await generateImage.prepare!(input({ count: 3 }), fakePort({ spend: spend(0.95) }), env);
    expect(over).toMatchObject({ over: true });
    expect(generateImage.tierFor!(input(), fakePort({}), over)).toBe("consequential");
    expect(generateImage.describe!(input({ count: 3 }), fakePort({}), over)).toContain("past this month's image cap");
    expect(imagePrice("gemini-3-pro-image", "4K")).toBe(0.24);
  });
});
