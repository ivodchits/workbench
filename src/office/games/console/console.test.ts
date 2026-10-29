import { describe, expect, it } from "vitest";

import type { Game } from "../game";
import { readPad, type Pad } from "../pad";
import { CARTRIDGES } from "./cartridges";
import type { LibraryEntry, Listing } from "../emulator/shelf";
import { BOOT_STEPS, CONSOLE_H, CONSOLE_W, backConsole, consoleGame, consoleState, leave, stepConsole, type BestStore, type Cartridge, type Library } from "./console";

const idle = readPad(new Set());
const press = (more: Partial<Pad>): Pad => ({ ...idle, ...more });

/** A cartridge whose score is the steps it has run, and which says when it's stopped and
 *  the best it was given to beat. */
function counter(id: string, stops: string[] = [], given: number[] = []): Cartridge {
  return {
    id,
    title: id,
    label: ["#000", "#fff"],
    help: `${id} keys`,
    scored: true,
    make(best): Game {
      given.push(best);
      let n = 0;
      return {
        w: 100,
        h: 50,
        get score() {
          return n;
        },
        step: () => void n++,
        draw: () => {},
        stop: () => void stops.push(id),
      };
    },
  };
}

const memory = (best: Record<string, number> = {}) => {
  const saved: Record<string, number>[] = [];
  const store: BestStore = { load: () => ({ ...best }), save: (b) => void saved.push(b) };
  return { store, saved };
};

describe("the TV console", () => {
  it("boots to its menu by itself, or sooner on a press", () => {
    const s = consoleState(CARTRIDGES);
    // Held as it opens, a button doesn't count.
    for (let n = 0; n < 10; n++) stepConsole(s, press({ a: true }));
    expect(s.phase).toBe("boot");
    stepConsole(s, idle);
    stepConsole(s, press({ start: true }));
    expect(s.phase).toBe("menu");
    const t = consoleState(CARTRIDGES);
    for (let n = 0; n < BOOT_STEPS; n++) stepConsole(t, idle);
    expect(t.phase).toBe("menu");
  });

  it("moves through the cartridges and the Library, round and round, a press at a time", () => {
    const s = consoleState([counter("a"), counter("b")]);
    Object.assign(s, { phase: "menu" });
    const down = press({ y: 1 });
    stepConsole(s, down);
    expect(s.at).toBe(1);
    // Held: it waits before going on.
    for (let n = 0; n < 10; n++) stepConsole(s, down);
    expect(s.at).toBe(1);
    stepConsole(s, idle);
    stepConsole(s, down);
    expect(s.at).toBe(2);
    stepConsole(s, idle);
    stepConsole(s, down);
    expect(s.at).toBe(0);
    stepConsole(s, idle);
    stepConsole(s, press({ y: -1 }));
    expect(s.at).toBe(2);
    // The Library has nothing yet: a note, no game.
    stepConsole(s, idle);
    stepConsole(s, press({ a: true }));
    expect(s.phase).toBe("menu");
    expect(s.note?.text).toMatch(/LIBRARY/);
  });

  it("plays a cartridge at its own size and help, and Back takes it to the menu", () => {
    const stops: string[] = [];
    const { store, saved } = memory();
    const def = consoleGame([counter("a", stops)], store);
    const game = def.make();
    expect([game.w, game.h]).toEqual([CONSOLE_W, CONSOLE_H]);
    game.step(idle);
    game.step(press({ start: true }));
    game.step(idle);
    game.step(press({ a: true }));
    expect([game.w, game.h]).toEqual([100, 50]);
    expect(game.help).toMatch(/^a keys.*menu/);
    for (let n = 0; n < 30; n++) game.step(idle);
    expect(game.back!()).toBe(true);
    expect(stops).toEqual(["a"]);
    expect([game.w, game.h]).toEqual([CONSOLE_W, CONSOLE_H]);
    expect(saved[saved.length - 1]).toEqual({ a: 30 });
    // From the menu Back isn't taken: the overlay turns it off.
    expect(game.back!()).toBe(false);
    // A button still held from the game doesn't start it again.
    game.step(press({ a: true }));
    expect(game.w).toBe(CONSOLE_W);
  });

  it("keeps the best, not the last, and brings it back next time", () => {
    const { store, saved } = memory({ a: 40 });
    const given: number[] = [];
    const s = consoleState([counter("a", [], given)], store.load());
    const save = (b: Record<string, number>) => store.save(b);
    Object.assign(s, { phase: "menu", held: { a: false, start: false, dir: 0 } });
    stepConsole(s, press({ a: true }), save);
    for (let n = 0; n < 10; n++) stepConsole(s, idle, save);
    backConsole(s, save);
    expect(saved[saved.length - 1]).toEqual({ a: 40 });
    stepConsole(s, idle, save);
    stepConsole(s, press({ a: true }), save);
    for (let n = 0; n < 60; n++) stepConsole(s, idle, save);
    // Turned off mid-game, it's still kept.
    leave(s, save);
    expect(saved[saved.length - 1]).toEqual({ a: 60 });
    // Each game is given the best to beat.
    expect(given).toEqual([40, 40]);
  });

  it("has Star run and the pad test among its cartridges", () => {
    expect(CARTRIDGES.map((c) => c.id)).toEqual(["star-run", "pad-test"]);
    const ids = CARTRIDGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A Library with these games, a folder chosen as `next` when asked, and its games
 *  logging what they're asked to do. */
function shelfOf(games: LibraryEntry[], next: Listing | null = null) {
  const log: string[] = [];
  let listing: Listing = { folder: games.length ? "G:/games" : null, games };
  const library: Library = {
    shelf: {
      list: async () => (log.push("list"), structuredClone(listing)),
      choose: async () => (log.push("choose"), next && (listing = next), structuredClone(listing)),
      chooseSaves: async () => (log.push("choose saves"), (listing = { ...listing, saves: { folder: "D:/Sync/saves", from: "hand" } }), structuredClone(listing)),
    },
    play(entry, fresh) {
      log.push(`play ${entry.path}${fresh ? " fresh" : ""}`);
      let done = false;
      return {
        w: 320,
        h: 224,
        keepsBack: true,
        get done() {
          return done;
        },
        step: (pad) => void (pad.start && (done = true)),
        draw: () => {},
        stop: () => void log.push(`stop ${entry.path}`),
      };
    },
  };
  return { library, log };
}

const game = (path: string, more: Partial<LibraryEntry> = {}): LibraryEntry => ({ path, title: path, system: "md", size: 100, state: false, ...more });

/** A console at its menu with the Library chosen and open. */
async function inLibrary(library: Library) {
  const s = consoleState([counter("a")], {}, library);
  Object.assign(s, { phase: "menu", at: 1, held: { a: false, b: false, start: false, dir: 0 } });
  stepConsole(s, press({ a: true }));
  await flush();
  stepConsole(s, idle);
  return s;
}

describe("the TV console's Library", () => {
  it("lists the games in the folder, and moves through them, the folder row and the saves row", async () => {
    const { library, log } = shelfOf([game("a.md"), game("b.nes", { system: "nes" })]);
    const s = await inLibrary(library);
    expect(s.phase).toBe("library");
    expect(log).toEqual(["list"]);
    expect(s.lib.status).toBe("ready");
    expect(s.lib.listing.games.map((g) => g.path)).toEqual(["a.md", "b.nes"]);
    const down = press({ y: 1 });
    for (const at of [1, 2, 3, 0]) {
      stepConsole(s, down);
      stepConsole(s, idle);
      expect(s.lib.at).toBe(at);
    }
  });

  it("plays a game with A, resuming it, and comes back to the Library with it marked", async () => {
    const { library, log } = shelfOf([game("a.md")]);
    const s = await inLibrary(library);
    const tv = consoleGame([], memory().store, library).make();
    expect(tv.keepsBack).toBe(false);
    stepConsole(s, press({ a: true }));
    expect(s.phase).toBe("play");
    expect(log).toEqual(["list", "play a.md"]);
    expect(s.playing!.game.keepsBack).toBe(true);
    // Esc goes back to the Library, not the menu; the game leaves a state behind.
    expect(backConsole(s)).toBe(true);
    expect(s.phase).toBe("library");
    expect(log).toEqual(["list", "play a.md", "stop a.md"]);
    expect(s.lib.listing.games[0].state).toBe(true);
    // Esc again: the menu.
    expect(backConsole(s)).toBe(true);
    expect(s.phase).toBe("menu");
  });

  it("starts a game over with B", async () => {
    const { library, log } = shelfOf([game("a.md", { state: true })]);
    const s = await inLibrary(library);
    stepConsole(s, press({ b: true }));
    expect(log).toEqual(["list", "play a.md fresh"]);
  });

  it("leaves a game that asks to go", async () => {
    const { library, log } = shelfOf([game("a.md")]);
    const s = await inLibrary(library);
    stepConsole(s, press({ a: true }));
    stepConsole(s, press({ start: true }));
    expect(s.phase).toBe("library");
    expect(log).toContain("stop a.md");
  });

  it("won't play an empty file", async () => {
    const { library, log } = shelfOf([game("empty.md", { size: 0 })]);
    const s = await inLibrary(library);
    stepConsole(s, press({ a: true }));
    expect(s.phase).toBe("library");
    expect(s.note?.text).toBe("THAT FILE IS EMPTY");
    expect(log).toEqual(["list"]);
  });

  it("chooses the folder from its last row, then lists what's in it", async () => {
    const chosen: Listing = { folder: "C:/roms", games: [game("x.md")] };
    const { library, log } = shelfOf([], chosen);
    const s = await inLibrary(library);
    expect(s.lib.listing.folder).toBeNull();
    expect(s.lib.at).toBe(0);
    stepConsole(s, press({ a: true }));
    expect(s.lib.choosing).toBe(true);
    // Nothing more is taken while the dialog is up.
    stepConsole(s, idle);
    stepConsole(s, press({ a: true }));
    expect(log).toEqual(["list", "choose"]);
    await flush();
    expect(s.lib.choosing).toBe(false);
    expect(s.lib.listing).toEqual(chosen);
  });

  it("chooses the saves folder from the row after, and stays on that row", async () => {
    const { library, log } = shelfOf([game("a.md")]);
    const s = await inLibrary(library);
    for (let n = 0; n < 2; n++) {
      stepConsole(s, press({ y: 1 }));
      stepConsole(s, idle);
    }
    expect(s.lib.at).toBe(2);
    stepConsole(s, press({ a: true }));
    expect(s.note?.text).toMatch(/SAVES/);
    await flush();
    expect(log).toEqual(["list", "choose saves"]);
    expect(s.lib.listing.saves).toEqual({ folder: "D:/Sync/saves", from: "hand" });
    expect(s.lib.at).toBe(2);
  });

  it("stays empty with a note when there's no Library to read", () => {
    const s = consoleState([counter("a")]);
    Object.assign(s, { phase: "menu", at: 1, held: { a: false, b: false, start: false, dir: 0 } });
    stepConsole(s, press({ a: true }));
    expect(s.phase).toBe("menu");
    expect(s.note?.text).toBe("THE LIBRARY IS EMPTY FOR NOW");
  });
});
