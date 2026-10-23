// Files waiting to go with the next message (step G1): pasted, dropped on the
// drawer (`useFileDrop`) or picked with 📎 (`pickFiles`). Each is stored at once (`attachments.rs`), shown as a
// chip above the composer, and sent with the message; nothing goes to Duck before
// you send. An external store in the house pattern.

import { useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { attachBytes, attachPaths, type StoredFile } from "../../ipc/assistant";
import { MAX_ATTACHMENTS, type AttachmentRef } from "../../assistant/attachments";
import { isOsFileDrag, osDropPaths, osDropSupported } from "../../ipc/osDrop";
import { isFileDrag, readDragPaths } from "../../state/fileDrag";

export interface Staging {
  files: AttachmentRef[];
  /** Files still being stored. */
  storing: number;
  /** What couldn't be stored, for the line above the chips. */
  error: string | null;
}

let state: Staging = { files: [], storing: 0, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<Staging>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getStaging = (): Staging => state;

export function useStaging(): Staging {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

const asRef = (s: StoredFile): AttachmentRef => ({
  id: s.id,
  name: s.name,
  mime: s.mime,
  size: s.size,
  path: s.path,
  ...(s.thumb && { thumb: s.thumb }),
});

function add(stored: StoredFile[], failed: string[]): void {
  const files = [...state.files];
  for (const s of stored) if (!files.some((f) => f.id === s.id && f.name === s.name)) files.push(asRef(s));
  const over = files.length > MAX_ATTACHMENTS;
  set({
    files: files.slice(0, MAX_ATTACHMENTS),
    error: over ? `At most ${MAX_ATTACHMENTS} files go with one message.` : failed.length ? failed.join("; ") : null,
  });
}

/** Stage files by path: a drop from Explorer or the editor, the picker. */
export async function stagePaths(paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].filter(Boolean);
  if (!unique.length) return;
  set({ storing: state.storing + unique.length });
  try {
    const r = await attachPaths(unique);
    add(r.stored, r.failed);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    set({ storing: Math.max(0, state.storing - unique.length) });
  }
}

/** base64 of a blob's bytes. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A pasted image's name: the clipboard calls every one `image.png`. */
export function pastedName(file: File, now = new Date()): string {
  if (file.name && file.name !== "image.png") return file.name;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `pasted-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

/** Stage files by their bytes: a paste. */
export async function stageBlobs(files: readonly File[]): Promise<void> {
  if (!files.length) return;
  set({ storing: state.storing + files.length });
  const stored: StoredFile[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      stored.push(await attachBytes(pastedName(f), await base64(f)));
    } catch (e) {
      failed.push(`${f.name || "a pasted file"}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set({ storing: Math.max(0, state.storing - 1) });
    }
  }
  add(stored, failed);
}

export function unstage(id: string, name: string): void {
  set({ files: state.files.filter((f) => !(f.id === id && f.name === name)), error: null });
}

/** The staged files, for the message being sent; the chips go. */
export function takeStaged(): AttachmentRef[] {
  const files = state.files;
  set({ files: [], error: null });
  return files;
}

export function clearStagingError(): void {
  set({ error: null });
}

/** The 📎 picker. */
export async function pickFiles(): Promise<void> {
  const picked = await open({ multiple: true, directory: false, title: "Files for Duck" });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  await stagePaths(paths);
}

/** Pasted files (an image on the clipboard, files copied in Explorer): staged
 *  instead of pasted as text. True when the paste was taken. */
export function pasteFiles(data: DataTransfer | null): boolean {
  const files = Array.from(data?.files ?? []);
  if (!files.length) return false;
  void stageBlobs(files);
  return true;
}

/** The drawer as a drop target: files from Explorer, and from the editor tree,
 *  the Diff list and the Git list (`state/fileDrag`). */
export function useFileDrop() {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const accepts = (e: React.DragEvent) => isFileDrag(e.dataTransfer) || (osDropSupported() && isOsFileDrag(e.dataTransfer));
  const leave = () => {
    depth.current = 0;
    setOver(false);
  };
  return {
    over,
    handlers: {
      onDragEnter(e: React.DragEvent) {
        if (!accepts(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver(e: React.DragEvent) {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(e: React.DragEvent) {
        if (!accepts(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) leave();
      },
      onDrop(e: React.DragEvent) {
        if (!accepts(e)) return;
        e.preventDefault();
        leave();
        if (isFileDrag(e.dataTransfer)) void stagePaths(readDragPaths(e.dataTransfer));
        // Read now: the drop's files are gone once the event ends.
        else void osDropPaths(Array.from(e.dataTransfer.files)).then(stagePaths);
      },
    },
  };
}
