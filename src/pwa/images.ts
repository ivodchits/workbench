// Pictures from the phone, before they go up. What Claude can't take as it is (an
// iPhone's HEIC, say) is redrawn as a JPEG, and a session's photo bigger than an
// image may be is made smaller. Anything that can't be drawn goes as it is: the
// desktop then keeps it as a file rather than a picture.

/** The image types Claude reads. */
export const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Pictures for a session stay under this: the API's 5 MB, as base64. */
export const SESSION_IMAGE_MAX = 3_750_000;
/** The longest side of a picture made smaller to fit. */
const FIT_SIDE = 2048;
/** The longest side of a picture only redrawn for its type. */
const REDRAW_SIDE = 4096;

const HEIC_NAME = /\.(heic|heif)$/i;

/** What to do with a picture before it goes: send it as it is, or redraw it. */
export function imagePlan(type: string, name: string, size: number, maxBytes: number): "keep" | "redraw" {
  const heic = HEIC_NAME.test(name);
  if (!type.startsWith("image/") && !heic) return "keep";
  if (type === "image/svg+xml") return "keep"; // text, not a picture to redraw
  if (SENDABLE.includes(type) && !heic) return size <= maxBytes ? "keep" : "redraw";
  return "redraw";
}

/** A pasted file's name: the clipboard's own, or one made up for an unnamed image
 *  (browsers call every pasted picture `image.png`). */
export function pastedName(f: { name: string; type: string }, now = Date.now()): string {
  if (f.name && f.name !== "image.png") return f.name;
  return `pasted-${now}.${f.type.split("/")[1] || "png"}`;
}

/** `name` with a `.jpg` extension in place of its own. */
export function jpegName(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name || "photo"}.jpg`;
}

/** Draw `bitmap` at most `side` px on its longest side, as a JPEG. */
async function drawJpeg(bitmap: ImageBitmap, side: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A transparent PNG goes white rather than black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** The picture as it should go up: as it is, or redrawn as a JPEG of at most
 *  `maxBytes` (a few tries, each smaller). Not a picture, or one the browser can't
 *  draw: as it is. */
export async function readyImage(blob: Blob, name: string, maxBytes = Infinity): Promise<{ blob: Blob; name: string }> {
  if (imagePlan(blob.type, name, blob.size, maxBytes) === "keep") return { blob, name };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { blob, name };
  }
  try {
    let side = Number.isFinite(maxBytes) ? FIT_SIDE : REDRAW_SIDE;
    for (let tries = 0; tries < 4; tries++) {
      const out = await drawJpeg(bitmap, side, tries === 0 ? 0.85 : 0.75);
      if (!out) break;
      if (out.size <= maxBytes) return { blob: out, name: jpegName(name) };
      side = Math.round(side * 0.75);
    }
  } finally {
    bitmap.close();
  }
  return { blob, name };
}
