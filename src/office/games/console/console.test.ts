import { describe, expect, it } from "vitest";

import type { Game } from "../game";
import { readPad, type Pad } from "../pad";
import { CARTRIDGES } from "./cartridges";
import { BOOT_STEPS, CONSOLE_H, CONSOLE_W, backConsole, consoleGame, consoleState, leave, stepConsole, type BestStore, type Cartridge } from "./console";

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
