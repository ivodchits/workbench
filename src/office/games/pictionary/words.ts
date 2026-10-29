// Whiteboard Pictionary's words (office plan O5.4): the ones you're given to draw, each
// with the other names that count, and how a guess is checked against a word: kindly,
// so "a red apple" is an apple, "apples" too, and a typed "bycicle" a bicycle.

export interface Word {
  word: string;
  /** Other answers that count. */
  also: readonly string[];
}

const w = (word: string, ...also: string[]): Word => ({ word, also });

/** Things anyone can draw in a minute and anyone can name. */
export const WORDS: readonly Word[] = [
  w("apple"), w("banana"), w("pizza"), w("ice cream", "ice cream cone", "cone"), w("cake", "birthday cake"),
  w("carrot"), w("cherry", "cherries"), w("egg", "fried egg"), w("mushroom"), w("pear"),
  w("cat", "kitten"), w("dog", "puppy"), w("fish"), w("snake"), w("snail"), w("spider"), w("bird"),
  w("butterfly"), w("elephant"), w("giraffe"), w("turtle", "tortoise"), w("rabbit", "bunny"), w("octopus"),
  w("owl"), w("penguin"), w("pig"), w("whale"), w("bee"), w("crab"), w("mouse"), w("frog"),
  w("house", "home"), w("castle"), w("bridge"), w("lighthouse"), w("tent"), w("church"), w("tower"),
  w("car"), w("bicycle", "bike"), w("boat", "ship", "sailboat"), w("airplane", "plane", "aeroplane"),
  w("rocket", "spaceship"), w("train"), w("bus"), w("truck", "lorry"), w("helicopter"), w("tractor"),
  w("sun"), w("moon"), w("star"), w("cloud"), w("rainbow"), w("tree"), w("flower"), w("mountain", "mountains"),
  w("volcano"), w("cactus"), w("leaf"), w("island"), w("lightning", "lightning bolt"), w("snowman"),
  w("umbrella"), w("key"), w("lamp"), w("clock"), w("chair"), w("table"), w("bed"), w("cup", "mug"),
  w("glasses", "spectacles"), w("hat"), w("shoe", "boot"), w("sock"), w("shirt", "t shirt", "t-shirt"),
  w("crown"), w("ring"), w("book"), w("pencil"), w("scissors"), w("envelope", "letter"), w("candle"),
  w("light bulb", "bulb", "lightbulb"), w("phone", "telephone", "mobile phone"), w("computer", "laptop"),
  w("television", "tv"), w("camera"), w("guitar"), w("drum"), w("trumpet"), w("bell"), w("balloon"),
  w("kite"), w("ball", "football", "soccer ball"), w("dice", "die"), w("robot"), w("ghost"), w("anchor"),
  w("hammer"), w("ladder"), w("bucket"), w("magnet"), w("sword"), w("heart"), w("eye"), w("hand"),
  w("tooth"), w("skull"), w("bone"), w("flag"), w("present", "gift"), w("teapot"), w("fork"), w("spoon"),
  w("bottle"), w("door"), w("window"), w("fence"), w("windmill"), w("snowflake"), w("duck", "rubber duck"),
];

/** What a guess may start with that isn't the guess: "is it a …". */
const FILLER = /^(a|an|the|some|its|it is|is it|is that|maybe|i think)\s+/;

/** A word as compared: lower case, letters and spaces, no article, each word without
 *  a plural's s. */
export function normal(text: string): string {
  let s = text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z ]+/g, " ").trim();
  while (FILLER.test(s)) s = s.replace(FILLER, "");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length > 3 && /[^s]s$/.test(part) ? part.slice(0, -1) : part))
    .join(" ");
}


/** The fewest single-letter changes from `a` to `b`. */
export function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Whether `guess` names `word` (or one of `also`): the same, the same with more said
 *  ("a red apple"), or a slip of a letter in a longer word. */
export function matches(guess: string, word: string, also: readonly string[] = []): boolean {
  const g = normal(guess);
  if (!g) return false;
  return [word, ...also].some((answer) => {
    const a = normal(answer);
    if (!a) return false;
    if (g === a || ` ${g} `.includes(` ${a} `)) return true;
    return a.length >= 5 && distance(g, a) <= 1;
  });
}

/** A word to draw, not one of `recent` while there are others. */
export function pickWord(recent: readonly string[], random = Math.random): Word {
  const fresh = WORDS.filter((x) => !recent.includes(x.word));
  const pool = fresh.length ? fresh : WORDS;
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}
