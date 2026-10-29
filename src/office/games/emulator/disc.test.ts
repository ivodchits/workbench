import { describe, expect, it } from "vitest";

import { KEPT, PIECE, lazyPart, type Reader } from "./disc";

/** A file whose byte at `i` is `i % 251`, read through a reader that logs each fetch. */
function fakeReader(size: number, failAt = -1) {
  const log: string[] = [];
  const bytes = (start: number, end: number) => Uint8Array.from({ length: end - start }, (_, k) => (start + k) % 251);
  const later: (() => void)[] = [];
  const reader: Reader = {
    now(start, end) {
      log.push(`now ${start / PIECE}`);
      return start === failAt ? null : bytes(start, Math.min(end, size));
    },
    later(start, end) {
      log.push(`later ${start / PIECE}`);
      return new Promise((r) => later.push(() => r(bytes(start, Math.min(end, size)))));
    },
  };
  return { reader, log, later, bytes };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a disc's track read in pieces", () => {
  it("reads what's asked, across pieces, fetching each once and the next ahead", async () => {
    const size = 3 * PIECE + 100;
    const { reader, log, later, bytes } = fakeReader(size);
    const part = lazyPart("game.bin", size, reader);
    expect(part.read(PIECE - 10, PIECE + 10)).toEqual(bytes(PIECE - 10, PIECE + 10));
    // Piece 0 now, then 1 now too (the one ahead hadn't come), and 2 ahead.
    expect(log).toEqual(["now 0", "later 1", "now 1", "later 2"]);
    later.forEach((go) => go());
    await flush();
    log.length = 0;
    expect(part.read(2 * PIECE, 2 * PIECE + 4)).toEqual(bytes(2 * PIECE, 2 * PIECE + 4));
    expect(part.read(5, 9)).toEqual(bytes(5, 9));
    // Piece 2 came ahead, piece 0 was kept; piece 3 is fetched ahead.
    expect(log).toEqual(["later 3"]);
  });

  it("stops at the end of the file, and throws when a piece can't be read", () => {
    const { reader } = fakeReader(PIECE + 50);
    const part = lazyPart("game.bin", PIECE + 50, reader);
    expect(part.read(PIECE - 2, PIECE * 9).length).toBe(52);
    const failing = lazyPart("game.bin", PIECE + 50, fakeReader(PIECE + 50, 0).reader);
    expect(() => failing.read(0, 4)).toThrow(/game\.bin/);
  });

  it("keeps only the latest pieces", () => {
    const size = (KEPT + 2) * PIECE;
    const { reader, log } = fakeReader(size);
    const part = lazyPart("game.bin", size, reader);
    for (let i = 0; i <= KEPT; i++) part.read(i * PIECE, i * PIECE + 1);
    log.length = 0;
    part.read(PIECE, PIECE + 1);
    expect(log.filter((l) => l.startsWith("now"))).toEqual([]);
    part.read(0, 1);
    expect(log.filter((l) => l.startsWith("now"))).toEqual(["now 0"]);
  });
});
