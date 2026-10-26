import { describe, expect, it } from "vitest";

import { bitmap, blob, checkPart, draw, framed, keysOf, mirror, mirrorBitmap, row, seeded, type Bitmap } from "./pixels";

/** The pixel at (x, y) as `#rrggbb`, or "." when it's transparent. */
function at(b: Bitmap, x: number, y: number): string {
  const i = (y * b.w + x) * 4;
  if (b.data[i + 3] === 0) return ".";
  return "#" + [0, 1, 2].map((k) => b.data[i + k].toString(16).padStart(2, "0")).join("");
}

describe("parsing", () => {
  it("accepts a rectangular part and names a ragged row", () => {
    expect(() => checkPart({ rows: ["ab", "cd"] }, "ok")).not.toThrow();
    expect(() => checkPart({ rows: ["ab", "c", "de"] }, "desk")).toThrow(/desk: row 1 is 1 wide, expected 2/);
  });

  it("lists the keys a part uses, without transparency", () => {
    expect([...keysOf({ rows: ["a.b", ".a."] })].sort()).toEqual(["a", "b"]);
  });

  it("builds rows with marks stamped in", () => {
    expect(row(6, "-", [1, "ab"], [5, "z"])).toBe("-ab--z");
    expect(framed(5, " ", [2, "x"])).toBe("o x o");
    expect(() => row(4, "-", [3, "ab"])).toThrow(/overflows 4/);
  });

  it("generates the same blob every time, outlined and transparent outside", () => {
    const shape = [[6, 5, 4, 3]] as const;
    const a = blob(12, 10, shape, "456", 0.3);
    expect(blob(12, 10, shape, "456", 0.3)).toEqual(a);
    checkPart({ rows: a }, "blob");
    expect(a[0]).toBe(".".repeat(12));
    expect(a.join("")).toContain("o");
    expect([...keysOf({ rows: a })].sort()).toEqual(["4", "5", "6", "o"]);
  });

  it("seeds a repeatable random source", () => {
    const a = seeded(7);
    const b = seeded(7);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("drawing and recolouring", () => {
  const part = { rows: ["ab", ".a"] };

  it("paints keys in their colours and leaves . transparent", () => {
    const out = bitmap(2, 2);
    draw(out, part, { a: "#ff0000", b: "#00ff80" });
    expect([at(out, 0, 0), at(out, 1, 0), at(out, 0, 1), at(out, 1, 1)]).toEqual(["#ff0000", "#00ff80", ".", "#ff0000"]);
  });

  it("the same template with another map is another sprite", () => {
    const red = bitmap(2, 2);
    const blue = bitmap(2, 2);
    draw(red, part, { a: "#ff0000", b: "#000000" });
    draw(blue, part, { a: "#0000ff", b: "#000000" });
    expect(at(red, 0, 0)).toBe("#ff0000");
    expect(at(blue, 0, 0)).toBe("#0000ff");
    expect(at(blue, 0, 1)).toBe(".");
  });

  it("a key with no colour is an error", () => {
    expect(() => draw(bitmap(2, 2), part, { a: "#ffffff" })).toThrow(/no colour for key "b"/);
  });

  it("places a part at its offset plus dx, dy, and drops what falls outside", () => {
    const out = bitmap(3, 3);
    draw(out, { rows: ["ab", "ab"], x: 1, y: 1 }, { a: "#111111", b: "#222222" }, 1, 0);
    expect(at(out, 2, 1)).toBe("#111111");
    expect(at(out, 2, 2)).toBe("#111111");
    expect(at(out, 1, 1)).toBe(".");
    draw(out, { rows: ["ab"] }, { a: "#111111", b: "#333333" }, -1, -1);
    expect(out.data.length).toBe(3 * 3 * 4);
  });

  it("later parts paint over earlier ones", () => {
    const out = bitmap(2, 1);
    draw(out, { rows: ["aa"] }, { a: "#101010" });
    draw(out, { rows: [".b"] }, { b: "#202020" });
    expect([at(out, 0, 0), at(out, 1, 0)]).toEqual(["#101010", "#202020"]);
  });
});

describe("mirroring", () => {
  it("flips a part within its frame", () => {
    expect(mirror({ rows: ["abc"], x: 1, y: 2 }, 6)).toEqual({ rows: ["cba"], x: 2, y: 2 });
  });

  it("drawing the mirrored part matches mirroring the bitmap", () => {
    const colors = { a: "#aa0000", b: "#00bb00", c: "#0000cc" };
    const p = { rows: ["ab.", ".cc"], x: 1 };
    const drawn = bitmap(5, 2);
    draw(drawn, p, colors);
    const flipped = bitmap(5, 2);
    draw(flipped, mirror(p, 5), colors);
    expect(mirrorBitmap(drawn).data).toEqual(flipped.data);
  });
});
