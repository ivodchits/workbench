// The office's pixel format (office plan OD.1): sprites are written as rows of
// characters, one character per pixel, and coloured at draw time by a key → colour
// map. `.` is always transparent. Keeping the art as text means it lives in the
// repo as code, diffs line by line, and one template serves every worker: the
// same body drawn with a different map is a different person.

/** A sprite part: rows of key characters, placed at (x, y) inside its frame. */
export interface Part {
  rows: readonly string[];
  x?: number;
  y?: number;
}

/** Key → colour (`#rrggbb`). A key with no entry is a bug, not transparency. */
export type ColorMap = Readonly<Record<string, string>>;

/** An RGBA image, row-major, 4 bytes per pixel. */
export interface Bitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export const TRANSPARENT = ".";

export function bitmap(w: number, h: number): Bitmap {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** Every row the same width — a ragged template is a typo that shifts pixels. */
export function checkPart(part: Part, label: string): void {
  const width = part.rows[0]?.length ?? 0;
  part.rows.forEach((row, i) => {
    if (row.length !== width) {
      throw new Error(`${label}: row ${i} is ${row.length} wide, expected ${width}: "${row}"`);
    }
  });
}

/** The keys a part uses, transparency excluded. */
export function keysOf(part: Part): Set<string> {
  const keys = new Set<string>();
  for (const row of part.rows) for (const k of row) if (k !== TRANSPARENT) keys.add(k);
  return keys;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgbCache = new Map<string, [number, number, number]>();

/** Paint `part` onto `out` at its offset (plus `dx`, `dy`); pixels outside are dropped. */
export function draw(out: Bitmap, part: Part, colors: ColorMap, dx = 0, dy = 0): void {
  const ox = (part.x ?? 0) + dx;
  const oy = (part.y ?? 0) + dy;
  part.rows.forEach((row, r) => {
    const y = oy + r;
    if (y < 0 || y >= out.h) return;
    for (let c = 0; c < row.length; c++) {
      const key = row[c];
      if (key === TRANSPARENT) continue;
      const x = ox + c;
      if (x < 0 || x >= out.w) continue;
      const hex = colors[key];
      if (hex === undefined) throw new Error(`no colour for key "${key}"`);
      let px = rgbCache.get(hex);
      if (!px) rgbCache.set(hex, (px = rgb(hex)));
      const i = (y * out.w + x) * 4;
      out.data[i] = px[0];
      out.data[i + 1] = px[1];
      out.data[i + 2] = px[2];
      out.data[i + 3] = 255;
    }
  });
}

/** A part flipped left ↔ right within a frame `width` wide. */
export function mirror(part: Part, width: number): Part {
  const w = part.rows[0]?.length ?? 0;
  return {
    rows: part.rows.map((row) => [...row].reverse().join("")),
    x: width - (part.x ?? 0) - w,
    y: part.y,
  };
}

/** A bitmap flipped left ↔ right. */
export function mirrorBitmap(src: Bitmap): Bitmap {
  const out = bitmap(src.w, src.h);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const from = (y * src.w + x) * 4;
      const to = (y * src.w + (src.w - 1 - x)) * 4;
      out.data.set(src.data.subarray(from, from + 4), to);
    }
  }
  return out;
}
