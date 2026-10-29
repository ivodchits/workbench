// RetroArch in the page (office plan O5.3d), through Nostalgist.js; the core itself is
// fetched only when a game starts. (Imported statically: the page is one file anyway,
// and Vite's dynamic import breaks in it.) Its canvas sits off screen at the system's
// own size: the overlay and the TV copy its picture (a WebGL context made first,
// keeping its drawing, lets them). The pad reaches the core as RetroArch's keys
// (`pressDown`/`pressUp`); RetroArch reads no keys of its own, nor gamepads. The in-game
// save (O5.3e) goes in as Nostalgist's `sram` and comes out of RetroArch's own file,
// flushed when asked. A disc's tracks (O5.3f) are files in RetroArch's own file system
// whose reads go to the listener a piece at a time.

import { Nostalgist } from "nostalgist";

import type { Part } from "./disc";
import type { Emu, Launch } from "./emulator";

/** RetroArch's settings beyond Nostalgist's: square pixels filling the canvas, and no
 *  input but what the pad sends. The keys are RetroArch's own, which `pressDown`
 *  names; L2, R2, L3 and R3 get some, since its defaults have none. Loading a save
 *  state leaves the in-game save as it is (the folder's may be newer). */
const CONFIG = {
  block_sram_overwrite: true,
  input_joypad_driver: "null",
  aspect_ratio_index: 21,
  video_scale_integer: false,
  video_smooth: false,
  savestate_thumbnail_enable: false,
  input_player1_l2: "e",
  input_player1_r2: "r",
  input_player1_l3: "t",
  input_player1_r3: "y",
};

/** Where Nostalgist's RetroArch keeps its files, the saves under it by core, and the
 *  game's files. */
const SAVES_DIR = "/home/web_user/retroarch/userdata/saves";
const CONTENT_DIR = "/home/web_user/retroarch/userdata/content";

/** The file reads of Emscripten's in-memory file system. */
interface StreamOps {
  read(stream: unknown, buffer: Int8Array, offset: number, length: number, position: number): number;
  mmap(...args: unknown[]): unknown;
}

interface Fs {
  readdir(path: string): string[];
  analyzePath(path: string): { exists: boolean };
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
  lookupPath(path: string): { node: { usedBytes: number; stream_ops: StreamOps } };
  ErrnoError: new (errno: number) => Error;
}

/** Emscripten's EIO and ENODEV. */
const EIO = 29;
const ENODEV = 43;

/** Puts `part` in `dir` as a file whose reads go to it, never held whole. */
function lazyFile(fs: Fs, dir: string, part: Part): void {
  const path = `${dir}/${part.name}`;
  if (fs.analyzePath(path).exists) fs.unlink(path);
  fs.writeFile(path, new Uint8Array(0));
  const { node } = fs.lookupPath(path);
  node.usedBytes = part.size;
  node.stream_ops = {
    ...node.stream_ops,
    read(_stream, buffer, offset, length, position) {
      const n = Math.max(0, Math.min(part.size - position, length));
      if (n === 0) return 0;
      let bytes: Uint8Array;
      try {
        bytes = part.read(position, position + n);
      } catch (e) {
        console.warn("[library] a disc read failed:", e);
        throw new fs.ErrnoError(EIO);
      }
      buffer.set(bytes, offset);
      return n;
    },
    mmap() {
      throw new fs.ErrnoError(ENODEV);
    },
  };
}

/** The file named `name` in `dir` or a folder in it. */
function findIn(fs: Fs, dir: string, name: string): string | null {
  if (!fs.analyzePath(dir).exists) return null;
  if (fs.analyzePath(`${dir}/${name}`).exists) return `${dir}/${name}`;
  for (const sub of fs.readdir(dir)) {
    if (sub === "." || sub === "..") continue;
    const p = `${dir}/${sub}/${name}`;
    if (fs.analyzePath(p).exists) return p;
  }
  return null;
}

const frame = () => new Promise((r) => requestAnimationFrame(r));

export const launchRetroArch: Launch = async ({ core, rom, bios, save, w, h }) => {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  Object.assign(canvas.style, { position: "fixed", left: "-10000px", top: "0", width: `${w}px`, height: `${h}px`, display: "block" });
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  canvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: false });
  // Keys go to the overlay, never to RetroArch straight.
  canvas.addEventListener("focus", () => canvas.blur());
  try {
    const n = await Nostalgist.launch({
      element: canvas,
      size: { width: w, height: h },
      respondToGlobalEvents: false,
      core: { name: core.name, js: core.js, wasm: core.wasm },
      rom: { fileName: rom.name, fileContent: rom.bytes },
      ...(bios ? { bios: { fileName: bios.name, fileContent: bios.bytes } } : {}),
      ...(save ? { sram: new Blob([save as BlobPart]) } : {}),
      beforeLaunch(n) {
        // The disc's tracks, over the empty stand-in for a big first file.
        for (const part of rom.parts ?? []) lazyFile(n.getEmscriptenFS() as unknown as Fs, CONTENT_DIR, part);
      },
      retroarchConfig: CONFIG,
    });
    canvas.blur();
    const fs = n.getEmscriptenFS() as Fs;
    const module = n.getEmscriptenModule() as unknown as { _cmd_savefiles?: () => void };
    const srm = `${rom.name.replace(/\.[^.]*$/, "")}.srm`;
    const emu: Emu = {
      picture: canvas,
      pressDown: (b) => n.pressDown(b),
      pressUp: (b) => n.pressUp(b),
      saveState: async () => (await n.saveState()).state,
      loadState: (state) => n.loadState(state),
      async readSave() {
        // RetroArch writes the core's save to its file when told; a game without one
        // has none.
        module._cmd_savefiles?.();
        for (let tries = 0; tries < 3; tries++) {
          const file = findIn(fs, SAVES_DIR, srm);
          if (file) return fs.readFile(file).slice();
          await frame();
        }
        return null;
      },
      pause: () => n.pause(),
      resume: () => n.resume(),
      exit: () => n.exit(),
    };
    return emu;
  } catch (e) {
    canvas.remove();
    throw e;
  }
};
