// The TV's games console (office plan O5.3a): it boots with its logo, then a menu of
// cartridges — our own games (`cartridges.ts`) and the Library, your game images
// through an emulator (O5.3d). A cartridge plays at its own size; Esc or Back takes it
// out to the menu, and from the menu turns the console off. Each cartridge's best score
// is kept (in the page's storage) and shown on its label.

import { textBitmap } from "../../art/font";
import { cached } from "../../canvas";
import type { Game, GameDef } from "../game";
import type { Pad } from "../pad";

export interface Cartridge {
  id: string;
  title: string;
  /** The label's colours: its band, and the ink on it. */
  label: readonly [string, string];
  help: string;
  /** Whether it keeps a best score (from its game's `score`). */
  scored?: boolean;
  /** A new game; `best` is the score it has to beat. */
  make(best: number): Game;
}

/** Where the bests are kept, by cartridge id. */
export interface BestStore {
  load(): Record<string, number>;
  save(best: Record<string, number>): void;
}

export const CONSOLE_W = 256;
export const CONSOLE_H = 224;
/** How long the logo shows, unless a button skips it. */
export const BOOT_STEPS = 100;
/** How long a note under the menu stays (the Library still empty). */
const NOTE_STEPS = 120;
/** A held direction moves on once, then again after a wait, then steadily. */
const REPEAT_FIRST = 20;
const REPEAT_NEXT = 7;
const PUSH = 0.5;

export const LIBRARY_ID = "library";
const MENU_HELP = "up/down or the d-pad: choose · Z/Space/Enter or A/Start: play · Esc or Back: turn off";
const BACK_HELP = " · Esc or Back: to the menu";

export interface ConsoleState {
  phase: "boot" | "menu" | "play";
  /** Steps since the phase began. */
  t: number;
  carts: readonly Cartridge[];
  /** The menu's choice: a cartridge's index, or `carts.length` for the Library. */
  at: number;
  playing: { cart: Cartridge; game: Game } | null;
  best: Record<string, number>;
  note: { text: string; until: number } | null;
  /** Buttons held at the last step, so a press counts once; held at boot. */
  held: { a: boolean; start: boolean; dir: number };
  /** Steps the direction has been held. */
  holding: number;
}

export function consoleState(carts: readonly Cartridge[], best: Record<string, number> = {}): ConsoleState {
  return { phase: "boot", t: 0, carts, at: 0, playing: null, best: { ...best }, note: null, held: { a: true, start: true, dir: 0 }, holding: 0 };
}

/** One step of the console; `save` keeps a new best. */
export function stepConsole(s: ConsoleState, pad: Pad, save: (best: Record<string, number>) => void = () => {}): void {
  s.t++;
  if (s.phase === "play" && s.playing) {
    s.playing.game.step(pad);
    keepBest(s, save, false);
    return;
  }
  const dir = pad.y < -PUSH ? -1 : pad.y > PUSH ? 1 : 0;
  const press = (pad.a && !s.held.a) || (pad.start && !s.held.start);
  s.holding = dir !== 0 && dir === s.held.dir ? s.holding + 1 : 0;
  const moved = dir !== 0 && (s.holding === 0 || (s.holding >= REPEAT_FIRST && (s.holding - REPEAT_FIRST) % REPEAT_NEXT === 0));
  s.held = { a: pad.a, start: pad.start, dir };
  if (s.note && s.t >= s.note.until) s.note = null;

  if (s.phase === "boot") {
    if (press || s.t >= BOOT_STEPS) Object.assign(s, { phase: "menu", t: 0 });
    return;
  }
  const count = s.carts.length + 1;
  if (moved) s.at = (s.at + dir + count) % count;
  if (!press) return;
  const cart = s.carts[s.at];
  if (!cart) {
    s.note = { text: "THE LIBRARY IS EMPTY FOR NOW", until: s.t + NOTE_STEPS };
    return;
  }
  Object.assign(s, { phase: "play", t: 0, playing: { cart, game: cart.make(s.best[cart.id] ?? 0) }, note: null });
}

/** Esc or Back: out of a cartridge to the menu (true), or not taken, to turn off. */
export function backConsole(s: ConsoleState, save: (best: Record<string, number>) => void = () => {}): boolean {
  if (s.phase !== "play" || !s.playing) return false;
  leave(s, save);
  Object.assign(s, { phase: "menu", t: 0, held: { a: true, start: true, dir: 0 } });
  return true;
}

/** Lets go of the cartridge playing, if any, keeping its best. */
export function leave(s: ConsoleState, save: (best: Record<string, number>) => void): void {
  if (!s.playing) return;
  keepBest(s, save, true);
  s.playing.game.stop?.();
  s.playing = null;
}

/** Notes the cartridge's score if it beats its best; saved now when `now`, else only on
 *  leaving (not every step). */
function keepBest(s: ConsoleState, save: (best: Record<string, number>) => void, now: boolean): void {
  const p = s.playing;
  if (!p?.cart.scored) return;
  const score = p.game.score ?? 0;
  if (score > (s.best[p.cart.id] ?? 0)) s.best[p.cart.id] = score;
  if (now) save({ ...s.best });
}

const STORE_KEY = "office.console.best";

/** The page's own storage; nothing kept where it can't be had (a private window). */
export const pageStore: BestStore = {
  load() {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
      if (!v || typeof v !== "object") return {};
      return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) as Record<string, number>;
    } catch {
      return {};
    }
  },
  save(best) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(best));
    } catch {
      // Not kept.
    }
  },
};

// Drawing.

const INK = "#ebe6f3";
const DIM = "#6b6380";
const BACKDROP = "#100e18";
const text = (s: string, color: string) => cached(`console-text/${color}/${s}`, () => textBitmap(s, color));

/** `s` drawn `k` times its size, its top-left at (x, y). */
function big(ctx: CanvasRenderingContext2D, s: string, color: string, x: number, y: number, k: number): void {
  const t = text(s, color);
  ctx.drawImage(t, Math.round(x), Math.round(y), t.width * k, t.height * k);
}

const centred = (s: string, k: number) => (CONSOLE_W - text(s, INK).width * k) / 2;

/** The console's logo, its top at `y`: its name over a little duck. */
function drawLogo(ctx: CanvasRenderingContext2D, y: number): void {
  big(ctx, "DUCKBOX", "#ffcf3f", centred("DUCKBOX", 4), y, 4);
  // The duck: a yellow head and body, an orange beak, dark glasses.
  const x = CONSOLE_W / 2 - 6;
  const by = y + 28;
  ctx.fillStyle = "#ffcf3f";
  ctx.fillRect(x + 2, by, 6, 5);
  ctx.fillRect(x, by + 5, 12, 6);
  ctx.fillStyle = "#ff8a3d";
  ctx.fillRect(x + 8, by + 2, 3, 2);
  ctx.fillStyle = "#15131b";
  ctx.fillRect(x + 3, by + 1, 5, 2);
}

function drawBoot(ctx: CanvasRenderingContext2D, s: ConsoleState): void {
  const settle = 40;
  const y = 70 - Math.max(0, settle - s.t) * 3;
  drawLogo(ctx, y);
  if (s.t > settle && Math.floor(s.t / 15) % 2 === 0) big(ctx, "PRESS START", INK, centred("PRESS START", 1), 160, 1);
}

const ROW_H = 22;
const ROW_W = 200;

function drawMenu(ctx: CanvasRenderingContext2D, s: ConsoleState): void {
  big(ctx, "DUCKBOX", "#ffcf3f", 12, 10, 2);
  const games = text("GAMES", DIM);
  ctx.drawImage(games, CONSOLE_W - 12 - games.width, 13);
  ctx.fillStyle = "#2a2538";
  ctx.fillRect(12, 24, CONSOLE_W - 24, 1);
  const rows: { title: string; label: readonly [string, string]; best: string }[] = [
    ...s.carts.map((c) => ({ title: c.title.toUpperCase(), label: c.label, best: c.scored && s.best[c.id] ? `BEST ${s.best[c.id]}` : "" })),
    { title: "LIBRARY", label: ["#3a3450", "#a39bb4"] as const, best: "YOUR GAMES" },
  ];
  // Scrolls to keep the choice in view.
  const fits = Math.floor((CONSOLE_H - 64) / ROW_H);
  const first = Math.max(0, Math.min(rows.length - fits, s.at - fits + 1));
  rows.slice(first, first + fits).forEach((r, n) => {
    const i = first + n;
    const on = i === s.at;
    const x = (CONSOLE_W - ROW_W) / 2 + (on ? 4 : 0);
    const y = 32 + n * ROW_H;
    // A cartridge: the shell, the label band, the title on it.
    ctx.fillStyle = on ? "#3b3550" : "#211d2c";
    ctx.fillRect(x, y, ROW_W, ROW_H - 4);
    ctx.fillStyle = r.label[0];
    ctx.fillRect(x + 4, y + 3, ROW_W - 8, ROW_H - 10);
    ctx.drawImage(text(r.title, r.label[1]), x + 8, y + 6);
    if (r.best) {
      const b = text(r.best, r.label[1]);
      ctx.drawImage(b, x + ROW_W - 8 - b.width, y + 6);
    }
    if (on) {
      ctx.fillStyle = "#ffcf3f";
      const ay = y + 7;
      for (let k = 0; k < 3; k++) ctx.fillRect(x - 8 + k, ay + k, 1, 5 - 2 * k);
    }
  });
  const foot = s.note?.text ?? "A: PLAY    BACK: OFF";
  ctx.drawImage(text(foot, s.note ? "#ffcf3f" : DIM), centred(foot, 1), CONSOLE_H - 14);
}

/** The console as a game: the TV opens it. */
export function consoleGame(carts: readonly Cartridge[], store: BestStore = pageStore): GameDef {
  return {
    title: "The TV",
    help: MENU_HELP,
    make() {
      const s = consoleState(carts, store.load());
      const save = (best: Record<string, number>) => store.save(best);
      return {
        get w() {
          return s.playing?.game.w ?? CONSOLE_W;
        },
        get h() {
          return s.playing?.game.h ?? CONSOLE_H;
        },
        get help() {
          return s.playing ? s.playing.cart.help + BACK_HELP : MENU_HELP;
        },
        step: (pad) => stepConsole(s, pad, save),
        draw(ctx) {
          if (s.playing) return s.playing.game.draw(ctx);
          ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = BACKDROP;
          ctx.fillRect(0, 0, CONSOLE_W, CONSOLE_H);
          if (s.phase === "boot") drawBoot(ctx, s);
          else drawMenu(ctx, s);
        },
        back: () => backConsole(s, save),
        stop: () => leave(s, save),
      };
    },
  };
}
