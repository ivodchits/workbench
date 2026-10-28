// RetroArch in the page (office plan O5.3d), through Nostalgist.js; the core itself is
// fetched only when a game starts. (Imported statically: the page is one file anyway,
// and Vite's dynamic import breaks in it.) Its canvas sits off screen at the system's
// own size: the overlay and the TV copy its picture (a WebGL context made first,
// keeping its drawing, lets them). The pad reaches the core as RetroArch's keys
// (`pressDown`/`pressUp`); RetroArch reads no keys of its own, nor gamepads.

import { Nostalgist } from "nostalgist";

import type { Emu, Launch } from "./emulator";

/** RetroArch's settings beyond Nostalgist's: square pixels filling the canvas, and no
 *  input but what the pad sends. The keys are RetroArch's own, which `pressDown`
 *  names; L2, R2, L3 and R3 get some, since its defaults have none. */
const CONFIG = {
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

export const launchRetroArch: Launch = async ({ core, rom, w, h }) => {
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
      retroarchConfig: CONFIG,
    });
    canvas.blur();
    const emu: Emu = {
      picture: canvas,
      pressDown: (b) => n.pressDown(b),
      pressUp: (b) => n.pressUp(b),
      saveState: async () => (await n.saveState()).state,
      loadState: (state) => n.loadState(state),
      exit: () => n.exit(),
    };
    return emu;
  } catch (e) {
    canvas.remove();
    throw e;
  }
};
