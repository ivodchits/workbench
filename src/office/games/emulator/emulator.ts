// A game from the TV's Library (office plan O5.3d), played by a libretro core: it
// fetches the core, the image and the save state, starts the core, and from then on
// hands the pad's RetroPad buttons to it and copies its picture. Leaving keeps a save
// state, so the game resumes where it was (`fresh` starts it over). Back on a gamepad
// is the game's Select; Back with Start, or Esc, leaves.
//
// Its in-game save (O5.3e) is RetroArch's own `.srm`, shared through the listener: read
// when the game starts, and written back whenever the game changes it and on leaving,
// only over the copy it was read as. If that copy changed meanwhile (Syncthing brought
// the phone's), the game pauses and asks which to keep, the other being backed up. A
// save state kept with an older save than the folder's isn't resumed over it.

import { textBitmap } from "../../art/font";
import { cached } from "../../canvas";
import type { Game } from "../game";
import type { Pad, RetroButton } from "../pad";
import { tvScreen } from "./screen";
import type { Files, LibraryEntry, Save } from "./shelf";
import { SYSTEMS } from "./systems";

/** A running core, as the game uses it. */
export interface Emu {
  /** Its picture, at the system's size. */
  picture: CanvasImageSource;
  pressDown(button: RetroButton): void;
  pressUp(button: RetroButton): void;
  saveState(): Promise<Blob>;
  loadState(state: Blob): Promise<void>;
  /** The in-game save as the core has it now; null for a game without one. */
  readSave(): Promise<Uint8Array | null>;
  pause(): void;
  resume(): void;
  /** Stops the core and lets its memory go. */
  exit(): void;
}

export type Launch = (opts: {
  core: { name: string; js: Blob; wasm: Blob };
  rom: { name: string; bytes: Blob };
  /** The in-game save to start with. */
  save: Uint8Array | null;
  w: number;
  h: number;
}) => Promise<Emu>;

export type EmuPhase = "loading" | "running" | "failed" | "closed";

/** How long a note over the picture shows ("resumed"). */
const NOTE_STEPS = 120;
/** How long leaving waits on the saves before stopping the core anyway. */
const SAVE_WAIT_MS = 4000;
/** How often the in-game save is looked at, in steps (two seconds). */
export const SAVE_EVERY = 120;

export const EMULATOR_HELP =
  "arrows, Z X A S, Q W, Enter, right Shift, or a gamepad: the RetroPad · Back on a gamepad: Select";
export const EMULATOR_BACK = " · Esc or Back+Start: to the Library";

export interface EmulatorGame extends Game {
  readonly phase: EmuPhase;
  /** Back with Start was pressed: the console takes the game out. */
  readonly done: boolean;
  /** Gamepad Back is the game's (Select) while it runs. */
  readonly keepsBack: boolean;
  /** The in-game save changed on disk under the game: it waits on A or Start (the
   *  TV's) or B (the folder's). */
  readonly asking: boolean;
  /** Settles once the core is running, or failed. */
  readonly ready: Promise<void>;
  /** Settles once leaving has kept the saves and stopped the core. */
  closed: Promise<void>;
}

const text = (s: string, color: string) => cached(`emu-text/${color}/${s}`, () => textBitmap(s, color));

const same = (a: Uint8Array, b: Uint8Array | null) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The game in `entry`, its files from `files`, its core started by `launch`. */
export function emulatorGame(entry: LibraryEntry, files: Files, launch: Launch, fresh = false): EmulatorGame {
  const sys = SYSTEMS[entry.system];
  let phase: EmuPhase = "loading";
  let why = "";
  let emu: Emu | null = null;
  let done = false;
  let note: { text: string; until: number } | null = null;
  let t = 0;
  /** Buttons pressed into the core; and those held when it started, not pressed till
   *  let go (the A that chose the game). */
  const down = new Set<RetroButton>();
  let stale: Set<RetroButton> | null = null;
  /** The in-game save as on disk when last read or written; null when not shared. */
  let disk: Save | null = null;
  /** A look at the save under way. */
  let syncing: Promise<void> | null = null;
  /** The TV's save, which the disk's changed under; A and B as they were held; and
   *  whether an answer is being carried out. */
  let conflict: { bytes: Uint8Array; held: { a: boolean; b: boolean } | null; busy: boolean } | null = null;
  let loaded: { core: { js: Blob; wasm: Blob }; rom: { name: string; bytes: Blob } } | null = null;

  /** Left while it loaded (a check the compiler can't narrow away across awaits). */
  const left = () => phase === "closed";
  const fail = (message: string) => {
    phase = "failed";
    why = message;
  };
  const say = (s: string) => (note = { text: s, until: t + NOTE_STEPS });

  /** Starts the core with `save`, then puts it where `state` was. */
  const boot = async (save: Uint8Array | null, state: Blob | null) => {
    const { core, rom } = loaded!;
    let started: Emu;
    try {
      started = await launch({ core: { name: sys.core, ...core }, rom, save, w: sys.w, h: sys.h });
    } catch (e) {
      console.warn("[library] the core didn't start:", e);
      if (!left()) fail("THE CORE WOULDN'T START");
      return;
    }
    if (left()) return started.exit();
    emu = started;
    if (state) {
      try {
        await started.loadState(state);
        say("RESUMED");
      } catch {
        say("THE SAVE STATE WOULDN'T LOAD");
      }
    }
    if (left()) return;
    phase = "running";
    tvScreen.set(started.picture);
  };

  const ready = (async () => {
    const [core, rom, kept, save] = await Promise.all([
      files.core(sys.core),
      files.rom(entry.path),
      fresh || !entry.state ? null : files.state(entry.path),
      files.save(entry.path),
    ]);
    if (left()) return;
    if (!core) return fail("THE CORE WOULDN'T LOAD");
    if (!rom || rom.bytes.size === 0) return fail(rom ? "THE FILE IS EMPTY" : "THE GAME COULDN'T BE READ");
    loaded = { core, rom };
    disk = save;
    // A state from before the save changed elsewhere would play the old save's game.
    const outdated = !!kept && !!save && kept.save !== "" && kept.save !== save.version;
    await boot(save?.bytes ?? null, outdated ? null : (kept?.state ?? null));
    if (outdated) say("THE SAVE CHANGED ELSEWHERE: STARTED FROM IT");
  })();

  /** Writes the core's save if it changed: over the disk's copy, or into a conflict. */
  const sync = async (core: Emu, leaving: boolean) => {
    const was = disk;
    if (!was || conflict) return;
    const bytes = await core.readSave().catch(() => null);
    if (!bytes || same(bytes, was.bytes)) return;
    const w = await files.write(entry.path, bytes, was.version);
    if (!w) return;
    if ("version" in w) {
      disk = { bytes, version: w.version };
      if (!leaving) say("SAVED");
    } else if (leaving) {
      // No one to ask: the folder's stays, and the TV's is backed up.
      await files.backUp(entry.path, bytes);
    } else if (!left()) {
      conflict = { bytes, held: null, busy: false };
      core.pause();
    }
  };

  const look = (core: Emu, leaving = false) => {
    const run = (syncing ?? Promise.resolve()).then(() => sync(core, leaving)).catch(() => undefined);
    const tracked: Promise<void> = run.finally(() => {
      if (syncing === tracked) syncing = null;
    });
    syncing = tracked;
    return run;
  };

  /** A or B on the question: keep the TV's save (backing up the disk's), or take the
   *  disk's (backing up the TV's) and start the game again from it. */
  const settle = async (keepTv: boolean) => {
    const c = conflict!;
    const core = emu!;
    c.busy = true;
    const again = () => Object.assign(c, { busy: false, held: { a: true, b: true } });
    if (keepTv) {
      const w = await files.write(entry.path, c.bytes, disk!.version, true);
      if (left()) return;
      if (!w || !("version" in w)) return void again();
      disk = { bytes: c.bytes, version: w.version };
      conflict = null;
      core.resume();
      say("KEPT THE TV'S; THE OTHER IS BACKED UP");
      return;
    }
    const [backed, now] = await Promise.all([files.backUp(entry.path, c.bytes), files.save(entry.path)]);
    if (left()) return;
    if (!backed || !now) return void again();
    conflict = null;
    disk = now;
    releaseAll();
    if (tvScreen.get() === core.picture) tvScreen.set(null);
    core.exit();
    emu = null;
    phase = "loading";
    await boot(now.bytes, null);
    say("TOOK THE FOLDER'S; THE TV'S IS BACKED UP");
  };

  const releaseAll = () => {
    for (const b of down) emu?.pressUp(b);
    down.clear();
  };

  const game: EmulatorGame = {
    w: sys.w,
    h: sys.h,
    get phase() {
      return phase;
    },
    get done() {
      return done;
    },
    get keepsBack() {
      return phase === "running";
    },
    get asking() {
      return !!conflict;
    },
    ready,
    closed: Promise.resolve(),
    step(pad: Pad) {
      t++;
      if (note && t >= note.until) note = null;
      if (phase !== "running" || !emu || done) return;
      if (conflict) {
        if (conflict.busy) return;
        // Buttons held as it asked count only once let go.
        // A, or Start (Enter) as in the console's menus, keeps the TV's.
        const yes = pad.a || pad.start;
        const was = conflict.held;
        conflict.held = { a: yes, b: pad.b };
        if (!was) {
          releaseAll();
          return;
        }
        if (yes && !was.a) void settle(true);
        else if (pad.b && !was.b) void settle(false);
        return;
      }
      if (t % SAVE_EVERY === 0 && disk && !syncing) void look(emu);
      const held = new Set(pad.retro);
      stale ??= new Set(held);
      for (const b of stale) if (!held.has(b)) stale.delete(b);
      if (held.has("select") && held.has("start")) {
        done = true;
        releaseAll();
        return;
      }
      for (const b of held) {
        if (!down.has(b) && !stale.has(b)) {
          emu.pressDown(b);
          down.add(b);
        }
      }
      for (const b of down) {
        if (!held.has(b)) {
          emu.pressUp(b);
          down.delete(b);
        }
      }
    },
    draw(ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, sys.w, sys.h);
      if (phase === "running" && emu) ctx.drawImage(emu.picture, 0, 0, sys.w, sys.h);
      else {
        const lines =
          phase === "failed" ? [why, entry.title.toUpperCase(), "", "BACK: TO THE LIBRARY"] : [Math.floor(t / 20) % 2 ? "LOADING" : "LOADING…", entry.title.toUpperCase(), sys.name];
        drawLines(ctx, lines, phase === "failed" ? "#ff8a3d" : "#ffcf3f");
      }
      if (conflict) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
        ctx.fillRect(0, 0, sys.w, sys.h);
        drawLines(ctx, ["THE SAVE CHANGED IN THE FOLDER", "WHILE YOU PLAYED HERE", "", "A: KEEP THE TV'S", "B: TAKE THE FOLDER'S", "", "THE OTHER IS BACKED UP"], "#ffcf3f");
      }
      if (note) {
        const b = text(note.text, "#ffcf3f");
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(4, 4, b.width + 6, b.height + 6);
        ctx.drawImage(b, 7, 7);
      }
    },
    stop() {
      const was = phase;
      phase = "closed";
      const running = emu;
      emu = null;
      if (tvScreen.get() === running?.picture) tvScreen.set(null);
      if (was !== "running" || !running) return;
      for (const b of down) running.pressUp(b);
      down.clear();
      // Keeps the save and where it was, then stops the core whether or not that worked.
      const wait = new Promise<void>((r) => setTimeout(r, SAVE_WAIT_MS));
      const kept = (async () => {
        const asked = conflict;
        if (asked) await files.backUp(entry.path, asked.bytes);
        else await look(running, true);
        const state = await running.saveState();
        // Kept with a save other than the folder's, it isn't resumed over that one.
        await files.keep(entry.path, state, asked ? "tv" : (disk?.version ?? ""));
      })().catch(() => undefined);
      game.closed = Promise.race([kept, wait]).then(() => running.exit());
    },
  };

  function drawLines(ctx: CanvasRenderingContext2D, lines: string[], first: string) {
    const top = Math.round(sys.h / 2 - (lines.length * 10) / 2);
    lines.forEach((line, n) => {
      if (!line) return;
      const b = text(line, n === 0 ? first : "#a39bb4");
      const w = Math.min(b.width, sys.w - 8);
      ctx.drawImage(b, Math.round((sys.w - w) / 2), top + n * 10, w, b.height);
    });
  }
  return game;
}
