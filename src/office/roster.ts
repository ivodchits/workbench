// The company (office plan OD.2): twelve workers in three teams. The team is home —
// the room they sit in when they have no session — and the personality line feeds
// what they talk about; `likes` is what they'd rather do when idle.

import type { Look } from "./art/characters";
import { CLOTH, GEAR, HAIR, PANTS, SHOES, SKIN } from "./art/palette";

export type Team = "demiurge" | "tinywizard" | "open";

export interface Worker {
  id: string;
  name: string;
  team: Team;
  personality: string;
  /** Idle activities they're likelier to pick (`world/idle.ts`). */
  likes: readonly string[];
  look: Look;
  /** Not staff: who they are instead of a team ("visiting"). A guest has no desk and
   *  never takes a session, but walks about, joins the chats and does as idle workers do. */
  guest?: string;
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
    likes: ["books", "window"],
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
    likes: ["doodle", "books"],
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
    likes: ["cooler", "kicker"],
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
    likes: ["window", "sofa"],
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
    likes: ["books", "beanbag"],
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
    likes: ["cooler", "doodle"],
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
    likes: ["coffee", "snack"],
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
    likes: ["dishes", "plants"],
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
    likes: ["sofa", "kicker"],
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
    likes: ["cooler", "stroll"],
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
    likes: ["plants", "books"],
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
    likes: ["desk", "window"],
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

/** Anya's id: she drops by. */
export const ANYA_ID = "anya";

/** People about the office who don't work there: no desk, no sessions, not in the
 *  standup. Clicking one sends up a heart. */
export const GUESTS: readonly Worker[] = [
  {
    id: ANYA_ID,
    name: "Anya",
    team: "open",
    guest: "visiting",
    personality: "Not on any team, just visiting. Cute and cheerful, and an artist at heart: sees everything by how it looks and feels. Asks about projects and people's work for the colours, the shapes and the mood, never how it works under the hood.",
    likes: ["cooler", "sofa", "lie", "plants"],
    look: {
      skin: SKIN.light,
      hair: HAIR.honey,
      hairStyle: "long",
      top: CLOTH.silk,
      topStyle: "tee",
      pants: PANTS.denim,
      shoes: SHOES.sandal,
      blush: true,
      dress: CLOTH.lace,
    },
  },
];

/** Everyone who walks about the office: the staff, then the guests. */
export const PEOPLE: readonly Worker[] = [...ROSTER, ...GUESTS];

export const isGuest = (id: string): boolean => GUESTS.some((g) => g.id === id);
