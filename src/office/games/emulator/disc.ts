// A disc's track read as the core reads it (office plan O5.3f): a PlayStation CD is
// hundreds of megabytes, so the page never holds it whole. The core's file reads can't
// wait on a promise, so a piece it needs is fetched there and then (a synchronous
// request); the piece after is fetched ahead meanwhile, so reading straight on (a
// film, music) rarely waits. The latest pieces are kept.

/** A disc file read in pieces, never whole. */
export interface Part {
  name: string;
  size: number;
  /** Bytes `start` to `end` (not included), within the file; throws when they can't be
   *  read. */
  read(start: number, end: number): Uint8Array;
}

/** Reads bytes `start` to `end` of a file: now, or later. */
export interface Reader {
  now(start: number, end: number): Uint8Array | null;
  later(start: number, end: number): Promise<Uint8Array | null>;
}

/** How much one fetch brings: a second or three of a CD read straight on. */
export const PIECE = 1024 * 1024;
/** How many pieces are kept. */
export const KEPT = 48;

export function lazyPart(name: string, size: number, reader: Reader): Part {
  const pieces = new Map<number, Uint8Array>();
  const coming = new Set<number>();

  const span = (i: number): [number, number] => [i * PIECE, Math.min(size, (i + 1) * PIECE)];
  const keep = (i: number, bytes: Uint8Array) => {
    pieces.delete(i);
    pieces.set(i, bytes);
    while (pieces.size > KEPT) pieces.delete(pieces.keys().next().value!);
  };
  const ahead = (i: number) => {
    if (i * PIECE >= size || pieces.has(i) || coming.has(i)) return;
    coming.add(i);
    void reader
      .later(...span(i))
      .then((bytes) => {
        if (bytes && bytes.length === span(i)[1] - span(i)[0]) keep(i, bytes);
      })
      .catch(() => undefined)
      .finally(() => coming.delete(i));
  };
  const piece = (i: number) => {
    let bytes = pieces.get(i);
    if (bytes) {
      keep(i, bytes);
    } else {
      const [s, e] = span(i);
      const got = reader.now(s, e);
      if (!got || got.length !== e - s) throw new Error(`couldn't read ${name} at ${s}`);
      keep(i, (bytes = got));
    }
    ahead(i + 1);
    return bytes;
  };

  return {
    name,
    size,
    read(start, end) {
      end = Math.min(end, size);
      const out = new Uint8Array(Math.max(0, end - start));
      for (let at = start; at < end; ) {
        const i = Math.floor(at / PIECE);
        const bytes = piece(i);
        const from = at - i * PIECE;
        const n = Math.min(bytes.length - from, end - at);
        out.set(bytes.subarray(from, from + n), at - start);
        at += n;
      }
      return out;
    },
  };
}

/** Bytes as a synchronous request gives them: a character each. */
function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Reads `url` in ranges, signed with `headers`. */
export function rangeReader(url: string, headers: Record<string, string>): Reader {
  const range = (start: number, end: number) => ({ ...headers, Range: `bytes=${start}-${end - 1}` });
  return {
    now(start, end) {
      const xhr = new XMLHttpRequest();
      // Synchronous, so its body can't be an ArrayBuffer: read as text, a byte a character.
      xhr.open("GET", url, false);
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
      for (const [k, v] of Object.entries(range(start, end))) xhr.setRequestHeader(k, v);
      try {
        xhr.send();
      } catch {
        return null;
      }
      return xhr.status === 206 || xhr.status === 200 ? bytesOf(xhr.responseText) : null;
    },
    async later(start, end) {
      try {
        const res = await fetch(url, { headers: range(start, end) });
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
  };
}
