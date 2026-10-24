// Pictures and files for a session's prompt, from the console composer (📎 or a
// paste). Each goes up as soon as it's added (`POST /api/session/upload`, the
// desktop's `remote/uploads.rs`), one at a time, and waits as a chip above the
// composer. Sending writes them into the prompt (`promptWith`):
//
// - a picture as an `[image …]` token, the desktop composer's own
//   (`state/composer`): the desktop pastes its path into the TUI on its own,
//   which attaches it as `[Image #N]`;
// - any other file (or a picture too big for that) as its full path on the
//   desktop, in the session's folder, for Claude to read.
//
// What's staged is kept per session while the page is open, like the drafts.

import { api, ApiError } from "./net";
import { FILE_MAX } from "./uploads";

/** What the desktop made of an upload. */
export interface SessionFile {
  /** `image`: attached as a picture; `file`: saved for Claude to read. */
  kind: "image" | "file";
  name: string;
  size: number;
  /** A picture's name in the desktop's paste folder, or a file's full path. */
  file: string;
}

/** One file waiting to go with the next prompt. */
export interface Staged {
  key: number;
  name: string;
  size: number;
  /** An object URL of a picture, for its chip. */
  preview?: string;
  state: "adding" | "ready" | "failed";
  file?: SessionFile;
  error?: string;
}

/** Send one file for `instanceId`'s session. */
export async function uploadToSession(instanceId: string, blob: Blob, name: string): Promise<SessionFile> {
  try {
    return await api<SessionFile>("/api/session/upload", {
      query: { instance: instanceId, name },
      raw: new Uint8Array(await blob.arrayBuffer()),
      type: blob.type || "application/octet-stream",
    });
  } catch (e) {
    if (e instanceof ApiError) throw e.status === 413 ? new Error(`over ${FILE_MAX / (1024 * 1024)} MB`) : e;
    throw new Error("Workbench can't be reached");
  }
}

/** The prompt that sends `body` with `files`: the files' paths, then the
 *  pictures' tokens. */
export function promptWith(body: string, files: readonly SessionFile[]): string {
  const paths = files.filter((f) => f.kind === "file").map((f) => `Attached file: ${f.file}`);
  const images = files.filter((f) => f.kind === "image").map((f) => `[image ${f.file}]`);
  return [body.trim(), paths.join("\n"), images.join(" ")].filter(Boolean).join("\n\n");
}

export interface Staging {
  /** Add a file for `instanceId`; it starts going up at once. */
  add(instanceId: string, blob: Blob, name: string, preview?: string): void;
  remove(instanceId: string, key: number): void;
  list(instanceId: string): readonly Staged[];
  /** Some are still going up. */
  busy(instanceId: string): boolean;
  /** The files that went up, and clear the list (the prompt is going). */
  take(instanceId: string): SessionFile[];
}

export function createStaging(
  upload: (instanceId: string, blob: Blob, name: string) => Promise<SessionFile>,
  changed: (instanceId: string) => void,
  release: (preview: string) => void = (p) => URL.revokeObjectURL(p),
): Staging {
  const lists = new Map<string, Staged[]>();
  let next = 1;
  /** One upload at a time: a phone link is narrow. */
  let queue: Promise<unknown> = Promise.resolve();

  const of = (id: string) => lists.get(id) ?? [];
  const drop = (items: readonly Staged[]) => {
    for (const s of items) if (s.preview) release(s.preview);
  };
  const settle = (id: string, key: number, patch: Partial<Staged>) => {
    const items = of(id);
    const i = items.findIndex((s) => s.key === key);
    if (i < 0) return; // removed or sent meanwhile
    lists.set(id, items.map((s, k) => (k === i ? { ...s, ...patch } : s)));
    changed(id);
  };

  return {
    add(id, blob, name, preview) {
      const key = next++;
      const item: Staged = { key, name, size: blob.size, ...(preview && { preview }), state: "adding" };
      if (blob.size > FILE_MAX) Object.assign(item, { state: "failed", error: `over ${FILE_MAX / (1024 * 1024)} MB` });
      else if (!blob.size) Object.assign(item, { state: "failed", error: "the file is empty" });
      lists.set(id, [...of(id), item]);
      changed(id);
      if (item.state !== "adding") return;
      queue = queue.then(async () => {
        if (!of(id).some((s) => s.key === key)) return; // removed before its turn
        try {
          settle(id, key, { state: "ready", file: await upload(id, blob, name) });
        } catch (e) {
          settle(id, key, { state: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
    remove(id, key) {
      const items = of(id);
      drop(items.filter((s) => s.key === key));
      lists.set(id, items.filter((s) => s.key !== key));
      changed(id);
    },
    list: of,
    busy: (id) => of(id).some((s) => s.state === "adding"),
    take(id) {
      const items = of(id);
      drop(items);
      lists.delete(id);
      changed(id);
      return items.flatMap((s) => (s.state === "ready" && s.file ? [s.file] : []));
    },
  };
}
