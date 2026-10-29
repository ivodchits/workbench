import { afterEach, describe, expect, it, vi } from "vitest";

import { readPad, type Pad, type RetroButton } from "../pad";
import { SAVE_EVERY, emulatorGame, type Emu, type Launch } from "./emulator";
import { tvScreen } from "./screen";
import { readListing, type Files, type LibraryEntry } from "./shelf";

const idle = readPad(new Set());
const holding = (...buttons: RetroButton[]): Pad => ({ ...idle, retro: new Set(buttons) });
const flush = () => new Promise((r) => setTimeout(r, 0));
const flushes = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};

const entry = (more: Partial<LibraryEntry> = {}): LibraryEntry => ({ path: "sega/game.md", title: "Game", system: "md", size: 1024, state: false, ...more });

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

/** Files that log what's asked, with a kept state for those that have one, and an
 *  in-game save on "disk" whose version is its text. */
function fakeFiles(more: Partial<Files> = {}, onDisk: string | null = null) {
  const log: string[] = [];
  const kept = new Map<string, { state: Blob; save: string }>();
  const disk = { text: onDisk };
  const version = () => disk.text ?? "none";
  const files: Files = {
    core: async (name) => (log.push(`core ${name}`), { js: new Blob(["js"]), wasm: new Blob(["wasm"]) }),
    rom: async (path) => (log.push(`rom ${path}`), { name: "game.md", bytes: new Blob(["rom"]) }),
    state: async (path) => (log.push(`state ${path}`), { state: new Blob(["saved"]), save: "" }),
    keep: async (path, state, save) => (kept.set(path, { state, save }), true),
    save: async () => ({ bytes: disk.text === null ? null : bytes(disk.text), version: version() }),
    async write(_path, b, base, force) {
      if (version() !== base && !force) return (log.push(`conflict ${str(b)}`), { changed: version() });
      if (version() !== base) log.push(`backup disk ${disk.text}`);
      disk.text = str(b);
      log.push(`write ${disk.text}`);
      return { version: version() };
    },
    backUp: async (_path, b) => (log.push(`backup tv ${str(b)}`), true),
    ...more,
  };
  return { files, log, kept, disk };
}

/** A core that logs its presses and what it's asked; `sram` is its in-game save. */
function fakeLaunch() {
  const log: string[] = [];
  const picture = { width: 320, height: 224 } as unknown as CanvasImageSource;
  const core = { sram: null as string | null };
  const emu: Emu = {
    picture,
    pressDown: (b) => void log.push(`+${b}`),
    pressUp: (b) => void log.push(`-${b}`),
    saveState: async () => (log.push("save"), new Blob(["now"])),
    loadState: async (s) => void log.push(`load ${await s.text()}`),
    readSave: async () => (core.sram === null ? null : bytes(core.sram)),
    pause: () => void log.push("pause"),
    resume: () => void log.push("resume"),
    exit: () => void log.push("exit"),
  };
  const launch: Launch = vi.fn(async (opts) => {
    core.sram = str(opts.save);
    log.push(`launch ${opts.core.name} ${opts.rom.name} ${opts.w}x${opts.h}${opts.save ? ` with ${core.sram}` : ""}`);
    return emu;
  });
  return { launch, log, emu, picture, core };
}

/** Runs `g` until it looks at its save, and lets that finish. */
async function toSaveLook(g: { step(p: Pad): void }) {
  for (let n = 0; n < SAVE_EVERY; n++) g.step(idle);
  await flushes();
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
    expect(await kept.get("sega/game.md")!.state.text()).toBe("now");
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

describe("a Library game's in-game save, shared with RetroArch", () => {
  it("starts with the folder's save, and writes it back each time the game changes it", async () => {
    const { files, log, disk } = fakeFiles({}, "one");
    const { launch, log: core, core: sram } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    expect(core[0]).toBe("launch genesis_plus_gx game.md 320x224 with one");
    // Unchanged: nothing written.
    await toSaveLook(g);
    expect(log.filter((l) => l.startsWith("write"))).toEqual([]);
    sram.sram = "two";
    await toSaveLook(g);
    expect(disk.text).toBe("two");
    sram.sram = "three";
    await toSaveLook(g);
    expect(log.filter((l) => l.startsWith("write"))).toEqual(["write two", "write three"]);
  });

  it("starts with none when the folder has none, and writes the first", async () => {
    const { files, disk } = fakeFiles();
    const { launch, log, core } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    expect(log[0]).toBe("launch genesis_plus_gx game.md 320x224");
    core.sram = "first";
    await toSaveLook(g);
    expect(disk.text).toBe("first");
  });

  it("writes the save on leaving, and keeps the state with its version", async () => {
    const { files, kept, disk } = fakeFiles({}, "one");
    const { launch, core } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    core.sram = "two";
    g.stop!();
    await g.closed;
    expect(disk.text).toBe("two");
    expect(kept.get("sega/game.md")!.save).toBe("two");
  });

  it("asks when the folder's changed underneath, and keeps the TV's on A, backing the other up", async () => {
    const { files, log, disk } = fakeFiles({}, "one");
    const { launch, log: corelog, core } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    // The phone's save arrives; then the game saves too.
    disk.text = "phone";
    core.sram = "tv";
    await toSaveLook(g);
    expect(log).toContain("conflict tv");
    expect(disk.text).toBe("phone");
    expect(g.asking).toBe(true);
    expect(corelog).toContain("pause");
    // A held as it asks doesn't count, and the game doesn't get it.
    g.step({ ...idle, a: true, retro: new Set(["a"]) });
    g.step({ ...idle, a: true, retro: new Set(["a"]) });
    expect(log).not.toContain("write tv");
    g.step(idle);
    // Start (Enter) answers as A does.
    g.step({ ...idle, start: true });
    await flushes();
    expect(g.asking).toBe(false);
    expect(log.slice(-2)).toEqual(["backup disk phone", "write tv"]);
    expect(corelog.slice(-1)).toEqual(["resume"]);
    expect(corelog).not.toContain("+a");
  });

  it("takes the folder's on B, backing up the TV's and starting again from it", async () => {
    const { files, log, disk } = fakeFiles({}, "one");
    const { launch, log: corelog, core } = fakeLaunch();
    const g = emulatorGame(entry({ state: true }), files, launch);
    await g.ready;
    disk.text = "phone";
    core.sram = "tv";
    await toSaveLook(g);
    g.step(idle);
    g.step({ ...idle, b: true });
    await flushes();
    expect(g.asking).toBe(false);
    expect(log).toContain("backup tv tv");
    expect(disk.text).toBe("phone");
    expect(corelog.filter((l) => l.startsWith("launch") || l === "exit" || l.startsWith("load"))).toEqual([
      "launch genesis_plus_gx game.md 320x224 with one",
      "load saved",
      "exit",
      "launch genesis_plus_gx game.md 320x224 with phone",
    ]);
    expect(g.phase).toBe("running");
  });

  it("left while asking, keeps the folder's and backs up the TV's", async () => {
    const { files, log, kept, disk } = fakeFiles({}, "one");
    const { launch, core } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    disk.text = "phone";
    core.sram = "tv";
    await toSaveLook(g);
    g.stop!();
    await g.closed;
    expect(disk.text).toBe("phone");
    expect(log).toContain("backup tv tv");
    // That state goes with the TV's save, not the folder's.
    expect(kept.get("sega/game.md")!.save).not.toBe("phone");
  });

  it("doesn't resume a state kept with an older save than the folder's", async () => {
    const state = async () => ({ state: new Blob(["saved"]), save: "one" });
    const newer = fakeFiles({ state }, "phone");
    const a = fakeLaunch();
    await emulatorGame(entry({ state: true }), newer.files, a.launch).ready;
    expect(a.log.some((l) => l.startsWith("load"))).toBe(false);
    const same = fakeFiles({ state }, "one");
    const b = fakeLaunch();
    await emulatorGame(entry({ state: true }), same.files, b.launch).ready;
    expect(b.log).toContain("load saved");
  });

  it("plays on unshared when the saves can't be reached", async () => {
    const { files, log } = fakeFiles({ save: async () => null });
    const { launch, core } = fakeLaunch();
    const g = emulatorGame(entry(), files, launch);
    await g.ready;
    core.sram = "x";
    await toSaveLook(g);
    expect(g.phase).toBe("running");
    expect(log.some((l) => l.startsWith("write"))).toBe(false);
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

  it("says where in-game saves go, when told", () => {
    expect(readListing({ folder: null, saves: { folder: "C:\\RA\\saves", from: "retroarch" } })?.saves).toEqual({ folder: "C:\\RA\\saves", from: "retroarch" });
    expect(readListing({ folder: null, saves: { folder: null, from: "retroarch" } })?.saves).toEqual({ folder: null, from: "retroarch" });
    expect(readListing({ folder: null, saves: { from: "elsewhere" } })?.saves).toBeUndefined();
  });
});
