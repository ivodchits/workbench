import { afterEach, describe, expect, it, vi } from "vitest";

import { readPad, type Pad, type RetroButton } from "../pad";
import { emulatorGame, type Emu, type Launch } from "./emulator";
import { tvScreen } from "./screen";
import { readListing, type Files, type LibraryEntry } from "./shelf";

const idle = readPad(new Set());
const holding = (...buttons: RetroButton[]): Pad => ({ ...idle, retro: new Set(buttons) });
const flush = () => new Promise((r) => setTimeout(r, 0));

const entry = (more: Partial<LibraryEntry> = {}): LibraryEntry => ({ path: "sega/game.md", title: "Game", system: "md", size: 1024, state: false, ...more });

/** Files that log what's asked, with a kept state for those that have one. */
function fakeFiles(more: Partial<Files> = {}) {
  const log: string[] = [];
  const kept = new Map<string, Blob>();
  const files: Files = {
    core: async (name) => (log.push(`core ${name}`), { js: new Blob(["js"]), wasm: new Blob(["wasm"]) }),
    rom: async (path) => (log.push(`rom ${path}`), { name: "game.md", bytes: new Blob(["rom"]) }),
    state: async (path) => (log.push(`state ${path}`), new Blob(["saved"])),
    keep: async (path, state) => (kept.set(path, state), true),
    ...more,
  };
  return { files, log, kept };
}

/** A core that logs its presses and what it's asked. */
function fakeLaunch() {
  const log: string[] = [];
  const picture = { width: 320, height: 224 } as unknown as CanvasImageSource;
  const emu: Emu = {
    picture,
    pressDown: (b) => void log.push(`+${b}`),
    pressUp: (b) => void log.push(`-${b}`),
    saveState: async () => (log.push("save"), new Blob(["now"])),
    loadState: async (s) => void log.push(`load ${await s.text()}`),
    exit: () => void log.push("exit"),
  };
  const launch: Launch = vi.fn(async (opts) => (log.push(`launch ${opts.core.name} ${opts.rom.name} ${opts.w}x${opts.h}`), emu));
  return { launch, log, emu, picture };
}

afterEach(() => tvScreen.set(null));

describe("a Library game", () => {
  it("loads its core and image, starts, and shows on the TV", async () => {
    const { files, log: asked } = fakeFiles();
    const { launch, log, picture } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    expect(g.phase).toBe("loading");
    expect([g.w, g.h]).toEqual([320, 224]);
    expect(g.keepsBack).toBe(false);
    await g.ready;
    expect(asked).toEqual(["core genesis_plus_gx", "rom sega/game.md"]);
    expect(log).toEqual(["launch genesis_plus_gx game.md 320x224"]);
    expect(g.phase).toBe("running");
    expect(g.keepsBack).toBe(true);
    expect(tvScreen.get()).toBe(picture);
  });

  it("presses the RetroPad's buttons into the core as they change, not those held from the menu", async () => {
    const { files } = fakeFiles();
    const { launch, log } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    log.length = 0;
    // B was the press that chose the game: it counts only once let go.
    g.step(holding("b"));
    g.step(holding("b", "right"));
    g.step(holding("right"));
    g.step(holding("b", "right"));
    g.step(idle);
    expect(log).toEqual(["+right", "+b", "-right", "-b"]);
  });

  it("asks to be left on Select with Start, letting go of everything", async () => {
    const { files } = fakeFiles();
    const { launch, log } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    g.step(idle);
    g.step(holding("a", "select"));
    expect(g.done).toBe(false);
    g.step(holding("a", "select", "start"));
    expect(g.done).toBe(true);
    expect(log.slice(1)).toEqual(["+a", "+select", "-a", "-select"]);
  });

  it("keeps a save state on leaving, then frees the core", async () => {
    const { files, kept } = fakeFiles();
    const { launch, log } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    g.step(idle);
    g.step(holding("a"));
    g.stop!();
    expect(g.phase).toBe("closed");
    expect(tvScreen.get()).toBeNull();
    await g.closed;
    expect(log.slice(1)).toEqual(["+a", "-a", "save", "exit"]);
    expect(await kept.get("sega/game.md")!.text()).toBe("now");
  });

  it("frees the core even when the state can't be kept", async () => {
    const { files } = fakeFiles({ keep: () => Promise.reject(new Error("disk full")) });
    const { launch, log } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    g.stop!();
    await g.closed;
    expect(log).toContain("exit");
  });

  it("resumes from its save state, unless started over", async () => {
    const resumed = fakeFiles();
    const one = fakeLaunch();
    const g = emulatorGame(entry({ state: true }), resumed.files, one.launch);
    await g.ready;
    expect(resumed.log).toContain("state sega/game.md");
    expect(one.log).toContain("load saved");
    const fresh = fakeFiles();
    const two = fakeLaunch();
    await emulatorGame(entry({ state: true }), fresh.files, two.launch, true).ready;
    expect(fresh.log).not.toContain("state sega/game.md");
    expect(two.log.some((l) => l.startsWith("load"))).toBe(false);
  });

  it("starts no core once left while loading, and stops one that comes up after", async () => {
    const early = fakeLaunch();
    const g = emulatorGame(entry(), fakeFiles().files, early.launch);
    g.stop!();
    await g.ready;
    expect(early.log).toEqual([]);
    expect(g.phase).toBe("closed");
    // Left while the core starts.
    const late = fakeLaunch();
    let started!: () => void;
    const slow: Launch = (opts) => new Promise((r) => (started = () => r(late.launch(opts))));
    const h = emulatorGame(entry(), fakeFiles().files, slow);
    await flush();
    h.stop!();
    started();
    await h.ready;
    expect(late.log).toEqual(["launch genesis_plus_gx game.md 320x224", "exit"]);
    expect(tvScreen.get()).toBeNull();
  });

  it("says why when it can't start, and gives Back back", async () => {
    const cases: [Partial<Files>, Launch | null, string][] = [
      [{ core: async () => null }, null, "core"],
      [{ rom: async () => ({ name: "x.md", bytes: new Blob([]) }) }, null, "empty"],
      [{ rom: async () => null }, null, "read"],
      [{}, () => Promise.reject(new Error("no webgl")), "start"],
    ];
    for (const [more, launch, why] of cases) {
      const g = emulatorGame(entry(), fakeFiles(more).files, launch ?? fakeLaunch().launch);
      await g.ready;
      expect(g.phase, why).toBe("failed");
      expect(g.keepsBack).toBe(false);
      g.stop!();
      await flush();
    }
  });
});

describe("the Library's listing", () => {
  it("takes the games of known systems, as sent", () => {
    const l = readListing({
      folder: "G:\\games",
      games: [
        { path: "a.md", title: "A", system: "md", size: 10, state: true },
        { path: "b.iso", title: "B", system: "ps2", size: 10 },
        { path: "c.nes", title: "C", system: "nes" },
        null,
      ],
    });
    expect(l).toEqual({
      folder: "G:\\games",
      missing: false,
      games: [
        { path: "a.md", title: "A", system: "md", size: 10, state: true },
        { path: "c.nes", title: "C", system: "nes", size: 0, state: false },
      ],
    });
    expect(readListing({ folder: null })).toEqual({ folder: null, missing: false, games: [] });
    expect(readListing("nope")).toBeNull();
  });
});
