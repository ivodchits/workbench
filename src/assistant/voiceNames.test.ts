import { describe, expect, it } from "vitest";

import { fixNames, skeleton, toCyrillic } from "./voiceNames";

const names = ["Workbench", "backend", "game agent", "Duck"];
const fix = (t: string) => fixNames(t, names).text;

describe("the name fixer", () => {
  it("fixes X0's mixed-language transcripts", () => {
    expect(fix("Скажи колодкод во фронт энд сессии, сделать рефакторинг, хука юз сэшн и закомитить.")).toBe(
      "Скажи Claude Code во frontend сессии, сделать рефакторинг, хука юз сэшн и закомитить.",
    );
    expect(fix("Что там с билдом на мейн? Последний комит прошел Сиай.")).toBe(
      "Что там с билдом на main? Последний commit прошел CI.",
    );
    expect(fix("Открой пул реквест для воркбенча и попроси ревью.")).toBe("Открой pull request для Workbench и попроси ревью.");
    expect(fix("Запусти тесты в бэкэнд-сессии")).toBe("Запусти тесты в backend-сессии");
  });

  it("leaves Russian words and English text alone", () => {
    const ru = "Напомни мне через двадцать минут проверить сборку.";
    expect(fixNames(ru, names)).toEqual({ text: ru, changed: false });
    expect(fix("Ask the backend session to commit")).toBe("Ask the backend session to commit");
    expect(fix("Сколько сессий сейчас ждут моего подтверждения?")).toBe("Сколько сессий сейчас ждут моего подтверждения?");
    // Every Russian transcript from the V1 benchmark goes through untouched.
    for (const t of [
      "Что сейчас делает вторая сессия?",
      "Скажи агенту, чтобы запустил тесты и сообщил, когда они пройдут.",
      "Одобри это и коротко перескажи, что было за последний час.",
      "Остановить третью сессию Я хочу сначала посмотреть изменения.",
      "Сколько сессии сейчас ждут моего подтверждения?",
      "Прочитай мне последний ответ, только без кода.",
      "Напомни мне через 20 минут проверить сборку.",
      "Перенеси созвон на четырнадцать тридцать и предупреди всех в общем чате.",
    ])
      expect(fixNames(t, names)).toEqual({ text: t, changed: false });
  });

  it("compares by sound", () => {
    expect(toCyrillic("workbench")).toBe("воркбенч");
    expect(skeleton("бэкэнд")).toBe(skeleton(toCyrillic("backend")));
    expect(skeleton("колод код")).toBe("калад кад".replace(" ", ""));
  });
});
