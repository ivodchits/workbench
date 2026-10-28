// The TV console's own games (office plan O5.3a), in menu order. A new game is a module
// that makes a `Game` and one entry here.

import { testGame } from "../game";
import { starRun } from "../starrun/draw";
import type { Cartridge } from "./console";

const padTest = testGame("Pad test", "#7fd1ff");

export const CARTRIDGES: readonly Cartridge[] = [
  {
    id: "star-run",
    title: "Star run",
    label: ["#ff8a3d", "#15131b"],
    help: "arrows or WASD, or a gamepad: fly · hold Z/Space or A: fire · hold X/Shift or B: slow · Enter or Start: pause",
    scored: true,
    make: (best) => starRun(best),
  },
  {
    id: "pad-test",
    title: "Pad test",
    label: ["#7fd1ff", "#15131b"],
    help: "arrows or WASD, or a gamepad: steer · Z or A: light · X or B: faster",
    make: padTest.make,
  },
];
