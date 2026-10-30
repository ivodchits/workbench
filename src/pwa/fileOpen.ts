// Opening a file chip in Duck's thread (G1): a picture full screen, anything else
// saved to the phone. Both are fetched with the device token (a plain link can't
// carry it) and handed over as object URLs; a file is always opaque bytes here, so
// nothing a worker wrote is rendered on this page's origin.

import type { AttachmentRef } from "../assistant/attachments";
import { showPicture } from "./drawingView";
import { authHeader } from "./net";

/** What the desktop's image route serves, and an `<img>` shows safely. */
const PICTURES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A picture opens in the viewer; anything else downloads. */
export function opensAsPicture(mime: string): boolean {
  return PICTURES.includes(mime);
}

function route(kind: "image" | "file", f: AttachmentRef): string {
  return `/api/assistant/${kind}/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`;
}

async function blobOf(kind: "image" | "file", f: AttachmentRef): Promise<Blob> {
  const r = await fetch(route(kind, f), { headers: authHeader() });
  if (r.status === 404) throw new Error(`${f.name} is no longer on the computer`);
  if (!r.ok) throw new Error(`${f.name} didn't load (${r.status})`);
  return r.blob();
}

/** Save `f` to the phone's downloads. */
export async function saveFile(f: AttachmentRef): Promise<void> {
  const blob = await blobOf("file", f);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Long enough for the download to take the bytes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Open a chip's file; `failed` hears why it couldn't. */
export function openFile(f: AttachmentRef, failed: (why: string) => void): void {
  const why = (e: unknown) => failed(e instanceof Error ? e.message : String(e));
  if (!opensAsPicture(f.mime)) {
    saveFile(f).catch(why);
    return;
  }
  const url = blobOf("image", f).then((b) => URL.createObjectURL(b));
  // A failed load is said in the viewer itself.
  showPicture(f.name, url, () => void saveFile(f).catch(why));
}
