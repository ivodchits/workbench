// The systems the TV's Library plays (office plan O5.3d), each through one libretro
// core — the one RetroArch uses on every device, so in-game saves carry over (O5.3e).
// A system's picture is its widest usual mode; the overlay scales it by whole pixels.

export type SystemId = "md" | "nes" | "snes" | "gb" | "gba";

export interface System {
  /** As the Library shows it. */
  name: string;
  /** The core, by the name Nostalgist and the listener know it by. */
  core: string;
  w: number;
  h: number;
}

export const SYSTEMS: Readonly<Record<SystemId, System>> = {
  md: { name: "MEGA DRIVE", core: "genesis_plus_gx", w: 320, h: 224 },
  nes: { name: "NES", core: "fceumm", w: 256, h: 240 },
  snes: { name: "SNES", core: "snes9x", w: 256, h: 224 },
  gb: { name: "GAME BOY", core: "gambatte", w: 160, h: 144 },
  gba: { name: "GBA", core: "mgba", w: 240, h: 160 },
};

export const isSystem = (id: unknown): id is SystemId => typeof id === "string" && Object.prototype.hasOwnProperty.call(SYSTEMS, id);
