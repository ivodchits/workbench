// Duck's notification badge: the unread count on the taskbar icon, a dot on the tray.
//
// The count is what the Duck button already shows (`duckState`): replies unread in
// any thread, plus tool calls waiting for your confirmation. It falls to 0 as threads
// are opened or `clearUnread` runs, which clears both marks. The host side (drawing
// the overlay, setting the tray) is `duckBadgeHost.ts`.

import type { DuckState } from "../panels/Assistant/duckState";

/** Duck notifications waiting for you. */
export function duckBadgeCount(d: Pick<DuckState, "unread" | "asks">): number {
  const unread = Object.values(d.unread).reduce((n, x) => n + x, 0);
  return unread + d.asks.length;
}

/** The overlay's text: the number, capped at "9+"; null when there is nothing. */
export function badgeLabel(count: number): string | null {
  if (!(count > 0)) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}
