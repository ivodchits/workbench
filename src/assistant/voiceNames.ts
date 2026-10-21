// The name fixer (step V1). Parakeet writes English names said in Russian speech in
// Cyrillic: «воркбенч», «колод код», «пул реквест». Known names are matched in the
// transcript and put back in their own spelling:
// - your project and session names, by a transliteration to Cyrillic;
// - a short list of terms, by how they are said.
//
// Matching is loose where Russian speech is loose, for names of five letters or
// more: vowels count as one class (unstressed о and а, э and е sound alike),
// doubled letters as one, an edit or two is allowed, and the last word may carry a
// case ending of up to two letters («воркбенча»). Shorter names («мейн», «сиай»)
// must match exactly, vowels and all. Only whole words, or runs of up to three, are
// replaced («фронт энд» is "frontend").

/** Terms and how they're said, beyond their transliteration. */
export const TERMS: { text: string; said: string[] }[] = [
  { text: "Claude Code", said: ["клод код", "колод код", "клауд код", "клоуд код"] },
  { text: "pull request", said: ["пул реквест", "пулреквест"] },
  { text: "commit", said: ["комит"] },
  { text: "main", said: ["мейн", "мэйн"] },
  { text: "npm", said: ["энпиэм", "энпим", "энпием"] },
  { text: "worktree", said: ["вёрктри", "ворктри"] },
  { text: "CI", said: ["сиай"] },
  { text: "backend", said: ["бэкенд"] },
  { text: "frontend", said: ["фронтенд"] },
];

const DIGRAPHS: [string, string][] = [
  ["sch", "ш"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ph", "ф"],
  ["th", "т"],
  ["ck", "к"],
  ["oo", "у"],
  ["ee", "и"],
  ["ea", "и"],
  ["qu", "кв"],
  ["ts", "ц"],
  ["ya", "я"],
  ["yu", "ю"],
  ["x", "кс"],
  ["j", "дж"],
];

const LETTERS: Record<string, string> = {
  a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", k: "к", l: "л", m: "м",
  n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", y: "и", z: "з",
};

/** A Latin name as it would be written in Cyrillic, roughly. */
export function toCyrillic(latin: string): string {
  let s = latin.toLowerCase();
  for (const [a, b] of DIGRAPHS) s = s.split(a).join(b);
  return [...s].map((c) => LETTERS[c] ?? c).join("");
}

const VOWELS = /[аеиоуюя]/g;
const DOUBLED = /(.)\1+/g;

/** Letters only, the near-same ones as one (ё е э, и й ы), no doubled letters. */
export function exact(cyrillic: string): string {
  return cyrillic
    .toLowerCase()
    .replace(/[ёэ]/g, "е")
    .replace(/[йы]/g, "и")
    .replace(/[ъь]/g, "")
    .replace(/[^а-я]/g, "")
    .replace(DOUBLED, "$1");
}

/** The loose form: also every vowel as one. */
export function skeleton(cyrillic: string): string {
  return exact(cyrillic).replace(VOWELS, "а").replace(DOUBLED, "$1");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Names shorter than this (in letters) must match exactly. */
const LOOSE_FROM = 5;
/** Edits allowed for a loose form this long. */
const allowed = (n: number) => (n <= 6 ? 0 : n <= 9 ? 1 : 2);

interface Form {
  text: string;
  exact: string;
  skel: string;
}

function forms(names: string[]): Form[] {
  const out: Form[] = [];
  const add = (text: string, said: string) => {
    const e = exact(said);
    if (e.length >= 2) out.push({ text, exact: e, skel: skeleton(said) });
  };
  for (const t of TERMS) {
    add(t.text, toCyrillic(t.text));
    for (const s of t.said) add(t.text, s);
  }
  for (const n of names) {
    // Only Latin names: a Cyrillic one is already spelled as said.
    if (/[a-z]/i.test(n) && !/[а-яё]/i.test(n)) add(n.trim(), toCyrillic(n));
  }
  return out;
}

/** Which name these words are, if any, and how many edits away. */
function match(words: string[], all: Form[]): { text: string; d: number } | null {
  const joined = words.join("");
  const w = skeleton(joined);
  const e = exact(joined);
  // A case ending comes off the last word, which keeps at least two letters.
  const maxCut = Math.min(2, Math.max(0, skeleton(words[words.length - 1]).length - 2));
  let best: { text: string; d: number } | null = null;
  for (const f of all) {
    if (f.exact.length < LOOSE_FROM) {
      if (e === f.exact) return { text: f.text, d: 0 };
      continue;
    }
    for (let cut = 0; cut <= maxCut; cut++) {
      const d = distance(w.slice(0, w.length - cut), f.skel);
      if (d <= allowed(f.skel.length) && (!best || d < best.d)) best = { text: f.text, d };
    }
  }
  return best;
}

const TOKEN = /[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu;
const CYRILLIC_WORD = /^[а-яё]+$/i;

/** What a transcript sends: its names fixed, the words as heard beside a fix. */
export function voiceMessage(text: string, names: string[]): string {
  const raw = text.trim();
  const fixed = fixNames(raw, names);
  return fixed.changed ? `${fixed.text}\n\n(voice; as heard: "${raw}")` : fixed.text;
}

/** Put known names back into a transcript. `names`: project and session names. */

export function fixNames(text: string, names: string[]): { text: string; changed: boolean } {
  if (!/[а-яё]/i.test(text)) return { text, changed: false };
  const all = forms(names);
  const tokens = text.match(TOKEN) ?? [];
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < tokens.length; ) {
    if (!CYRILLIC_WORD.test(tokens[i])) {
      out.push(tokens[i++]);
      continue;
    }
    // Runs of one to three words joined by spaces or hyphens: the closest match
    // wins, the shorter run on a tie (so a near match doesn't take the next word).
    let best: { text: string; d: number; end: number } | null = null;
    for (let n = 1; n <= 3; n++) {
      const end = i + 2 * (n - 1);
      if (end >= tokens.length) break;
      const run = tokens.slice(i, end + 1);
      const words = run.filter((_, k) => k % 2 === 0);
      const joins = run.filter((_, k) => k % 2 === 1);
      if (!words.every((x) => CYRILLIC_WORD.test(x)) || !joins.every((j) => /^[\s-]+$/.test(j))) break;
      const m = match(words, all);
      if (m && (!best || m.d < best.d)) best = { ...m, end };
    }
    if (best) {
      out.push(best.text);
      i = best.end + 1;
      changed = true;
    } else out.push(tokens[i++]);
  }
  return { text: out.join(""), changed };
}
