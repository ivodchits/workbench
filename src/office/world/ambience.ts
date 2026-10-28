// Ambience (office plan O2.4): the sky in the windows through the day — night, dawn,
// day, dusk by the local clock. And the time it is: the real one, or, for checking how
// the office looks at noon or midnight, `?time=HH:MM` on the page's address. Pure but
// for reading that address once. Also what the coffee-budget whiteboard shows: how
// much of each usage window is used.

import type { RateLimits, RateWindow } from "../../ipc/usageLimits";
import type { Budget } from "./entities";

export type Sky = "night" | "dawn" | "day" | "dusk";

/** The sky at `hours` into the day (fractional: 18.5 is half past six). */
export function skyAt(hours: number): Sky {
  const h = ((hours % 24) + 24) % 24;
  if (h < 5.5 || h >= 19.5) return "night";
  if (h < 7.5) return "dawn";
  if (h < 17.5) return "day";
  return "dusk";
}

/** The window panes' colours for each sky: the sky itself, and its stars or clouds. */
export const SKY_COLORS: Record<Sky, { x: string; X: string }> = {
  night: { x: "#24305c", X: "#cfe3ff" },
  dawn: { x: "#e9a3a0", X: "#ffe0b8" },
  day: { x: "#8cc6f2", X: "#ffffff" },
  dusk: { x: "#d9734e", X: "#ffcf7a" },
};

let forced: { h: number; m: number } | null | undefined;

/** The time it is in the office: now, or what `?time=HH:MM` says. */
export function officeTime(): Date {
  if (forced === undefined) {
    const m = typeof location === "undefined" ? null : /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get("time") ?? "");
    forced = m ? { h: Number(m[1]) % 24, m: Number(m[2]) % 60 } : null;
  }
  const now = new Date();
  if (forced) now.setHours(forced.h, forced.m);
  return now;
}

/** Hours into the day, fractional. */
export const hoursOf = (d: Date) => d.getHours() + d.getMinutes() / 60;

/** The budget from the usage limits at `nowSec` (epoch seconds): a window past its
 *  reset is unused again. */
export function budgetOf(limits: RateLimits | null, nowSec: number): Budget {
  const used = (w: RateWindow | null | undefined) => (!w ? null : w.resetsAt <= nowSec ? 0 : Math.min(100, Math.max(0, w.usedPercentage)));
  return { fiveHour: used(limits?.fiveHour), sevenDay: used(limits?.sevenDay) };
}
