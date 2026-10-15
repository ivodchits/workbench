import { describe, expect, it } from "vitest";

import { DEFAULT_REVIEW_PROMPT, fillReviewPrompt, parseFindings } from "./reviewFindings";

describe("review findings", () => {
  it("are read from the last findings block", () => {
    const reply = [
      "I looked at the diff.",
      "",
      "```findings",
      "src/calc.py:10 | high | divide by zero is not handled",
      "- `src/greet.py:4-6` | Low | the farewell repeats itself",
      "./src/x.ts:3 | medium | uses == where === is meant",
      "this line is chatter and is skipped",
      "```",
    ].join("\n");
    expect(parseFindings(reply)).toEqual([
      { path: "src/calc.py", fromLine: 10, toLine: 10, severity: "high", note: "divide by zero is not handled" },
      { path: "src/greet.py", fromLine: 4, toLine: 6, severity: "low", note: "the farewell repeats itself" },
      { path: "src/x.ts", fromLine: 3, toLine: 3, severity: "medium", note: "uses == where === is meant" },
    ]);
  });

  it("tell an empty review from a reply that ignored the format", () => {
    expect(parseFindings("All good.\n\n```findings\n```")).toEqual([]);
    expect(parseFindings("All good, nothing to report.")).toBeNull();
    // An example block quoted earlier doesn't count over the real one at the end.
    expect(parseFindings("```findings\na.ts:1 | low | x\n```\nthen\n```findings\nb.ts:2 | high | y\n```")).toEqual([
      { path: "b.ts", fromLine: 2, toLine: 2, severity: "high", note: "y" },
    ]);
  });

  it("fill the base into the prompt", () => {
    const p = fillReviewPrompt(DEFAULT_REVIEW_PROMPT, "main");
    expect(p).toContain("git diff main");
    expect(p).not.toContain("{base}");
  });
});
