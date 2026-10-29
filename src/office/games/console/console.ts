// The TV's games console (office plan O5.3a): it boots with its logo, then a menu of
// cartridges — our own games (`cartridges.ts`) and the Library, your game images
// through an emulator (O5.3d). A cartridge plays at its own size; Esc or Back takes it
// out to the menu, and from the menu turns the console off. Each cartridge's best score
// is kept (in the page's storage) and shown on its label. The Library lists the games
// in the folder you chose; A plays one (resuming it where you left it), B starts it
// over, and its last rows choose the folder and where in-game saves go (O5.3e).

import { textBitmap } from "../../art/font";
import { cached } from "../../canvas";
import { EMULATOR_BACK, EMULATOR_HELP } from "../emulator/emulator";
import type { LibraryEntry, Listing, Shelf } from "../emulator/shelf";
import { SYSTEMS } from "../emulator/systems";
import type { Game, GameDef } from "../game";
import type { Pad } from "../pad";

export interface Cartridge {
  id: string;
  title: string;
  /** The label's colours: its band, and the ink on it. */
  label: readonly [string, string];
  help: string;
  /** What leaves it, after the help; the console's Esc or Back when not given. */
  back?: string;
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

/** The Library's games and how one is played; without it the Library stays empty. */
export interface Library {
  shelf: Pick<Shelf, "list" | "choose" | "chooseSaves">;
  play(entry: LibraryEntry, fresh: boolean): Game;
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
const LIBRARY_HELP = "up/down or the d-pad: choose · Z/Enter or A/Start: play · X or B: start over · Esc or Back: to the menu";
const BACK_HELP = " · Esc or Back: to the menu";

export interface LibraryView {
  status: "loading" | "ready" | "failed";
  listing: Listing;
  /** The choice: a game's index, `games.length` for the folder row, or one more for
   *  the saves row. */
  at: number;
  /** A folder dialog is open on the PC. */
  choosing: boolean;
}

export interface ConsoleState {
  phase: "boot" | "menu" | "library" | "play";
  /** Steps since the phase began. */
  t: number;
  carts: readonly Cartridge[];
  /** The menu's choice: a cartridge's index, or `carts.length` for the Library. */
  at: number;
  playing: { cart: Cartridge; game: Game; from: "menu" | "library"; entry?: LibraryEntry } | null;
  best: Record<string, number>;
  note: { text: string; until: number } | null;
  /** Buttons held at the last step, so a press counts once; held at boot. */
  held: { a: boolean; b: boolean; start: boolean; dir: number };
  /** Steps the direction has been held. */
  holding: number;
  library: Library | null;
  lib: LibraryView;
}

const noListing = (): Listing => ({ folder: null, games: [] });

export function consoleState(carts: readonly Cartridge[], best: Record<string, number> = {}, library: Library | null = null): ConsoleState {
  return {
    phase: "boot",
    t: 0,
    carts,
    at: 0,
    playing: null,
    best: { ...best },
    note: null,
    held: { a: true, b: true, start: true, dir: 0 },
    holding: 0,
    library,
    lib: { status: "loading", listing: noListing(), at: 0, choosing: false },
  };
}

/** Takes a listing in, keeping the choice on the same game where it can. */
function shelve(s: ConsoleState, listing: Listing | null): void {
  const was = s.lib.listing.games[s.lib.at]?.path;
  if (!listing) {
    s.lib.status = "failed";
    return;
  }
  const old = s.lib.listing.games.length;
  const found = listing.games.findIndex((g) => g.path === was);
  // On a game, the same game; on the saves row, still that row.
  const at = found >= 0 ? found : s.lib.at > old ? listing.games.length + 1 : Math.min(s.lib.at, listing.games.length);
  s.lib = { ...s.lib, status: "ready", listing, at };
}

/** Asks for the Library's listing again. */
function restock(s: ConsoleState): void {
  if (!s.library) return;
  s.lib.status = "loading";
  void s.library.shelf.list().then((l) => shelve(s, l));
}

const say = (s: ConsoleState, text: string) => (s.note = { text, until: s.t + NOTE_STEPS });

/** One step of the console; `save` keeps a new best. */
export function stepConsole(s: ConsoleState, pad: Pad, save: (best: Record<string, number>) => void = () => {}): void {
  s.t++;
  if (s.phase === "play" && s.playing) {
    s.playing.game.step(pad);
    keepBest(s, save, false);
    if (s.playing.game.done) backConsole(s, save);
    return;
  }
  const dir = pad.y < -PUSH ? -1 : pad.y > PUSH ? 1 : 0;
  const press = (pad.a && !s.held.a) || (pad.start && !s.held.start);
  const pressB = pad.b && !s.held.b;
  s.holding = dir !== 0 && dir === s.held.dir ? s.holding + 1 : 0;
  const moved = dir !== 0 && (s.holding === 0 || (s.holding >= REPEAT_FIRST && (s.holding - REPEAT_FIRST) % REPEAT_NEXT === 0));
  s.held = { a: pad.a, b: pad.b, start: pad.start, dir };
  if (s.note && s.t >= s.note.until) s.note = null;

  if (s.phase === "boot") {
    if (press || s.t >= BOOT_STEPS) Object.assign(s, { phase: "menu", t: 0 });
    return;
  }
  if (s.phase === "library") return stepLibrary(s, moved ? dir : 0, press, pressB);
  const count = s.carts.length + 1;
  if (moved) s.at = (s.at + dir + count) % count;
  if (!press) return;
  const cart = s.carts[s.at];
  if (cart) {
    Object.assign(s, { phase: "play", t: 0, playing: { cart, game: cart.make(s.best[cart.id] ?? 0), from: "menu" }, note: null });
    return;
  }
  if (!s.library) {
    say(s, "THE LIBRARY IS EMPTY FOR NOW");
    return;
  }
  Object.assign(s, { phase: "library", t: 0, note: null });
  restock(s);
}

function stepLibrary(s: ConsoleState, dir: number, press: boolean, pressB: boolean): void {
  const { games } = s.lib.listing;
  const count = games.length + 2;
  if (dir) s.lib.at = (s.lib.at + dir + count) % count;
  if (!(press || pressB) || !s.library || s.lib.choosing) return;
  const entry = games[s.lib.at];
  if (!entry) {
    if (!press) return;
    const saves = s.lib.at > games.length;
    s.lib.choosing = true;
    say(s, saves ? "CHOOSE THE SAVES FOLDER ON THE PC" : "CHOOSE THE FOLDER IN THE WINDOW ON THE PC");
    void (saves ? s.library.shelf.chooseSaves() : s.library.shelf.choose()).then((l) => {
      s.lib.choosing = false;
      s.note = null;
      shelve(s, l);
    });
    return;
  }
  if (entry.size === 0) {
    say(s, "THAT FILE IS EMPTY");
    return;
  }
  const cart: Cartridge = {
    id: `${LIBRARY_ID}/${entry.path}`,
    title: entry.title,
    label: ["#3a3450", "#a39bb4"],
    help: EMULATOR_HELP,
    back: EMULATOR_BACK,
    make: () => s.library!.play(entry, pressB),
  };
  Object.assign(s, { phase: "play", t: 0, playing: { cart, game: cart.make(0), from: "library", entry }, note: null });
}

/** Esc or Back: out of a cartridge to where it was chosen, or out of the Library to the
 *  menu (true); not taken in the menu, to turn off. */
export function backConsole(s: ConsoleState, save: (best: Record<string, number>) => void = () => {}): boolean {
  if (s.phase === "library") {
    Object.assign(s, { phase: "menu", t: 0, note: null, held: { a: true, b: true, start: true, dir: 0 } });
    return true;
  }
  if (s.phase !== "play" || !s.playing) return false;
  const { from, entry } = s.playing;
  leave(s, save);
  // It leaves a save state behind: it resumes from now on.
  if (entry) entry.state = true;
  Object.assign(s, { phase: from, t: 0, held: { a: true, b: true, start: true, dir: 0 } });
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

/** `s` cut to fit `w` pixels, with an ellipsis. */
function fit(s: string, w: number): string {
  if (text(s, INK).width <= w) return s;
  let cut = s;
  while (cut.length > 1 && text(`${cut}…`, INK).width > w) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

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

/** The heading over a list: the console's name, and what the list is. */
function drawHeading(ctx: CanvasRenderingContext2D, what: string): void {
  big(ctx, "DUCKBOX", "#ffcf3f", 12, 10, 2);
  const label = text(what, DIM);
  ctx.drawImage(label, CONSOLE_W - 12 - label.width, 13);
  ctx.fillStyle = "#2a2538";
  ctx.fillRect(12, 24, CONSOLE_W - 24, 1);
}

/** The arrow by the choice, its row's top-left at (x, y). */
function drawPointer(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#ffcf3f";
  for (let k = 0; k < 3; k++) ctx.fillRect(x - 8 + k, y + k, 1, 5 - 2 * k);
}

/** The first of `rows` rows to show so that `at` is in view, `fits` at a time. */
const firstShown = (rows: number, fits: number, at: number) => Math.max(0, Math.min(rows - fits, at - fits + 1));

function drawFoot(ctx: CanvasRenderingContext2D, s: ConsoleState, idle: string, color = DIM): void {
  const foot = s.note?.text ?? idle;
  ctx.drawImage(text(foot, s.note ? "#ffcf3f" : color), centred(foot, 1), CONSOLE_H - 14);
}

const ROW_H = 22;
const ROW_W = 200;

function drawMenu(ctx: CanvasRenderingContext2D, s: ConsoleState): void {
  drawHeading(ctx, "GAMES");
  const rows: { title: string; label: readonly [string, string]; best: string }[] = [
    ...s.carts.map((c) => ({ title: c.title.toUpperCase(), label: c.label, best: c.scored && s.best[c.id] ? `BEST ${s.best[c.id]}` : "" })),
    { title: "LIBRARY", label: ["#3a3450", "#a39bb4"] as const, best: "YOUR GAMES" },
  ];
  // Scrolls to keep the choice in view.
  const fits = Math.floor((CONSOLE_H - 64) / ROW_H);
  const first = firstShown(rows.length, fits, s.at);
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
    if (on) drawPointer(ctx, x, y + 7);
  });
  drawFoot(ctx, s, "A: PLAY    BACK: OFF");
}

const LIB_ROW_H = 13;
const LIB_TOP = 44;

/** Where in-game saves go, in a few words. */
function savesShown(listing: Listing): string {
  const saves = listing.saves;
  if (!saves) return "NOT SHARED";
  if (!saves.folder) return "BESIDE EACH GAME";
  if (saves.from === "retroarch") return "RETROARCH'S FOLDER";
  if (saves.from === "office") return "THE OFFICE'S OWN";
  return saves.folder.split("\\").join("/").toUpperCase();
}

function drawLibrary(ctx: CanvasRenderingContext2D, s: ConsoleState): void {
  drawHeading(ctx, "LIBRARY");
  const { listing, status, at } = s.lib;
  const where = listing.folder ? fit(listing.folder.split("\\").join("/").toUpperCase(), CONSOLE_W - 24) : "NO FOLDER CHOSEN YET";
  ctx.drawImage(text(where, DIM), 12, 30);
  const rows = [
    ...listing.games.map((g) => ({ title: g.title.toUpperCase(), tag: g.size === 0 ? "EMPTY FILE" : SYSTEMS[g.system].name, mark: g.state && g.size > 0, empty: g.size === 0 })),
    { title: listing.folder ? "CHOOSE ANOTHER FOLDER…" : "CHOOSE THE FOLDER…", tag: "", mark: false, empty: false },
    { title: `SAVES: ${savesShown(listing)}`, tag: "CHANGE…", mark: false, empty: false },
  ];
  const fits = Math.floor((CONSOLE_H - LIB_TOP - 22) / LIB_ROW_H);
  const first = firstShown(rows.length, fits, at);
  rows.slice(first, first + fits).forEach((r, n) => {
    const i = first + n;
    const on = i === at;
    const y = LIB_TOP + n * LIB_ROW_H;
    if (on) {
      ctx.fillStyle = "#2a2538";
      ctx.fillRect(10, y - 3, CONSOLE_W - 20, LIB_ROW_H - 2);
      drawPointer(ctx, 18, y);
    }
    const tag = text(r.tag, r.empty ? "#ff8a3d" : DIM);
    const room = CONSOLE_W - 24 - 22 - tag.width - 8;
    ctx.drawImage(text(fit(r.title, room), r.empty ? DIM : on ? INK : "#a39bb4"), 22, y);
    if (r.mark) {
      // A dot: it resumes.
      ctx.fillStyle = "#7fd17f";
      ctx.fillRect(13, y + 1, 3, 3);
    }
    ctx.drawImage(tag, CONSOLE_W - 12 - tag.width, y);
  });
  if (first + fits < rows.length) ctx.drawImage(text("…", DIM), CONSOLE_W / 2 - 2, LIB_TOP + fits * LIB_ROW_H - 4);
  const state =
    status === "loading" ? "LOOKING…" : status === "failed" ? "THE LIBRARY COULDN'T BE READ" : listing.missing ? "THE FOLDER ISN'T THERE" : listing.folder && !listing.games.length ? "NO GAMES IN IT" : "";
  drawFoot(ctx, s, state || "A: PLAY   B: START OVER   BACK: MENU", state ? "#ff8a3d" : DIM);
}

/** The console as a game: the TV opens it. */
export function consoleGame(carts: readonly Cartridge[], store: BestStore = pageStore, library: Library | null = null): GameDef {
  return {
    title: "The TV",
    help: MENU_HELP,
    make() {
      const s = consoleState(carts, store.load(), library);
      const save = (best: Record<string, number>) => store.save(best);
      return {
        get w() {
          return s.playing?.game.w ?? CONSOLE_W;
        },
        get h() {
          return s.playing?.game.h ?? CONSOLE_H;
        },
        get help() {
          if (s.playing) return s.playing.cart.help + (s.playing.cart.back ?? BACK_HELP);
          return s.phase === "library" ? LIBRARY_HELP : MENU_HELP;
        },
        get keepsBack() {
          return s.playing?.game.keepsBack ?? false;
        },
        step: (pad) => stepConsole(s, pad, save),
        draw(ctx) {
          if (s.playing) return s.playing.game.draw(ctx);
          ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = BACKDROP;
          ctx.fillRect(0, 0, CONSOLE_W, CONSOLE_H);
          if (s.phase === "boot") drawBoot(ctx, s);
          else if (s.phase === "library") drawLibrary(ctx, s);
          else drawMenu(ctx, s);
        },
        back: () => backConsole(s, save),
        stop: () => leave(s, save),
      };
    },
  };
}
