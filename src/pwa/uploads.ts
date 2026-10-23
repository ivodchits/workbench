// Files from the phone (step G1): picked with 📎 (the camera offered for
// images), pasted, or shared from another app. Each goes up over Duck's socket in
// parts (`attach.chunk`), base64 of whole 3-byte groups so the parts join into
// one, and `attached` gives back the stored file, which is staged as a chip and
// sent with the next message by its id.

import type { AttachmentRef } from "../assistant/attachments";
import type { RemoteDuckFrame, RemoteDuckMessage } from "../remote/protocol";

/** Bytes a part carries: 196,608 characters of base64, under the server's
 *  256 KB frame. */
export const PART_BYTES = 147_456;
/** The biggest file sent from the phone. */
export const FILE_MAX = 25 * 1024 * 1024;
/** How long an upload may wait for its answer once its last part is sent. */
const ANSWER_MS = 60_000;

/** base64 of `bytes`. */
export function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface Uploader {
  /** Send a file; resolves to the stored file, or rejects with why not. */
  upload(file: Blob, name: string): Promise<AttachmentRef>;
  /** An `attached` frame for one of ours: true when it was taken. */
  onFrame(f: RemoteDuckFrame): boolean;
  /** The socket went: every upload under way fails. */
  drop(): void;
}

export function createUploader(post: (m: RemoteDuckMessage) => void, newId: () => string = () => crypto.randomUUID()): Uploader {
  const waiting = new Map<string, { resolve(f: AttachmentRef): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  return {
    async upload(file, name) {
      if (file.size > FILE_MAX) throw new Error(`${name} is over ${FILE_MAX / (1024 * 1024)} MB`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const upload = newId();
      const answered = new Promise<AttachmentRef>((resolve, reject) => waiting.set(upload, { resolve, reject }));
      const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
      for (let part = 0; part < parts; part++) {
        const data = base64(bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES));
        post({ type: "attach.chunk", upload, name, part, data, last: part === parts - 1 });
        // Let the socket drain and the page breathe between parts.
        if (part % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      const w = waiting.get(upload);
      if (w)
        w.timer = setTimeout(() => {
          waiting.delete(upload);
          w.reject(new Error(`${name} didn't reach Workbench`));
        }, ANSWER_MS);
      return answered;
    },
    onFrame(f) {
      if (f.type !== "attached") return false;
      const w = waiting.get(f.upload);
      if (!w) return true;
      waiting.delete(f.upload);
      clearTimeout(w.timer);
      if (f.file) w.resolve(f.file);
      else w.reject(new Error(f.error ?? "the file wasn't taken"));
      return true;
    },
    drop() {
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("the connection to Workbench dropped"));
      }
      waiting.clear();
    },
  };
}
