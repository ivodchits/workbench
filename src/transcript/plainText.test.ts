import { describe, expect, it } from "vitest";

import type { TranscriptPage } from "../ipc/transcript";
import { fixtures, sessionLines } from "./fixtures.test-util";
import { readPlainText } from "./plainText";

/** A reader over `lines`, `pageLines` at a time; counts its reads. */
function reader(
  lines: string[],
  pageLines: number,
  sessionId: (start: number) => string = () => "s",
) {
  const r = {
    reads: 0,
    read(before?: number): Promise<TranscriptPage> {
      r.reads++;
      const end = before ?? lines.length;
      const start = Math.max(0, end - pageLines);
      return Promise.resolve({
        sessionId: sessionId(start),
        lines: lines.slice(start, end),
        offset: start,
        nextOffset: end,
        end: lines.length,
      });
    },
  };
  return r;
}

const all = { maxItems: 200, maxChars: 1_000_000 };

describe("readPlainText", () => {
  it("writes the user, Claude and a line per tool call, leaving thinking out", async () => {
    const { text, truncated } = await readPlainText(
      reader(fixtures["02-read"], 100).read,
      all,
    );
    expect(truncated).toBe(false);
    const lines = text.split("\n").map((l) => l.replace(/^\[\d\d:\d\d\] /, ""));
    expect(lines[0]).toMatch(
      /^user: Think step by step about what 17 \* 23 is/,
    );
    expect(lines).toContain("tool Read: …/proj/notes.txt");
    expect(text).not.toMatch(/thinking/i);
    expect(lines[lines.length - 1]).toMatch(/^The product is 17 × 23 = 391/);
  });

  it("marks failed and denied calls, interruptions and compaction", async () => {
    const { text } = await readPlainText(reader(sessionLines, 1000).read, all);
    expect(text).toContain("tool Edit: …/proj/calc.py [denied]");
    expect(text).toMatch(
      /tool Read: …\/proj\/missing\.txt \[error\]\n {2}→ File does not exist/,
    );
    expect(text).toContain("[interrupted by the user]");
    expect(text).toContain("--- context compacted ---");
    expect(text).toContain("tool Question: Which color do you prefer? → Green");
    expect(text).toContain("command /context");
  });

  it("keeps the last items and pages back only as far as it needs", async () => {
    const r = reader(sessionLines, 20);
    const out = await readPlainText(r.read, { maxItems: 3, maxChars: 100_000 });
    expect(out.items).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.text.split("\n").pop()).toMatch(/claude: AFTERCOMPACT$/);
    expect(r.reads).toBeLessThan(Math.ceil(sessionLines.length / 20));
  });

  it("drops the oldest lines to stay under the character cap", async () => {
    const out = await readPlainText(reader(sessionLines, 1000).read, {
      maxItems: 200,
      maxChars: 600,
    });
    expect(out.text.length).toBeLessThanOrEqual(600 + 10);
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/AFTERCOMPACT$/);
  });

  it("stops at another session's page and reads nothing from an empty transcript", async () => {
    const r = reader(sessionLines, 30, (start) =>
      start >= sessionLines.length - 30 ? "new" : "old",
    );
    const out = await readPlainText(r.read, all);
    expect(r.reads).toBe(2);
    expect(out.truncated).toBe(true);
    expect(await readPlainText(reader([], 10).read, all)).toEqual({
      text: "",
      items: 0,
      truncated: false,
      lastAt: null,
    });
  });

  it("with `since`, keeps only later items and pages back no further than it", async () => {
    const stamps = sessionLines
      .map((l) => (JSON.parse(l) as { timestamp?: string }).timestamp)
      .filter((t): t is string => !!t)
      .map((t) => Date.parse(t));
    const last = Math.max(...stamps);
    const cut = stamps[Math.floor(stamps.length * 0.8)];
    const r = reader(sessionLines, 20);
    const out = await readPlainText(r.read, { ...all, since: cut });
    expect(out.items).toBeGreaterThan(0);
    expect(out.truncated).toBe(false);
    expect(out.lastAt).toBeGreaterThan(cut);
    expect(out.lastAt).toBeLessThanOrEqual(last);
    expect(out.text).toMatch(/AFTERCOMPACT$/);
    expect(r.reads).toBeLessThan(Math.ceil(sessionLines.length / 20));
    const full = await readPlainText(reader(sessionLines, 1000).read, all);
    expect(out.items).toBeLessThan(full.items);
    expect(await readPlainText(reader(sessionLines, 20).read, { ...all, since: last })).toMatchObject({ text: "", items: 0 });
  });
});
