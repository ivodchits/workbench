// A game from the TV's Library (office plan O5.3d), played by a libretro core: it
// fetches the core, the image and the save state, starts the core, and from then on
// hands the pad's RetroPad buttons to it and copies its picture. Leaving keeps a save
// state, so the game resumes where it was (`fresh` starts it over). Back on a gamepad
// is the game's Select; Back with Start, or Esc, leaves.

import { textBitmap } from "../../art/font";
import { cached } from "../../canvas";
import type { Game } from "../game";
import type { Pad, RetroButton } from "../pad";
import { tvScreen } from "./screen";
import type { Files, LibraryEntry } from "./shelf";
import { SYSTEMS } from "./systems";

/** A running core, as the game uses it. */
export interface Emu {
  /** Its picture, at the system's size. */
  picture: CanvasImageSource;
  pressDown(button: RetroButton): void;
  pressUp(button: RetroButton): void;
  saveState(): Promise<Blob>;
  loadState(state: Blob): Promise<void>;
  /** Stops the core and lets its memory go. */
  exit(): void;
}

export type Launch = (opts: {
  core: { name: string; js: Blob; wasm: Blob };
  rom: { name: string; bytes: Blob };
  w: number;
  h: number;
}) => Promise<Emu>;

export type EmuPhase = "loading" | "running" | "failed" | "closed";

/** How long a note over the picture shows ("resumed"). */
const NOTE_STEPS = 120;
/** How long leaving waits on the save state before stopping the core anyway. */
const SAVE_WAIT_MS = 4000;

export const EMULATOR_HELP =
  "arrows, Z X A S, Q W, Enter, right Shift, or a gamepad: the RetroPad · Back on a gamepad: Select";
export const EMULATOR_BACK = " · Esc or Back+Start: to the Library";

export interface EmulatorGame extends Game {
  readonly phase: EmuPhase;
  /** Back with Start was pressed: the console takes the game out. */
  readonly done: boolean;
  /** Gamepad Back is the game's (Select) while it runs. */
  readonly keepsBack: boolean;
  /** Settles once the core is running, or failed. */
  readonly ready: Promise<void>;
  /** Settles once leaving has kept the state and stopped the core. */
  closed: Promise<void>;
}

const text = (s: string, color: string) => cached(`emu-text/${color}/${s}`, () => textBitmap(s, color));

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

  /** Left while it loaded (a check the compiler can't narrow away across awaits). */
  const left = () => phase === "closed";
  const fail = (message: string) => {
    phase = "failed";
    why = message;
  };

  const ready = (async () => {
    const [core, rom, state] = await Promise.all([
      files.core(sys.core),
      files.rom(entry.path),
      fresh || !entry.state ? null : files.state(entry.path),
    ]);
    if (left()) return;
    if (!core) return fail("THE CORE WOULDN'T LOAD");
    if (!rom || rom.bytes.size === 0) return fail(rom ? "THE FILE IS EMPTY" : "THE GAME COULDN'T BE READ");
    let started: Emu;
    try {
      started = await launch({ core: { name: sys.core, ...core }, rom, w: sys.w, h: sys.h });
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
        note = { text: "RESUMED", until: t + NOTE_STEPS };
      } catch {
        note = { text: "THE SAVE STATE WOULDN'T LOAD", until: t + NOTE_STEPS };
      }
    }
    if (left()) return;
    phase = "running";
    tvScreen.set(started.picture);
  })();

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
    ready,
    closed: Promise.resolve(),
    step(pad: Pad) {
      t++;
      if (note && t >= note.until) note = null;
      if (phase !== "running" || !emu || done) return;
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
        lines.forEach((line, n) => {
          if (!line) return;
          const b = text(line, n === 0 ? (phase === "failed" ? "#ff8a3d" : "#ffcf3f") : "#a39bb4");
          ctx.drawImage(b, Math.round((sys.w - Math.min(b.width, sys.w - 8)) / 2), Math.round(sys.h / 2 - 20 + n * 10), Math.min(b.width, sys.w - 8), b.height);
        });
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
      // Keeps where it was, then stops the core whether or not that worked.
      const wait = new Promise<void>((r) => setTimeout(r, SAVE_WAIT_MS));
      const kept = running
        .saveState()
        .then((state) => files.keep(entry.path, state))
        .then(() => undefined)
        .catch(() => undefined);
      game.closed = Promise.race([kept, wait]).then(() => running.exit());
    },
  };
  return game;
}
