// Spoken replies (step V2): the words. A reply streams in as markdown; what the
// voice says is sentences of plain, speakable text, each with its language.
//
// - `Sentences` takes the stream a delta at a time and hands back whole sentences
//   as they complete, so the first one can be spoken while the rest still streams.
//   A code block becomes "See the code on screen."; a table, "See the table on
//   screen."; links keep their text, bare URLs become "a link".
// - `toSpoken` makes one sentence sayable: inline code and paths read as words
//   ("src/assistant/engine.ts" → "engine dot ts"), and the few things Kokoro reads
//   oddly are spelled out ("3.5" → "3 point 5", "#128" → "number 128").
// - `langOf`: any Cyrillic → Russian (Silero), otherwise English (Kokoro).
// - Silero drops every digit and Latin letter, so a Russian sentence that still has
//   one needs a rewrite: `needsRewrite` says so, the Haiku primitive `speakable_ru`
//   does it, and `russianFallback` is the rule-based pass when Haiku can't
//   (offline, budget): numbers to words, Latin words respelled in Cyrillic.

import { toCyrillic } from "./voiceNames";

export type Lang = "en" | "ru";

const CYRILLIC = /[Ѐ-ӿ]/;

export function langOf(sentence: string): Lang {
  return CYRILLIC.test(sentence) ? "ru" : "en";
}

/** A Russian sentence Silero would garble: a digit or a Latin letter is left. */
export function needsRewrite(sentence: string): boolean {
  return /[0-9A-Za-z]/.test(sentence);
}

const CODE_NOTE = "See the code on screen.";
const TABLE_NOTE = "See the table on screen.";

/** Markdown furniture off one line of prose (not code). */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
    .replace(/^\s*>\s?/, "") // quotes
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // list markers
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "a link")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^\s*[-*_]{3,}\s*$/, "");
}

const END = /([.!?…]+["»”')\]]*)(\s+)(?=\S)/g;

/** Sentences of a block of prose (no code), cut at terminators followed by space
 *  and something that isn't a lowercase continuation ("e.g. this"). */
function splitProse(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let from = 0;
  END.lastIndex = 0;
  for (let m = END.exec(text); m; m = END.exec(text)) {
    const cut = m.index + m[1].length;
    const next = text[cut + m[2].length];
    if (next && /[a-zа-яё]/.test(next)) continue;
    const s = text.slice(from, cut).trim();
    if (s) done.push(s);
    from = cut + m[2].length;
  }
  return { done, rest: text.slice(from) };
}

/**
 * A reply streaming in, cut into speakable sentences. `push` each delta and say
 * what it returns; `end` returns the remainder when the reply is over.
 */
export class Sentences {
  private buf = "";
  /** Prose waiting for its sentence to end. */
  private prose = "";
  private inFence = false;
  private inTable = false;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    // Whole lines only; the last, partial line waits unless it's prose.
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      this.line(this.buf.slice(0, nl), out, true);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
    // A partial line of prose can already hold finished sentences.
    if (!this.inFence && this.buf && !/^\s*(```|~~~|\|)/.test(this.buf)) {
      const { done, rest } = splitProse(`${this.prose}${this.prose ? " " : ""}${plainLine(this.buf)}`);
      if (done.length) {
        out.push(...done);
        this.prose = "";
        this.buf = rest; // already plain; plainLine again is harmless
      }
    }
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.buf) this.line(this.buf, out, false);
    this.buf = "";
    // An unclosed fence was already announced when it opened.
    this.inFence = false;
    const last = this.prose.trim();
    if (last) out.push(last);
    this.prose = "";
    return out;
  }

  private line(raw: string, out: string[], complete: boolean): void {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (!this.inFence) {
        this.flushProse(out);
        out.push(CODE_NOTE);
      }
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence) return;
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (!this.inTable) {
        this.flushProse(out);
        out.push(TABLE_NOTE);
      }
      this.inTable = true;
      return;
    }
    this.inTable = false;
    const text = plainLine(raw);
    if (!text.trim()) {
      // A blank line ends a paragraph, and with it a sentence.
      this.flushProse(out);
      return;
    }
    // A list item or heading on its own line is a sentence of its own.
    const standalone = /^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/.test(raw);
    if (standalone) this.flushProse(out);
    const { done, rest } = splitProse(`${this.prose}${this.prose ? " " : ""}${text}`);
    out.push(...done);
    this.prose = rest;
    if (standalone && complete) this.flushProse(out);
  }

  private flushProse(out: string[]): void {
    const s = this.prose.trim();
    if (s) out.push(s);
    this.prose = "";
  }
}

/** A path or file name as it's said: its last part, dots read out. */
function sayPath(p: string): string {
  const last = p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? p;
  return last.replace(/\.(?=\w)/g, " dot ");
}

/** An identifier as words: `sendOrQueue` → "send or queue", `x_wb` → "x wb". */
function sayIdent(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .replace(/\(\)$/, "")
    .toLowerCase();
}

function sayCode(code: string): string {
  const c = code.trim();
  if (/[/\\]/.test(c) || /^[\w-]+\.[a-z]{1,5}$/i.test(c)) return sayPath(c);
  if (/^[\w.]+(\(\))?$/.test(c)) return sayIdent(c).replace(/\./g, " dot ");
  return c;
}

/** One sentence made sayable for English (and the common part for Russian). */
export function toSpoken(sentence: string): string {
  let s = sentence
    .replace(/`([^`]+)`/g, (_, c: string) => sayCode(c))
    // Bare paths: two segments or more with a slash, or a file with an extension.
    .replace(/(?<![\w@])(?:[\w.-]+\/)+[\w.-]+(?![\w/])/g, (p) => sayPath(p))
    .replace(/\s*(?:->|→)\s*/g, " to ")
    .replace(/\s&\s/g, " and ");
  if (langOf(s) === "en") {
    s = s
      .replace(/#(\d+)/g, "number $1")
      // Versions and decimals: "2.1.304", "3.5" (not "1,250.50" money, which Kokoro reads).
      .replace(/(?<![\d$,.])(\d+(?:\.\d+)+)(?![\d.]*\d)/g, (v) => v.split(".").join(" point "))
      .replace(/(\d)\s?%/g, "$1 percent")
      .replace(/~(?=\d)/g, "about ");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

// ── the rule-based Russian pass ──

const ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
  "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

function plural(n: number, one: string, few: string, many: string): string {
  const t = n % 100;
  if (t >= 11 && t <= 14) return many;
  const u = n % 10;
  return u === 1 ? one : u >= 2 && u <= 4 ? few : many;
}

function under1000(n: number, feminine: boolean): string[] {
  const out: string[] = [];
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)]);
  const t = n % 100;
  if (t >= 10 && t < 20) out.push(TEENS[t - 10]);
  else {
    if (t >= 20) out.push(TENS[Math.floor(t / 10)]);
    if (t % 10) out.push((feminine ? ONES_F : ONES)[t % 10]);
  }
  return out;
}

/** A whole number in Russian words, nominative (the case most often right). */
export function russianNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return String(n);
  if (n === 0) return "ноль";
  const groups: [number, string, string, string, boolean][] = [
    [1e9, "миллиард", "миллиарда", "миллиардов", false],
    [1e6, "миллион", "миллиона", "миллионов", false],
    [1e3, "тысяча", "тысячи", "тысяч", true],
  ];
  const out: string[] = [];
  let rest = Math.floor(n);
  for (const [size, one, few, many, fem] of groups) {
    const k = Math.floor(rest / size);
    if (k) {
      out.push(...under1000(k, fem), plural(k, one, few, many));
      rest %= size;
    }
  }
  out.push(...under1000(rest, false));
  return out.join(" ");
}

/** How Latin terms are said, where the letter-by-letter guess is wrong. */
const SAID: Record<string, string> = {
  "pull request": "пулл реквест",
  "claude code": "клод код",
  backend: "бэкенд",
  frontend: "фронтенд",
  commit: "коммит",
  main: "мейн",
  npm: "эн пи эм",
  ci: "си ай",
  api: "эй пи ай",
  pr: "пи ар",
  git: "гит",
  github: "гитхаб",
  worktree: "ворктри",
  workbench: "воркбенч",
  duck: "дак",
  test: "тест",
  tests: "тесты",
  session: "сессия",
  opus: "опус",
  sonnet: "соннет",
  haiku: "хайку",
};

/** Letters said one by one, for abbreviations not in the list. */
const LETTER_NAMES: Record<string, string> = {
  a: "эй", b: "би", c: "си", d: "ди", e: "и", f: "эф", g: "джи", h: "эйч", i: "ай", j: "джей",
  k: "кей", l: "эл", m: "эм", n: "эн", o: "оу", p: "пи", q: "кью", r: "ар", s: "эс", t: "ти",
  u: "ю", v: "ви", w: "дабл ю", x: "экс", y: "уай", z: "зед",
};

/**
 * The offline pass for a Russian sentence: numbers to words (nominative), times
 * like 14:30 as two numbers, known terms by how they're said, other Latin words
 * transliterated, and short capitalised abbreviations letter by letter.
 */
export function russianFallback(sentence: string): string {
  let s = sentence;
  for (const [latin, said] of Object.entries(SAID).sort((a, b) => b[0].length - a[0].length))
    s = s.replace(new RegExp(`(?<![A-Za-z])${latin}(?![A-Za-z])`, "gi"), said);
  return s
    .replace(/(\d{1,2}):(\d{2})/g, (_, h: string, m: string) =>
      `${russianNumber(+h)} ${m === "00" ? "ноль ноль" : +m < 10 ? `ноль ${russianNumber(+m)}` : russianNumber(+m)}`,
    )
    .replace(/(\d+)[.,](\d+)/g, (_, a: string, b: string) => `${russianNumber(+a)} и ${russianNumber(+b)}`)
    // Thousands grouped by a space ("1 250"; \s covers the no-break space too).
    .replace(/\d+(?:\s\d{3})*/g, (d) => russianNumber(+d.replace(/\s/g, "")))
    .replace(/%/g, " процентов")
    .replace(/\b[A-Z]{2,4}\b/g, (abbr) => [...abbr.toLowerCase()].map((c) => LETTER_NAMES[c] ?? c).join(" "))
    .replace(/[A-Za-z]+/g, (w) => toCyrillic(w))
    .replace(/\s{2,}/g, " ")
    .trim();
}
