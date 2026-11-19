// The fleet's machines as the phone keeps them (fleet plan F2.1). Each Workbench
// machine has its own public address; the page asks the machine it's on for the
// list (`/api/fleet`) and keeps it, and Duck's app's loader opens whichever machine
// answers, the main first.
//
// Pure, so the order is unit-tested; the loader does the probing.

import { cleanAddress } from "./native";

/** One machine, as `/api/fleet` lists it. */
export interface FleetInstance {
  id: string;
  name: string;
  kind: string;
  /** Its public (Funnel) address; null while it has none. */
  url: string | null;
  online: boolean;
  main: boolean;
  here: boolean;
}

export interface PhoneFleet {
  here: string | null;
  main: string | null;
  pinned: boolean;
  /** In priority order. */
  instances: FleetInstance[];
}

/** What a kept list says, or null when it doesn't read. */
export function parseFleet(text: string | null): PhoneFleet | null {
  if (!text) return null;
  try {
    const f = JSON.parse(text) as PhoneFleet;
    return Array.isArray(f.instances) ? f : null;
  } catch {
    return null;
  }
}

/** The addresses to try, best first: the main, then the rest in priority order,
 *  then the address typed into the app if the list doesn't have it. Only what the
 *  app may open (https, `.ts.net`). */
export function candidates(saved: string | null, fleet: PhoneFleet | null): string[] {
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    const a = raw ? cleanAddress(raw) : null;
    if (a && !out.includes(a)) out.push(a);
  };
  const list = fleet?.instances ?? [];
  for (const i of list) if (i.main) add(i.url);
  for (const i of list) add(i.url);
  add(saved);
  return out;
}

/** The first address, in the order given, that `probe` says answers. All are asked
 *  at once, so the wait is the slowest probe at most, not their sum. */
export async function firstReachable(
  addresses: string[],
  probe: (address: string) => Promise<boolean>,
): Promise<string | null> {
  const answers = addresses.map((a) => probe(a).catch(() => false));
  for (let i = 0; i < addresses.length; i++) {
    if (await answers[i]) return addresses[i];
  }
  return null;
}
