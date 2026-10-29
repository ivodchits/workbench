// The props that open a game (office plan O5.1): the lounge's TV and kicker, and the
// meeting room's whiteboard (Pictionary, O5.4).

import type { OfficeMap } from "../map/build";

export type GameProp = "tv" | "kicker" | "whiteboard";

/** Each game prop by its placed prop's id. */
const BY_ID: Readonly<Record<string, GameProp>> = { tvOn: "tv", kicker: "kicker", whiteboardStand: "whiteboard" };

/** The game prop at (x, y) in office pixels, if any. */
export function gamePropAt(office: OfficeMap, x: number, y: number): GameProp | null {
  for (const p of office.props) {
    const game = BY_ID[p.id];
    if (game && x >= p.x && x < p.x + p.prop.w && y >= p.y && y < p.y + p.prop.h) return game;
  }
  return null;
}
