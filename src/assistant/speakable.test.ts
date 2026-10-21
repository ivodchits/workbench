import { describe, expect, it } from "vitest";
import { langOf, needsRewrite, russianFallback, russianNumber, Sentences, toSpoken } from "./speakable";

/** Feed `text` in chunks of `n` characters, as a stream would. */
function stream(text: string, n = 3): { early: string[][]; all: string[] } {
  const s = new Sentences();
  const early: string[][] = [];
  for (let i = 0; i < text.length; i += n) early.push(s.push(text.slice(i, i + n)));
  const all = [...early.flat(), ...s.end()];
  return { early, all };
}

describe("Sentences", () => {
  it("hands back a sentence as soon as the next one starts", () => {
    const s = new Sentences();
    expect(s.push("Two sessions need you. The ")).toEqual(["Two sessions need you."]);
    expect(s.push("backend one is done.")).toEqual([]);
    expect(s.end()).toEqual(["The backend one is done."]);
  });

  it("strips markdown and stands in for code and tables", () => {
    const { all } = stream(
      "## Status\n\n**Two** sessions need you:\n\n- *backend*: waiting for approval\n- [docs](http://x.y/z) is done\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSee https://example.com for more.",
    );
    expect(all).toEqual([
      "Status",
      "Two sessions need you:",
      "backend: waiting for approval",
      "docs is done",
      "See the code on screen.",
      "See the table on screen.",
      "See a link for more.",
    ]);
  });

  it("doesn't cut at a decimal, a file name or a lowercase continuation", () => {
    const { all } = stream("Version 3.5 fixed engine.ts, e.g. the queue. Done!");
    expect(all).toEqual(["Version 3.5 fixed engine.ts, e.g. the queue.", "Done!"]);
  });

  it("says an unclosed code block once", () => {
    expect(stream("Here:\n```\nnpm test\n").all).toEqual(["Here:", "See the code on screen."]);
  });

  it("splits Russian too", () => {
    expect(stream("Бэкенд готов. Тесты прошли!").all).toEqual(["Бэкенд готов.", "Тесты прошли!"]);
  });
});

describe("toSpoken", () => {
  it("reads paths, code and Kokoro's odd spots", () => {
    expect(toSpoken("Changed `src/assistant/engine.ts` and src/util/speech.ts.")).toBe(
      "Changed engine dot ts and speech dot ts.",
    );
    expect(toSpoken("Call `sendOrQueue()` → done.")).toBe("Call send or queue to done.");
    expect(toSpoken("PR #128 is on 2.1.304; 3.5 of 4 at ~90%.")).toBe(
      "PR number 128 is on 2 point 1 point 304; 3 point 5 of 4 at about 90 percent.",
    );
    expect(toSpoken("It costs $1,250.50.")).toBe("It costs $1,250.50.");
  });
});

describe("Russian", () => {
  it("routes by script and spots what Silero would drop", () => {
    expect(langOf("Бэкенд готов.")).toBe("ru");
    expect(langOf("The backend is done.")).toBe("en");
    expect(needsRewrite("Встреча в 14:30.")).toBe(true);
    expect(needsRewrite("Сессия backend ждёт.")).toBe(true);
    expect(needsRewrite("Встреча в четырнадцать тридцать.")).toBe(false);
  });

  it("writes numbers out", () => {
    expect(russianNumber(0)).toBe("ноль");
    expect(russianNumber(42)).toBe("сорок два");
    expect(russianNumber(1250)).toBe("одна тысяча двести пятьдесят");
    expect(russianNumber(2_000_015)).toBe("два миллиона пятнадцать");
    expect(russianNumber(11_000)).toBe("одиннадцать тысяч");
  });

  it("leaves nothing Silero would drop", () => {
    for (const s of [
      "Встречу перенесли на завтра, в 14:30. Я напомню за 15 минут.",
      "Сессия backend открыла PR #128 в Workbench.",
      "Потратил 1 250 рублей, это 37% бюджета, по API.",
      "Запусти npm test в main.",
    ]) {
      const out = russianFallback(s);
      expect(needsRewrite(out), out).toBe(false);
    }
    expect(russianFallback("в 14:30, за 15 минут")).toBe("в четырнадцать тридцать, за пятнадцать минут");
    expect(russianFallback("Сессия backend открыла PR")).toBe("Сессия бэкенд открыла пи ар");
  });
});
