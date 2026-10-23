// Attachments (step G1): files you paste, drop or pick into Duck.
//
// A file is stored once by the backend (`attachments.rs`, content-addressed) and a
// message refers to it. When you send, the engine works out how each one is sent
// (`expand`): an image (downscaled), a PDF as a `document`, a small text file's
// text, or only its name, size and path. That choice, and a text file's text, are
// stored in the message as an `attachment` block, so every later request sends the
// same bytes (the cache, append-only history). `toApiBlocks` turns the block into
// what the API gets; an image's or PDF's bytes are read from disk at request time
// (`AttachmentHost.data`), the same file each time.
//
// Thrift: Duck reads attachments itself up to `attachmentTokens` (about 20k) a
// message; past that, the rest are referenced only, and the system prompt tells
// Duck to hand them to a worker (`run_task` with `files`).

import type { PreparedFile, StoredFile } from "../ipc/assistant";

/** What a surface sends with a message: a file it stored. */
export type AttachmentRef = Pick<StoredFile, "id" | "name" | "mime" | "size"> & { path?: string; thumb?: string };

/** A message's attachment, as stored in its content. */
export interface AttachmentBlock {
  type: "attachment";
  id: string;
  name: string;
  mime: string;
  size: number;
  path?: string;
  thumb?: string;
  /** How it's sent. */
  as: PreparedFile["as"];
  mediaType?: string;
  /** A text file's text. */
  text?: string;
  /** Why it's only referenced. */
  why?: string;
}

export interface AttachmentHost {
  prepare(id: string, name: string): Promise<PreparedFile>;
  /** An image's or a PDF's bytes as sent, base64. */
  data(id: string, name: string, kind: "image" | "document"): Promise<string>;
}

/** No attachment store (the phone's offline brain): every file is referenced. */
export const noFile = (): Promise<never> => Promise.reject(new Error("files can't be read here"));

/** At most this many files go with one message. */
export const MAX_ATTACHMENTS = 20;

export const isAttachment = (b: unknown): b is AttachmentBlock =>
  typeof b === "object" && b !== null && (b as { type?: unknown }).type === "attachment";

/** The attachments in a message's content. */
export function attachmentsOf(content: unknown): AttachmentBlock[] {
  return Array.isArray(content) ? content.filter(isAttachment) : [];
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How each of `refs` is sent with a message: read by Duck itself while the total
 * stays within `budget` tokens (in the order given), referenced only past it. A
 * file that can't be read is referenced with the reason.
 */
export async function expand(refs: readonly AttachmentRef[], host: AttachmentHost, budget: number): Promise<AttachmentBlock[]> {
  const prepared = await Promise.all(
    refs.map((r) =>
      host.prepare(r.id, r.name).catch((e: unknown): PreparedFile => ({ as: "ref", tokens: 0, why: e instanceof Error ? e.message : String(e) })),
    ),
  );
  let used = 0;
  return refs.map((r, i) => {
    const p = prepared[i];
    const base = {
      type: "attachment" as const,
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      ...(r.path && { path: r.path }),
      ...(r.thumb && { thumb: r.thumb }),
    };
    if (p.as === "ref") return { ...base, as: "ref", ...(p.why && { why: p.why }) };
    if (used + p.tokens > budget)
      return { ...base, as: "ref", why: `over what you read yourself in one message (about ${Math.round(budget / 1000)}k tokens)` };
    used += p.tokens;
    return { ...base, as: p.as, ...(p.mediaType && { mediaType: p.mediaType }), ...(p.text !== undefined && { text: p.text }) };
  });
}

const attr = (s: string) => s.replace(/[<>"&\n\r]/g, (c) => ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "&": "&amp;" })[c] ?? " ");

function tag(b: AttachmentBlock, extra = ""): string {
  return `<attachment id="${b.id}" name="${attr(b.name)}" type="${attr(b.mime)}" size="${sizeText(b.size)}"${extra}`;
}

/** The bytes an attachment's request needs, by `fileKey`. */
export type FileData = ReadonlyMap<string, string>;
export const fileKey = (b: Pick<AttachmentBlock, "id" | "as">) => `${b.id}:${b.as}`;

type ApiBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/** One attachment as the API gets it. Without `files` (a compaction's summary), or
 *  with its bytes missing, an image or PDF is referenced instead. */
export function toApiBlocks(b: AttachmentBlock, files?: FileData): ApiBlock[] {
  if (b.as === "text" && b.text !== undefined) {
    const body = b.text.replace(/<\/attachment>/gi, "</attachment_>");
    return [{ type: "text", text: `${tag(b, ' untrusted="true"')}>\n${body}\n</attachment>` }];
  }
  if (b.as === "image" || b.as === "document") {
    const data = files?.get(fileKey(b));
    if (data) {
      const label: ApiBlock = { type: "text", text: `${tag(b)} />` };
      return b.as === "image"
        ? [label, { type: "image", source: { type: "base64", media_type: b.mediaType ?? b.mime, data } }]
        : [label, { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: b.name }];
    }
    const why = files ? "the file is gone" : "not included here";
    return [{ type: "text", text: `${tag(b, b.path ? ` path="${attr(b.path)}"` : "")} />\n(${why})` }];
  }
  const why = b.why ? `Not read: ${b.why}.` : "Not read: you don't read this kind of file.";
  return [
    {
      type: "text",
      text: `${tag(b, b.path ? ` path="${attr(b.path)}"` : "")} />\n(${why} A worker can: run_task with files: ["${b.id}"].)`,
    },
  ];
}

/** The file `id` as this thread has it: sent with a message of yours, or made
 *  by a worker (a `files` notice); the latest wins. */
export function findAttachment(history: readonly { role: string; content: unknown }[], id: string): AttachmentRef | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const found =
      m.role === "user"
        ? attachmentsOf(m.content).find((b) => b.id === id)
        : m.role === "notice"
          ? (m.content as { files?: AttachmentRef[] } | null)?.files?.find((f) => f.id === id)
          : undefined;
    if (found) {
      const { id: fid, name, mime, size, path, thumb } = found;
      return { id: fid, name, mime, size, ...(path && { path }), ...(thumb && { thumb }) };
    }
  }
  return undefined;
}

/** One line for an attachment, where no file can be shown (the subscription
 *  brain's handoff, a transcript). */
export function attachmentLine(b: AttachmentBlock): string {
  return `attached: ${b.name} (${b.mime}, ${sizeText(b.size)}, id ${b.id})`;
}

/** Reads the bytes a history's attachments need, keeping the latest few in memory. */
export function createFileCache(host: AttachmentHost, max = 24) {
  const cache = new Map<string, string>();
  return async function load(blocks: readonly AttachmentBlock[]): Promise<FileData> {
    const out = new Map<string, string>();
    for (const b of blocks) {
      if (b.as !== "image" && b.as !== "document") continue;
      const key = fileKey(b);
      let data = cache.get(key);
      if (data === undefined) {
        data = await host.data(b.id, b.name, b.as).catch(() => "");
        if (!data) continue;
        cache.set(key, data);
        while (cache.size > max) cache.delete(cache.keys().next().value!);
      } else {
        cache.delete(key);
        cache.set(key, data);
      }
      out.set(key, data);
    }
    return out;
  };
}
