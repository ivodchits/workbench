import { describe, expect, it } from "vitest";

import { cleanWord, input, isSpanishRoot, learnerOf } from "./officeSpanish";

const PROFILE = JSON.stringify({
  name: "Igor",
  nativeLanguages: ["English", "Russian"],
  dialectTarget: "Mexican Spanish (CDMX)",
  level: { start: "absolute-beginner", current: "A2" },
  interests: ["chess"],
  lifeContext: ["ordering food in restaurants"],
  knownSeedWords: ["gato", "perro"],
});
const SRS = JSON.stringify({ items: [{ id: "v1", front: "por favor" }, { id: "v2", front: "gato" }, { id: "v3" }] });
const PROGRESS = JSON.stringify({ currentTopic: { id: "0005", planPath: "plans/topics/0005-hay-numbers-quantities.md" } });

describe("officeSpanish", () => {
  it("finds the project by its folder, not its name", () => {
    expect(isSpanishRoot("C:\\Users\\me\\repos\\spanish-lessons")).toBe(true);
    expect(isSpanishRoot("/home/me/Spanish-Lessons/")).toBe(true);
    expect(isSpanishRoot("C:\\Users\\me\\repos\\spanish-lessons-anya")).toBe(false);
    expect(isSpanishRoot("C:\\Users\\me\\repos\\workbench")).toBe(false);
  });

  it("reads the learner from the state files", () => {
    const l = learnerOf(PROFILE, SRS, PROGRESS);
    expect(l.level).toBe("A2");
    expect(l.dialect).toBe("Mexican Spanish (CDMX)");
    expect(l.native).toEqual(["English", "Russian"]);
    // Known from before and studied since, once each.
    expect(l.known).toEqual(["gato", "perro", "por favor"]);
    expect(l.topic).toBe("0005-hay-numbers-quantities");
  });

  it("does without files that are missing or broken", () => {
    const l = learnerOf(null, "{not json", "[]");
    expect(l).toEqual({ level: null, dialect: null, native: [], interests: [], life: [], known: [], topic: null });
    expect(input(l, [], "2026-11-02", "music")).toContain("Level: beginner (A1).");
  });

  it("asks for a word at the level, avoiding the known and the recent ones", () => {
    const text = input(learnerOf(PROFILE, SRS, PROGRESS), ["la banqueta"], "2026-11-02", "food and eating out");
    expect(text).toContain("Theme: food and eating out.");
    expect(text).toContain("Level: A2.");
    expect(text).toContain("Words they know: gato; perro; por favor.");
    expect(text).toContain("The latest days' words: la banqueta.");
  });

  it("keeps the word to the card, accents and all", () => {
    const w = cleanWord({ word: "  la alcancía ", kind: "noun, feminine", meaning: "piggy bank", example: "Mi  alcancía está llena.", exampleEn: "My piggy bank is full.", note: "" });
    expect(w).toEqual({ word: "la alcancía", kind: "noun, feminine", meaning: "piggy bank", example: "Mi alcancía está llena.", exampleEn: "My piggy bank is full.", note: null });
    expect(cleanWord({ word: " ", kind: "", meaning: "", example: "", exampleEn: "", note: null })).toBeNull();
    expect(cleanWord({ word: "¿Qué onda?", kind: "phrase", meaning: "what's up", example: "", exampleEn: "", note: "x".repeat(500) })!.note).toHaveLength(200);
  });
});
