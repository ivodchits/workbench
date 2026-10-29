import { describe, expect, it } from "vitest";

import type { PictionaryAnswer, PictionaryRequest } from "../../../remote/pictionary";
import { readPad, type Pad } from "../pad";
import { BOARD_H, BOARD_W, fromDuck, linePixels } from "./board";
import {
  BOARD_X,
  BOARD_Y,
  DRAWING_MAX,
  ERRORS_MAX,
  GUESSES_MAX,
  LOOK_GAP,
  LOOK_PAUSE,
  ROUND_STEPS,
  TYPED_MAX,
  backPict,
  blanks,
  buttons,
  keyPict,
  penDone,
  pictState,
  pointerPict,
  startRound,
  stepPict,
  type PictDeps,
  type PictState,
} from "./pictionary";
import { distance, matches, normal, pickWord, WORDS } from "./words";

const idle = readPad(new Set());
const press: Pad = { ...idle, a: true };

/** Deps whose asks wait until answered by hand. */
function fake(random = () => 0) {
  const asked: { req: PictionaryRequest; answer: (a: PictionaryAnswer | null) => void }[] = [];
  const deps: PictDeps = {
    ask: (req) => new Promise((answer) => asked.push({ req, answer })),
    picture: (strokes) => `png:${strokes.length}`,
    random,
  };
  return { deps, asked };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const run = (s: PictState, deps: PictDeps, steps: number, pad = idle) => {
  for (let n = 0; n < steps; n++) stepPict(s, pad, deps);
};
/** A stroke drawn on the board, from (x0, y0) to (x1, y1) in board pixels. */
function stroke(s: PictState, deps: PictDeps, x0: number, y0: number, x1: number, y1: number) {
  pointerPict(s, "down", BOARD_X + x0, BOARD_Y + y0, deps);
  pointerPict(s, "move", BOARD_X + (x0 + x1) / 2, BOARD_Y + (y0 + y1) / 2, deps);
  pointerPict(s, "up", BOARD_X + x1, BOARD_Y + y1, deps);
}
const click = (s: PictState, deps: PictDeps, id: string) => {
  const b = buttons(s).find((b) => b.id === id)!;
  pointerPict(s, "down", b.x + 1, b.y + 1, deps);
  pointerPict(s, "up", b.x + 1, b.y + 1, deps);
};

describe("checking a guess", () => {
  it("takes the word however it's said", () => {
    expect(matches("Bicycle", "bicycle")).toBe(true);
    expect(matches("a red apple", "apple")).toBe(true);
    expect(matches("Is it a rocket?", "rocket")).toBe(true);
    expect(matches("it's an apple!", "apple")).toBe(true);
    expect(matches("apples", "apple")).toBe(true);
    expect(matches("bike", "bicycle", ["bike"])).toBe(true);
    expect(matches("ice cream", "ice cream")).toBe(true);
  });

  it("forgives a slip of a letter in a longer word, not in a short one", () => {
    expect(matches("bycicle", "bicycle")).toBe(false); // two letters off
    expect(matches("bicycel", "bicycle")).toBe(false);
    expect(matches("bicyle", "bicycle")).toBe(true);
    expect(matches("elefant", "elephant")).toBe(false);
    expect(matches("girafe", "giraffe")).toBe(true);
    expect(matches("cot", "cat")).toBe(false);
    expect(distance("kitten", "sitting")).toBe(3);
  });

  it("doesn't take another word, or nothing", () => {
    expect(matches("pineapple", "apple")).toBe(false);
    expect(matches("", "apple")).toBe(false);
    expect(matches("the", "apple")).toBe(false);
    expect(normal("The Glasses!")).toBe(normal("glasses"));
  });

  it("picks a word not used lately", () => {
    const recent = WORDS.slice(1).map((w) => w.word);
    expect(pickWord(recent, () => 0.5).word).toBe(WORDS[0].word);
    expect(WORDS.map((w) => w.word)).toEqual([...new Set(WORDS.map((w) => w.word))]);
  });
});

describe("the board", () => {
  it("draws a line's pixels end to end, each once", () => {
    const px = linePixels([0, 0], [5, 2]);
    expect(px[0]).toEqual([0, 0]);
    expect(px[px.length - 1]).toEqual([5, 2]);
    expect(px).toHaveLength(6);
    expect(linePixels([3, 3], [3, 3])).toEqual([[3, 3]]);
  });

  it("takes Duck's strokes onto its own size", () => {
    const [s] = fromDuck([{ color: "red", points: [[0, 0], [300, 200]] }]);
    expect(s.points).toEqual([[0, 0], [BOARD_W - 1, BOARD_H - 1]]);
  });
});

describe("you draw, Duck guesses", () => {
  function drawing(word = 0) {
    const f = fake(() => word);
    const s = pictState();
    run(s, f.deps, 1); // let go of the press that opened it
    startRound(s, "you", f.deps);
    return { s, ...f };
  }

  it("starts from the menu with a word to draw", () => {
    const { deps } = fake();
    const s = pictState();
    stepPict(s, press, deps); // still held from opening
    expect(s.phase).toBe("menu");
    stepPict(s, idle, deps);
    stepPict(s, press, deps);
    expect(s.phase).toBe("you");
    expect(s.word).toBe(WORDS[0].word);
  });

  it("draws strokes with the marker in hand, undoes and clears them", () => {
    const { s, deps } = drawing();
    keyPict(s, "2", false, deps);
    stroke(s, deps, 10, 10, 50, 40);
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0].color).toBe("red");
    expect(s.strokes[0].points.length).toBeGreaterThan(1);
    expect(s.drawing).toBeNull();
    stroke(s, deps, 60, 60, 70, 70);
    expect(keyPict(s, "z", true, deps)).toBe(true);
    expect(s.strokes).toHaveLength(1);
    click(s, deps, "clear");
    expect(s.strokes).toHaveLength(0);
    // Off the board draws nothing.
    pointerPict(s, "down", 1, 1, deps);
    expect(s.strokes).toHaveLength(0);
  });

  it("has Duck look once you pause, and not while you draw", async () => {
    const { s, deps, asked } = drawing();
    run(s, deps, LOOK_GAP);
    expect(asked).toHaveLength(0); // nothing on the board
    pointerPict(s, "down", BOARD_X + 10, BOARD_Y + 10, deps);
    run(s, deps, LOOK_PAUSE * 3);
    expect(asked).toHaveLength(0); // still drawing
    pointerPict(s, "up", BOARD_X + 40, BOARD_Y + 30, deps);
    run(s, deps, LOOK_PAUSE - 1);
    expect(asked).toHaveLength(0);
    run(s, deps, 1);
    expect(asked).toHaveLength(1);
    expect(asked[0].req).toEqual({ kind: "guess", png: "png:1", guessed: [] });
    expect(s.asking).toBe(true);
    asked[0].answer({ status: "ok", result: { kind: "guess", guess: "hat", says: "A hat?" } });
    await settle();
    expect(s.guesses).toEqual(["HAT"]);
    expect(s.says).toBe("A HAT?");
    // Nothing new on the board: no new look.
    run(s, deps, LOOK_GAP * 2);
    expect(asked).toHaveLength(1);
    // Something new: a look, with what it guessed already, but not before the gap.
    stroke(s, deps, 50, 50, 60, 60);
    run(s, deps, LOOK_PAUSE);
    expect(asked).toHaveLength(2);
    expect(asked[1].req).toMatchObject({ guessed: ["HAT"] });
  });

  it("ends when Duck gets it", async () => {
    const { s, deps, asked } = drawing();
    stroke(s, deps, 10, 10, 50, 40);
    run(s, deps, LOOK_PAUSE);
    asked[0].answer({ status: "ok", result: { kind: "guess", guess: `a big ${s.word}`, says: "Easy!" } });
    await settle();
    expect(s.phase).toBe("over");
    expect(s.won).toBe(true);
    expect([s.wins, s.played]).toEqual([1, 1]);
  });

  it("stops looking after its guesses, or after failed looks", async () => {
    const { s, deps, asked } = drawing();
    for (let n = 0; n < GUESSES_MAX + 2; n++) {
      stroke(s, deps, 10 + n, 10, 50, 40);
      run(s, deps, LOOK_GAP);
      asked[asked.length - 1]?.answer({ status: "ok", result: { kind: "guess", guess: `thing ${n}`, says: "Hmm" } });
      await settle();
    }
    expect(asked).toHaveLength(GUESSES_MAX);
    expect(s.says).toBe("I GIVE UP. WHAT IS IT?");

    const b = drawing();
    for (let n = 0; n < ERRORS_MAX + 2; n++) {
      // A failed look is tried again at the next pause, even with nothing new drawn.
      if (n === 0) stroke(b.s, b.deps, 10, 10, 50, 40);
      run(b.s, b.deps, LOOK_GAP);
      b.asked[b.asked.length - 1]?.answer({ status: "error", message: "offline" });
      await settle();
    }
    expect(b.asked).toHaveLength(ERRORS_MAX);
    expect(b.s.says).toBe("I CAN'T SEE THE BOARD: OFFLINE");
  });

  it("runs out of time, and gives up when asked", () => {
    const { s, deps } = drawing();
    run(s, deps, ROUND_STEPS);
    expect(s.phase).toBe("over");
    expect(s.won).toBe(false);
    startRound(s, "you", deps);
    click(s, deps, "pass");
    expect([s.phase, s.wins, s.played]).toEqual(["over", 0, 2]);
  });

  it("drops an answer for a round already left", async () => {
    const { s, deps, asked } = drawing();
    stroke(s, deps, 10, 10, 50, 40);
    run(s, deps, LOOK_PAUSE);
    expect(backPict(s)).toBe(true);
    expect(s.phase).toBe("menu");
    asked[0].answer({ status: "ok", result: { kind: "guess", guess: s.word, says: "Got it" } });
    await settle();
    expect([s.phase, s.wins, s.played]).toEqual(["menu", 0, 0]);
    // From the menu, Esc closes the game.
    expect(backPict(s)).toBe(false);
  });

  it("doesn't give the same word again soon", () => {
    const { s, deps } = drawing();
    const first = s.word;
    startRound(s, "you", deps);
    expect(s.word).not.toBe(first);
  });
});

describe("Duck draws, you guess", () => {
  const DRAWING: PictionaryAnswer = {
    status: "ok",
    result: {
      kind: "draw",
      word: "sun",
      also: ["sunshine"],
      strokes: [
        { color: "black", points: [[100, 100], [200, 100], [200, 150]] },
        { color: "red", points: [[10, 10]] },
      ],
    },
  };

  async function watching(answer: PictionaryAnswer = DRAWING) {
    const f = fake();
    const s = pictState();
    startRound(s, "duck", f.deps);
    expect(s.phase).toBe("picking");
    expect(f.asked[0].req).toEqual({ kind: "draw", avoid: [] });
    f.asked[0].answer(answer);
    await settle();
    return { s, ...f };
  }

  it("draws its strokes in order, a little each step", async () => {
    const { s, deps } = await watching();
    expect(s.phase).toBe("duck");
    expect(s.word).toBe("sun");
    stepPict(s, idle, deps);
    expect(s.strokes).toHaveLength(1);
    // Partway along the first stroke: its start and the marker's tip.
    expect(s.strokes[0].points).toHaveLength(2);
    expect(s.strokes[0].points[1][0]).toBeLessThan(BOARD_W / 2);
    run(s, deps, DRAWING_MAX);
    expect(penDone(s)).toBe(true);
    expect(s.strokes.map((st) => st.points.length)).toEqual([3, 1]);
    expect(s.strokes[1].color).toBe("red");
  });

  it("takes typed guesses, wrong ones listed, a right one winning", async () => {
    const { s, deps } = await watching();
    for (const k of [..."moon"]) keyPict(s, k, false, deps);
    expect(s.typed).toBe("MOON");
    keyPict(s, "Backspace", false, deps);
    expect(s.typed).toBe("MOO");
    keyPict(s, "Enter", false, deps);
    expect(s.guesses).toEqual(["MOO"]);
    expect(s.typed).toBe("");
    // Ctrl held isn't typing, nor is a key that's no letter.
    expect(keyPict(s, "a", true, deps)).toBe(false);
    expect(keyPict(s, "ArrowUp", false, deps)).toBe(false);
    for (const k of [..."sunshine"]) keyPict(s, k, false, deps);
    keyPict(s, "Enter", false, deps);
    expect([s.phase, s.won, s.wins]).toEqual(["over", true, 1]);
    // The drawing is shown whole once it's over.
    expect(s.strokes).toHaveLength(2);
  });

  it("keeps a guess to its length and doesn't start one with a space", async () => {
    const { s, deps } = await watching();
    keyPict(s, " ", false, deps);
    for (let n = 0; n < TYPED_MAX + 5; n++) keyPict(s, "a", false, deps);
    expect(s.typed).toBe("A".repeat(TYPED_MAX));
  });

  it("shows a letter halfway and another at three quarters, never all", async () => {
    const { s, deps } = await watching();
    expect(blanks(s)).toBe("_ _ _");
    expect(blanks({ ...s, word: "ice cream", hints: [4] })).toBe("_ _ _    C _ _ _ _");
    run(s, deps, ROUND_STEPS / 2);
    expect(s.hints).toHaveLength(1);
    run(s, deps, ROUND_STEPS / 4);
    expect(s.hints).toHaveLength(2);
    expect(blanks(s).replace(/ /g, "")).toMatch(/^[A-Z_]{3}$/);
    expect(blanks(s)).toContain("_");
    run(s, deps, ROUND_STEPS);
    expect([s.phase, s.won]).toEqual(["over", false]);
  });

  it("says so when there's no drawing", async () => {
    const { s } = await watching({ status: "error", message: "offline" });
    expect([s.phase, s.word, s.played]).toEqual(["over", "", 0]);
    expect(s.says).toBe("MY MARKER'S DRY: OFFLINE");
  });

  it("asks for a word not drawn lately", async () => {
    const { s, deps, asked } = await watching();
    click(s, deps, "pass");
    click(s, deps, "again");
    expect(asked[1].req).toEqual({ kind: "draw", avoid: ["sun"] });
  });
});
