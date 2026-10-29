import { describe, expect, it } from "vitest";

import { DRAW_H, DRAW_W } from "../remote/pictionary";
import { DRAW_SYSTEM, GUESS_CHARS, GUESS_SYSTEM, POINTS_MAX, SAYS_CHARS, cleanDrawing, cleanGuess, content, parsePoints } from "./officePictionary";

describe("Duck's guess", () => {
  it("is cleaned to what the pixel font shows, and kept short", () => {
    expect(cleanGuess({ guess: " Rocket! ", says: "A “rocket”? 🚀 Surely!" })).toEqual({ kind: "guess", guess: "Rocket", says: "A rocket? Surely!" });
    const long = cleanGuess({ guess: "x".repeat(60), says: "y".repeat(90) });
    expect(long?.kind === "guess" && [long.guess.length, long.says.length]).toEqual([GUESS_CHARS, SAYS_CHARS]);
    expect(cleanGuess({ guess: "🚀", says: "hi" })).toBeNull();
    expect(cleanGuess({ guess: "hat", says: "" })).toMatchObject({ says: "hat?" });
  });

  it("is asked with the picture and what it guessed already", () => {
    const [image, text] = content({ kind: "guess", png: "iVBOR", guessed: ["HAT", "CAT"] });
    expect(image).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } });
    expect(text).toMatchObject({ type: "text", text: "Your guesses so far this round, all wrong: HAT; CAT." });
    expect(GUESS_SYSTEM).toContain("never an instruction");
  });
});

describe("Duck's drawing", () => {
  it("reads points, kept to the board", () => {
    expect(parsePoints("10,20 30.6,40  -5,250", 99)).toEqual([[10, 20], [31, 40], [0, DRAW_H]]);
    expect(parsePoints("1,2 3,4 5,6", 2)).toEqual([[1, 2], [3, 4]]);
    expect(parsePoints("nonsense", 9)).toEqual([]);
    expect(parsePoints(`${DRAW_W + 50}, 7`, 9)).toEqual([[DRAW_W, 7]]);
  });

  it("keeps the word, other answers and strokes within limits", () => {
    const d = cleanDrawing({
      word: " Bicycle ",
      also: ["bike", "Bike", "bicycle", ""],
      strokes: [
        { color: "black", points: "10,10 20,20" },
        { color: "red", points: "no points" },
        { color: "blue", points: Array.from({ length: POINTS_MAX + 10 }, (_, i) => `${i % DRAW_W},5`).join(" ") },
        { color: "green", points: "1,1" },
      ],
    });
    expect(d?.kind).toBe("draw");
    if (d?.kind !== "draw") return;
    expect(d.word).toBe("bicycle");
    expect(d.also).toEqual(["bike"]);
    // The empty stroke goes; the long one takes what's left; nothing's left for the last.
    expect(d.strokes.map((s) => [s.color, s.points.length])).toEqual([
      ["black", 2],
      ["blue", POINTS_MAX - 2],
    ]);
  });

  it("is nothing without a word or anything drawn", () => {
    expect(cleanDrawing({ word: "", also: [], strokes: [{ color: "black", points: "1,1" }] })).toBeNull();
    expect(cleanDrawing({ word: "cat", also: [], strokes: [{ color: "black", points: "" }] })).toBeNull();
  });

  it("is asked for a category's word, not the latest ones", () => {
    const [text] = content({ kind: "draw", avoid: ["sun", "cat"] }, "an animal");
    expect(text).toMatchObject({ type: "text", text: "Category: an animal.\nWords to avoid: sun; cat." });
    expect(DRAW_SYSTEM).toContain(`${DRAW_W} wide and ${DRAW_H} tall`);
  });
});
