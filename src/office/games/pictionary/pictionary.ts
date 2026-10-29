// Whiteboard Pictionary with Duck (office plan O5.4), opened from the meeting room's
// whiteboard. Two ways to play a round, picked on the menu:
// - You draw, Duck guesses. You're given a word and draw it with the mouse, a pen or a
//   finger, in four marker colours, with undo and clear. Whenever you pause after a
//   change, Duck looks at the board (a picture of it, through Workbench) and guesses,
//   a new guess each time, until it's right, it runs out of guesses or time's up.
// - Duck draws, you guess. Duck picks a word and its strokes come back at once; they're
//   drawn one by one, at a pace that takes no more than 40 seconds, as if Duck were at
//   the board. You type guesses (Enter says one); a slip of a letter still counts.
//   Halfway through the time a letter of the word shows, and again at three quarters.
// A round is 90 seconds. The score is the rounds won, of those played; the words of the
// latest rounds aren't used again soon. While it's open, the office's whiteboard shows
// the board. Answers that come back for a round already left are dropped.

import { type Marker, MARKERS, type PictionaryAnswer, type PictionaryRequest } from "../../../remote/pictionary";
import { textWidth } from "../../art/font";
import type { Pad } from "../pad";
import { BOARD_H, BOARD_W, fromDuck, lengthOf, type Stroke } from "./board";
import { matches, pickWord } from "./words";

export const PIC_W = 256;
export const PIC_H = 176;
/** Where the board's writing area sits in the picture. */
export const BOARD_X = 4;
export const BOARD_Y = 13;

/** A round, in steps (60 a second). */
export const ROUND_STEPS = 90 * 60;
/** After a stroke, how long you pause before Duck looks; and the least time between
 *  its looks. */
export const LOOK_PAUSE = 45;
export const LOOK_GAP = 4 * 60;
/** Duck's guesses a round, at most; failed looks before it stops trying. */
export const GUESSES_MAX = 12;
export const ERRORS_MAX = 3;
/** Duck's drawing: the marker's least speed (board pixels a step), the pause between
 *  strokes, and the longest it takes. */
export const PEN_MIN = 1.5;
export const STROKE_PAUSE = 12;
export const DRAWING_MAX = 40 * 60;
/** When a letter of Duck's word shows, as shares of the round. */
export const HINTS_AT = [0.5, 0.75] as const;
/** Your guess, in characters. */
export const TYPED_MAX = 20;
/** Words not used again so soon. */
const RECENT_MAX = 24;
/** How long Duck's beak moves after it says something. */
export const SAYS_STEPS = 90;

export type Phase = "menu" | "you" | "picking" | "duck" | "over";
export type Mode = "you" | "duck";

/** Duck's marker: its strokes still to come, the one on, the next point and where the
 *  tip is. */
export interface Pen {
  strokes: Stroke[];
  i: number;
  j: number;
  tip: [number, number];
  pause: number;
  speed: number;
}

export interface PictState {
  phase: Phase;
  /** The menu's choice. */
  choice: Mode;
  /** The round's way of playing. */
  mode: Mode;
  /** Bumped for each round and on leaving one: a late answer for an old one is dropped. */
  round: number;
  /** Steps into the round; and steps since the game opened, for Duck's animation. */
  t: number;
  clock: number;
  word: string;
  also: readonly string[];
  strokes: Stroke[];
  /** Your stroke under the pointer, by its index. */
  drawing: number | null;
  marker: Marker;
  /** The board's changes, the step of the last, and how many there were at Duck's
   *  last look. */
  ink: number;
  inkAt: number;
  looked: number;
  /** A call out to Duck, and when the last one came back. */
  asking: boolean;
  askedAt: number;
  errors: number;
  /** This round's wrong guesses, Duck's or yours, oldest first. */
  guesses: string[];
  /** What Duck says, and when it said it (`clock`). */
  says: string;
  saidAt: number;
  pen: Pen | null;
  typed: string;
  /** Letters of Duck's word shown, by index. */
  hints: number[];
  won: boolean;
  wins: number;
  played: number;
  recent: string[];
  held: { a: boolean; start: boolean; dir: number };
}

export interface PictDeps {
  ask(req: PictionaryRequest): Promise<PictionaryAnswer | null>;
  /** The board as Duck is shown it, a PNG in base64. */
  picture(strokes: readonly Stroke[]): string;
  random(): number;
}

export const pictState = (): PictState => ({
  phase: "menu",
  choice: "you",
  mode: "you",
  round: 0,
  t: 0,
  clock: 0,
  word: "",
  also: [],
  strokes: [],
  drawing: null,
  marker: "black",
  ink: 0,
  inkAt: 0,
  looked: 0,
  asking: false,
  askedAt: 0,
  errors: 0,
  guesses: [],
  says: "FANCY A GAME?",
  saidAt: 0,
  pen: null,
  typed: "",
  hints: [],
  won: false,
  wins: 0,
  played: 0,
  recent: [],
  // Held at open, so the press that opened it doesn't start a round.
  held: { a: true, start: true, dir: 0 },
});

const NOPES = ["NOPE!", "NOT QUITE.", "COLD!", "HA, NO.", "GOOD TRY. NO.", "KEEP GOING!", "WARMER... NO.", "NOT IT!"];
const pick = <T>(xs: readonly T[], random: () => number): T => xs[Math.floor(random() * xs.length)] ?? xs[0];

function say(s: PictState, text: string): void {
  s.says = text.toUpperCase();
  s.saidAt = s.clock;
}

function remember(s: PictState, word: string): void {
  s.recent = [...s.recent.filter((w) => w !== word), word].slice(-RECENT_MAX);
}

function changed(s: PictState): void {
  s.ink++;
  s.inkAt = s.t;
}

const fresh = (s: PictState, phase: Phase): void => {
  Object.assign(s, {
    phase,
    round: s.round + 1,
    t: 0,
    word: "",
    also: [],
    strokes: [],
    drawing: null,
    ink: 0,
    inkAt: 0,
    looked: 0,
    asking: false,
    askedAt: -LOOK_GAP,
    errors: 0,
    guesses: [],
    pen: null,
    typed: "",
    hints: [],
    won: false,
  });
};

/** A round, played `mode`'s way. */
export function startRound(s: PictState, mode: Mode, deps: PictDeps): void {
  s.mode = mode;
  if (mode === "you") {
    fresh(s, "you");
    const w = pickWord(s.recent, deps.random);
    Object.assign(s, { word: w.word, also: w.also });
    remember(s, w.word);
    say(s, "DRAW IT! I'M WATCHING.");
    return;
  }
  fresh(s, "picking");
  say(s, "LET ME THINK OF ONE...");
  s.asking = true;
  const round = s.round;
  void deps
    .ask({ kind: "draw", avoid: [...s.recent] })
    .catch(() => null)
    .then((a) => {
      if (s.round !== round) return;
      s.asking = false;
      if (a?.status !== "ok" || a.result.kind !== "draw") {
        Object.assign(s, { phase: "over", won: false, t: 0 });
        return say(s, a?.status === "busy" ? "HOLD ON, I'M BUSY. AGAIN?" : `MY MARKER'S DRY: ${a?.status === "error" ? a.message : "NO ANSWER"}`);
      }
      const strokes = fromDuck(a.result.strokes);
      const length = strokes.reduce((n, st) => n + lengthOf(st.points), 0);
      const room = Math.max(60, DRAWING_MAX - strokes.length * STROKE_PAUSE);
      Object.assign(s, {
        phase: "duck",
        t: 0,
        word: a.result.word,
        also: a.result.also,
        pen: { strokes, i: 0, j: 0, tip: strokes[0].points[0], pause: 0, speed: Math.max(PEN_MIN, length / room) },
      });
      remember(s, a.result.word);
      say(s, "WHAT AM I DRAWING?");
    });
}

/** The round over: won or not. A drawing Duck hadn't finished is shown whole. */
export function endRound(s: PictState, won: boolean): void {
  if (s.phase !== "you" && s.phase !== "duck") return;
  if (s.pen) {
    s.strokes = s.pen.strokes.map((st) => ({ color: st.color, points: [...st.points] }));
    s.pen = null;
    changed(s);
  }
  Object.assign(s, { phase: "over", won, drawing: null, asking: false, t: 0 });
  s.round++;
  s.played++;
  if (won) s.wins++;
}

/** Duck looks at the board and guesses. */
function look(s: PictState, deps: PictDeps): void {
  s.asking = true;
  s.looked = s.ink;
  const round = s.round;
  void deps
    .ask({ kind: "guess", png: deps.picture(s.strokes), guessed: [...s.guesses] })
    .catch(() => null)
    .then((a) => {
      if (s.round !== round) return;
      s.asking = false;
      s.askedAt = s.t;
      if (a?.status === "busy") return;
      if (a?.status !== "ok" || a.result.kind !== "guess") {
        s.errors++;
        // Look again at the next pause.
        s.looked = -1;
        return say(s, s.errors >= ERRORS_MAX ? `I CAN'T SEE THE BOARD: ${a?.status === "error" ? a.message : "NO ANSWER"}` : "HANG ON, MY GLASSES...");
      }
      s.errors = 0;
      say(s, a.result.says);
      if (matches(a.result.guess, s.word, s.also)) return endRound(s, true);
      s.guesses.push(a.result.guess.toUpperCase());
      if (s.guesses.length >= GUESSES_MAX) say(s, "I GIVE UP. WHAT IS IT?");
    });
}

/** Moves Duck's marker on by its speed. */
function stepPen(s: PictState): void {
  const pen = s.pen;
  if (!pen || pen.i >= pen.strokes.length) return;
  if (pen.pause > 0) {
    pen.pause--;
    return;
  }
  const src = pen.strokes[pen.i];
  if (pen.j === 0) {
    pen.tip = src.points[0];
    pen.j = 1;
  }
  let budget = pen.speed;
  while (budget > 0 && pen.j < src.points.length) {
    const to = src.points[pen.j];
    const d = Math.hypot(to[0] - pen.tip[0], to[1] - pen.tip[1]);
    if (d <= budget) {
      pen.tip = to;
      pen.j++;
      budget -= d;
    } else {
      pen.tip = [pen.tip[0] + ((to[0] - pen.tip[0]) * budget) / d, pen.tip[1] + ((to[1] - pen.tip[1]) * budget) / d];
      budget = 0;
    }
  }
  const done = pen.j >= src.points.length;
  s.strokes[pen.i] = { color: src.color, points: [...src.points.slice(0, pen.j), ...(done ? [] : [pen.tip])] };
  changed(s);
  if (done) {
    pen.i++;
    pen.j = 0;
    pen.pause = STROKE_PAUSE;
  }
}

/** Whether Duck has finished drawing. */
export const penDone = (s: PictState): boolean => !s.pen || s.pen.i >= s.pen.strokes.length;

/** Shows another letter of Duck's word when it's time. */
function stepHints(s: PictState, random: () => number): void {
  const due = HINTS_AT.filter((at) => s.t >= at * ROUND_STEPS).length;
  if (s.hints.length >= due) return;
  const hidden = [...s.word].flatMap((ch, i) => (ch !== " " && !s.hints.includes(i) ? [i] : []));
  // Never the whole word: one letter stays hidden at least.
  if (hidden.length > 1) s.hints.push(pick(hidden, random));
  else s.hints.push(-1);
}

/** The word as you see it while guessing: blanks, and the letters shown; words apart
 *  by a wide gap. */
export function blanks(s: PictState): string {
  return s.word
    .split(" ")
    .map((word, w, words) => {
      const at = words.slice(0, w).reduce((n, x) => n + x.length + 1, 0);
      return [...word].map((ch, i) => (s.hints.includes(at + i) ? ch.toUpperCase() : "_")).join(" ");
    })
    .join("    ");
}

/** One step with the pad as it is. */
export function stepPict(s: PictState, pad: Pad, deps: PictDeps): void {
  s.clock++;
  const dir = pad.y < -0.5 ? -1 : pad.y > 0.5 ? 1 : 0;
  const press = (pad.a && !s.held.a) || (pad.start && !s.held.start);
  const moved = dir !== 0 && dir !== s.held.dir;
  s.held = { a: pad.a, start: pad.start, dir };
  switch (s.phase) {
    case "menu":
      if (moved) s.choice = s.choice === "you" ? "duck" : "you";
      if (press) startRound(s, s.choice, deps);
      return;
    case "over":
      s.t++;
      if (press) startRound(s, s.mode, deps);
      return;
    case "picking":
      return;
    case "you":
      s.t++;
      if (s.t >= ROUND_STEPS) return endRound(s, false);
      if (
        !s.asking &&
        s.drawing === null &&
        s.strokes.length > 0 &&
        s.ink !== s.looked &&
        s.t - s.inkAt >= LOOK_PAUSE &&
        s.t - s.askedAt >= LOOK_GAP &&
        s.guesses.length < GUESSES_MAX &&
        s.errors < ERRORS_MAX
      )
        look(s, deps);
      return;
    case "duck":
      s.t++;
      if (s.t >= ROUND_STEPS) {
        endRound(s, false);
        return say(s, "TIME! TOO TRICKY?");
      }
      stepPen(s);
      stepHints(s, deps.random);
      return;
  }
}

/** Says your guess at Duck's word. */
function guess(s: PictState, deps: PictDeps): void {
  const g = s.typed.trim();
  s.typed = "";
  if (!g || s.phase !== "duck") return;
  if (matches(g, s.word, s.also)) {
    endRound(s, true);
    return say(s, "YES! YOU GOT IT!");
  }
  s.guesses.push(g.toUpperCase());
  say(s, pick(NOPES, deps.random));
}

/** A key typed: your guess while Duck draws; while you draw, a marker (1-4) or undo
 *  (Ctrl+Z). True when taken. */
export function keyPict(s: PictState, key: string, ctrl: boolean, deps: PictDeps): boolean {
  if (s.phase === "you") {
    const n = Number(key);
    if (ctrl && key.toLowerCase() === "z") act(s, "undo", deps);
    else if (!ctrl && Number.isInteger(n) && n >= 1 && n <= MARKERS.length) s.marker = MARKERS[n - 1];
    else return false;
    return true;
  }
  if (s.phase !== "duck" || ctrl) return false;
  if (key === "Enter") guess(s, deps);
  else if (key === "Backspace") s.typed = s.typed.slice(0, -1);
  else if (/^[a-zA-Z' -]$/.test(key)) {
    if (s.typed.length < TYPED_MAX && !(key === " " && !s.typed)) s.typed += key.toUpperCase();
  } else return false;
  return true;
}

/** Esc: from a round to the menu (true); from the menu, nothing, so the game closes. */
export function backPict(s: PictState): boolean {
  if (s.phase === "menu") return false;
  Object.assign(s, { phase: "menu", drawing: null, asking: false, pen: null, held: { a: true, start: true, dir: 0 } });
  s.round++;
  say(s, "ANOTHER?");
  return true;
}

export type ButtonId = Marker | "undo" | "clear" | "pass" | "again" | "menu" | "you" | "duck";

export interface Button {
  id: ButtonId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its words, none for a marker. */
  label: string;
}

/** The bottom row's top, and its buttons' height. */
export const BAR_Y = 153;
const BUTTON_H = 13;
/** The menu's two choices, on the board. */
export const MENU_CHOICES: readonly { id: Mode; label: string }[] = [
  { id: "you", label: "YOU DRAW, DUCK GUESSES" },
  { id: "duck", label: "DUCK DRAWS, YOU GUESS" },
];

/** What can be clicked now, and where. */
export function buttons(s: PictState): Button[] {
  const row = (ids: [ButtonId, string][], x: number): Button[] =>
    ids.map(([id, label]) => {
      const b = { id, x, y: BAR_Y, w: textWidth(label) + 8, h: BUTTON_H, label };
      x += b.w + 4;
      return b;
    });
  switch (s.phase) {
    case "menu":
      return MENU_CHOICES.map((c, i) => ({
        id: c.id,
        x: BOARD_X + 20,
        y: BOARD_Y + 52 + i * 20,
        w: BOARD_W - 40,
        h: 15,
        label: c.label,
      }));
    case "you":
      return [
        ...MARKERS.map((m, i) => ({ id: m, x: BOARD_X + i * 16, y: BAR_Y, w: BUTTON_H, h: BUTTON_H, label: "" })),
        ...row(
          [
            ["undo", "UNDO"],
            ["clear", "CLEAR"],
            ["pass", "GIVE UP"],
          ],
          BOARD_X + MARKERS.length * 16 + 6,
        ),
      ];
    case "duck":
      return row([["pass", "GIVE UP"]], BOARD_X + BOARD_W - textWidth("GIVE UP") - 8);
    case "over":
      return row(
        [
          ["again", "AGAIN"],
          ["menu", "MENU"],
        ],
        BOARD_X,
      );
    case "picking":
      return [];
  }
}

const inside = (b: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

function act(s: PictState, id: ButtonId, deps: PictDeps): void {
  switch (id) {
    case "you":
    case "duck":
      s.choice = id;
      return startRound(s, id, deps);
    case "undo":
      if (s.phase === "you" && s.strokes.pop()) changed(s);
      return;
    case "clear":
      if (s.phase === "you" && s.strokes.length) {
        s.strokes = [];
        changed(s);
      }
      return;
    case "pass":
      endRound(s, false);
      return say(s, s.mode === "you" ? "WHAT WAS IT?" : "TOO TRICKY? HA!");
    case "again":
      return startRound(s, s.mode, deps);
    case "menu":
      backPict(s);
      return;
    default:
      s.marker = id;
  }
}

/** The pointer on the picture: a button pressed, or drawing on the board. */
export function pointerPict(s: PictState, kind: "down" | "move" | "up", x: number, y: number, deps: PictDeps): void {
  const bx = Math.max(0, Math.min(BOARD_W - 1, x - BOARD_X));
  const by = Math.max(0, Math.min(BOARD_H - 1, y - BOARD_Y));
  if (kind === "down") {
    const b = buttons(s).find((b) => inside(b, x, y));
    if (b) return act(s, b.id, deps);
    if (s.phase !== "you" || !inside({ x: BOARD_X, y: BOARD_Y, w: BOARD_W, h: BOARD_H }, x, y)) return;
    s.strokes.push({ color: s.marker, points: [[bx, by]] });
    s.drawing = s.strokes.length - 1;
    return changed(s);
  }
  if (s.drawing === null) return;
  const stroke = s.strokes[s.drawing];
  if (!stroke) {
    s.drawing = null;
    return;
  }
  const last = stroke.points[stroke.points.length - 1];
  if (Math.hypot(bx - last[0], by - last[1]) >= 1) {
    stroke.points.push([bx, by]);
    changed(s);
  }
  if (kind === "up") s.drawing = null;
}
