// The TV console's own games (office plan O5.3a), in menu order. A new game is a module
// that makes a `Game` and one entry here.

import { testGame } from "../game";
import type { Cartridge } from "./console";

const padTest = testGame("Pad test", "#7fd1ff");

export const CARTRIDGES: readonly Cartridge[] = [
  {
    id: "pad-test",
    title: "Pad test",
    label: ["#7fd1ff", "#15131b"],
    help: "arrows or WASD, or a gamepad: steer · Z or A: light · X or B: faster",
    make: padTest.make,
  },
];
