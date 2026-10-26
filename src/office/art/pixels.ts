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

/** A row `w` wide of `fill`, with strings stamped at the given columns. Builds the
 *  long regular rows of furniture without counting 32 characters by hand. */
export function row(w: number, fill: string, ...marks: [number, string][]): string {
  const cells = [...fill.repeat(w)];
  for (const [at, text] of marks) {
    if (at < 0 || at + text.length > w) throw new Error(`mark "${text}" at ${at} overflows ${w}`);
    for (let i = 0; i < text.length; i++) cells[at + i] = text[i];
  }
  return cells.join("");
}

/** A row `w` wide of `fill` between two outline pixels, plus marks. */
export function framed(w: number, fill: string, ...marks: [number, string][]): string {
  return row(w, fill, [0, "o"], [w - 1, "o"], ...marks);
}

/** An ellipse: centre (cx, cy), radii rx, ry. */
export type Ellipse = readonly [cx: number, cy: number, rx: number, ry: number];

/** A soft organic shape — the union of ellipses — lit from the top left and outlined.
 *  `keys` are light, base and dark; `speckle` sprinkles dark texture (leaves). */
export function blob(
  w: number,
  h: number,
  shapes: readonly Ellipse[],
  keys = "456",
  speckle = 0,
): string[] {
  const inside = (x: number, y: number) =>
    x >= 1 && y >= 1 && x < w - 1 && y < h - 1 &&
    shapes.some(([cx, cy, rx, ry]) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1);
  const random = seeded(w * 131 + h * 7 + shapes.length);
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      if (inside(x, y)) {
        const lit = !inside(x, y - 1) || !inside(x - 1, y);
        const shaded = !inside(x, y + 1) || !inside(x + 1, y) || !inside(x + 1, y + 1);
        if (shaded) line += keys[2];
        else if (lit) line += keys[0];
        else line += random() < speckle ? keys[2] : keys[1];
      } else {
        const edge = inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1);
        line += edge ? "o" : TRANSPARENT;
      }
    }
    rows.push(line);
  }
  return rows;
}

/** A small deterministic random source, so generated art is the same every run. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
