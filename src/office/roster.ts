// The company (office plan OD.2): twelve workers in three teams. The team is home —
// the room they sit in when they have no session — and the personality line feeds
// what they do when idle and what they talk about.

import type { Look } from "./art/characters";
import { CLOTH, GEAR, HAIR, PANTS, SHOES, SKIN } from "./art/palette";

export type Team = "demiurge" | "tinywizard" | "open";

export interface Worker {
  id: string;
  name: string;
  team: Team;
  personality: string;
  look: Look;
}

export const TEAM_NAMES: Record<Team, string> = {
  demiurge: "Demiurge",
  tinywizard: "TinyWizardRoyale",
  open: "Open space",
};

export const ROSTER: readonly Worker[] = [
  {
    id: "mira",
    name: "Mira",
    team: "open",
    personality: "Methodical. Reads the whole file before touching a line.",
    look: {
      skin: SKIN.light,
      hair: HAIR.ginger,
      hairStyle: "long",
      top: CLOTH.teal,
      topStyle: "tee",
      pants: PANTS.denim,
      shoes: SHOES.dark,
      glasses: true,
      blush: true,
    },
  },
  {
    id: "bram",
    name: "Bram",
    team: "demiurge",
    personality: "Big-picture type. Draws architecture diagrams on every surface.",
    look: {
      skin: SKIN.medium,
      hair: HAIR.brown,
      hairStyle: "short",
      top: CLOTH.navy,
      topStyle: "hoodie",
      pants: PANTS.charcoal,
      shoes: SHOES.white,
      beard: true,
    },
  },
  {
    id: "oksana",
    name: "Oksana",
    team: "open",
    personality: "Fast and fearless. Ships first, refactors after lunch.",
    look: {
      skin: SKIN.pale,
      hair: HAIR.platinum,
      hairStyle: "ponytail",
      top: CLOTH.purple,
      topStyle: "collar",
      pants: PANTS.black,
      shoes: SHOES.black,
      blush: true,
    },
  },
  {
    id: "theo",
    name: "Theo",
    team: "demiurge",
    personality: "Lives in headphones. Hums while debugging.",
    look: {
      skin: SKIN.brown,
      hair: HAIR.black,
      hairStyle: "curly",
      top: CLOTH.orange,
      topStyle: "tee",
      pants: PANTS.khaki,
      shoes: SHOES.white,
      headphones: GEAR.red,
    },
  },
  {
    id: "pip",
    name: "Pip",
    team: "tinywizard",
    personality: "Tiny wizard energy. Names every variable after a spell.",
    look: {
      skin: SKIN.light,
      hair: HAIR.pink,
      hairStyle: "bob",
      top: CLOTH.yellow,
      topStyle: "stripes",
      pants: PANTS.denim,
      shoes: SHOES.tan,
      blush: true,
    },
  },
  {
    id: "juno",
    name: "Juno",
    team: "tinywizard",
    personality: "Balance-patch philosopher. Has an opinion on every stat.",
    look: {
      skin: SKIN.tan,
      hair: HAIR.blue,
      hairStyle: "short",
      top: CLOTH.green,
      topStyle: "hoodie",
      pants: PANTS.charcoal,
      shoes: SHOES.black,
      glasses: true,
    },
  },
  {
    id: "felix",
    name: "Felix",
    team: "demiurge",
    personality: "Jack of all trades. First to the coffee machine every morning.",
    look: {
      skin: SKIN.light,
      hair: HAIR.blonde,
      hairStyle: "short",
      top: CLOTH.red,
      topStyle: "tee",
      pants: PANTS.denim,
      shoes: SHOES.white,
    },
  },
  {
    id: "ada",
    name: "Ada",
    team: "open",
    personality: "Writes tests for the tests. Keeps the kitchen rota.",
    look: {
      skin: SKIN.deep,
      hair: HAIR.black,
      hairStyle: "bob",
      top: CLOTH.white,
      topStyle: "collar",
      pants: PANTS.charcoal,
      shoes: SHOES.black,
      glasses: true,
    },
  },
  {
    id: "kenji",
    name: "Kenji",
    team: "demiurge",
    personality: "Quiet. Holds the lounge console high score.",
    look: {
      skin: SKIN.medium,
      hair: HAIR.black,
      hairStyle: "short",
      top: CLOTH.black,
      topStyle: "tee",
      pants: PANTS.khaki,
      shoes: SHOES.white,
      headphones: GEAR.white,
    },
  },
  {
    id: "lola",
    name: "Lola",
    team: "open",
    personality: "The office social hub. Knows everyone's business.",
    look: {
      skin: SKIN.tan,
      hair: HAIR.brown,
      hairStyle: "long",
      top: CLOTH.pink,
      topStyle: "tee",
      pants: PANTS.denim,
      shoes: SHOES.tan,
      blush: true,
    },
  },
  {
    id: "gus",
    name: "Gus",
    team: "open",
    personality: "Veteran. Remembers when everything was Perl.",
    look: {
      skin: SKIN.pale,
      hair: HAIR.gray,
      hairStyle: "buzz",
      top: CLOTH.mustard,
      topStyle: "stripes",
      pants: PANTS.brown,
      shoes: SHOES.dark,
      beard: true,
      glasses: true,
    },
  },
  {
    id: "rhea",
    name: "Rhea",
    team: "open",
    personality: "Night owl. Does the best work after midnight.",
    look: {
      skin: SKIN.brown,
      hair: HAIR.auburn,
      hairStyle: "curly",
      top: CLOTH.blue,
      topStyle: "collar",
      pants: PANTS.black,
      shoes: SHOES.dark,
    },
  },
];
