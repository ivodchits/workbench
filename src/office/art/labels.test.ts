import { describe, expect, it } from "vitest";

import { FONT_H, GLYPHS, textBitmap, textWidth } from "./font";
import { ICON_SIZE, nameTag, speechBubble, statusIcon, wrap, BUBBLE_TAIL, BUBBLE_TEXT_W, type Overhead } from "./labels";
import { checkPart, type Bitmap } from "./pixels";

const opaque = (b: Bitmap, x: number, y: number) => b.data[(y * b.w + x) * 4 + 3] === 255;

describe("font", () => {
  it("every glyph is a rectangle 5 tall", () => {
    for (const [ch, rows] of Object.entries(GLYPHS)) {
      expect(rows.length, ch).toBe(FONT_H);
      checkPart({ rows }, `glyph ${ch}`);
    }
  });

  it("measures text as glyphs plus a pixel between them", () => {
    expect(textWidth("")).toBe(0);
    expect(textWidth("A")).toBe(3);
    expect(textWidth("AM")).toBe(3 + 1 + 5);
    expect(textWidth("am")).toBe(textWidth("AM"));
  });

  it("draws unknown characters as ? instead of failing", () => {
    expect(textBitmap("é", "#ffffff").data).toEqual(textBitmap("?", "#ffffff").data);
  });
});

describe("name tags and icons", () => {
  it("fits the name, and the glyph when there is one", () => {
    const plain = nameTag("Mira", "#2fb5b0", null);
    const tagged = nameTag("Mira", "#2fb5b0", "working");
    expect(plain.w).toBe(textWidth("Mira") + 6);
    expect(tagged.w).toBe(plain.w + 7);
    expect(plain.h).toBe(FONT_H + 4);
    // Cut corners.
    expect(opaque(plain, 0, 0)).toBe(false);
    expect(opaque(plain, 1, 0)).toBe(true);
  });

  it("draws every status icon at 7×7", () => {
    const kinds: Overhead[] = ["working", "needs", "question", "escalated", "stuck", "done"];
    const seen = new Set<string>();
    for (const k of kinds) {
      const icon = statusIcon(k);
      expect([icon.w, icon.h]).toEqual([ICON_SIZE, ICON_SIZE]);
      seen.add(icon.data.join());
    }
    expect(seen.size).toBe(kinds.length);
  });
});

describe("speech bubbles", () => {
  it("wraps between words, within the width", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog again", BUBBLE_TEXT_W);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog again");
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(BUBBLE_TEXT_W);
  });

  it("grows a line per wrapped line and ends in a tail at the centre", () => {
    const one = speechBubble("Hi");
    const long = "a line long enough that it has to wrap onto another";
    const lines = wrap(long, BUBBLE_TEXT_W).length;
    expect(lines).toBeGreaterThan(1);
    expect(speechBubble(long).h - one.h).toBe((lines - 1) * (FONT_H + 1));
    const cx = Math.floor(one.w / 2);
    expect(opaque(one, cx, one.h - 1)).toBe(true);
    expect(opaque(one, cx - 1, one.h - 1)).toBe(false);
    expect(opaque(one, 0, one.h - BUBBLE_TAIL - 2)).toBe(true);
  });
});
