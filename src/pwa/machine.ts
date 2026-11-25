// Which machine's sessions the page shows (fleet plan F2.2). With several Workbench
// machines the page stays on the one it opened from, and that machine relays the
// session routes to the one picked (`/m/<id>/…`, `remote/relay.rs`). Duck isn't
// picked: there's one, at the main, and every machine relays to it.
//
// The pick is remembered per address. Without one, the main is shown. The list
// comes from `/api/fleet` (`fleetList.ts`), kept here by `net.ts` on every connect.

import { parseFleet, type FleetInstance, type PhoneFleet } from "./fleetList";

/** Where the page keeps the fleet's list (per address). */
export const FLEET_KEY = "wb-fleet";
const PICK_KEY = "wb-machine";

/** The routes that belong to a machine's sessions (`relay::MACHINE_ROUTES`). */
const MACHINE_ROUTES = ["/api/ws", "/api/action", "/api/term", "/api/transcript", "/api/notes", "/api/session/", "/api/media"];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no storage: the pick lasts until the page reloads
  }
}

let fleet: PhoneFleet | null = parseFleet(read(FLEET_KEY));
let pick: string | null = read(PICK_KEY);
const listeners = new Set<() => void>();

/** Call `cb` on every fresh list. */
export function onFleet(cb: () => void): void {
  listeners.add(cb);
}

/** The fleet's machines, as last heard; null before the first list. */
export function machines(): PhoneFleet | null {
  return fleet;
}

/** The machine shown: its id, or null for the one the page is on. A pick (or the
 *  main) that's no longer in the fleet counts as none. */
export function shownMachine(f: PhoneFleet | null = fleet, picked: string | null = pick): string | null {
  if (!f?.here) return null;
  const want = picked ?? f.main;
  if (!want || want === f.here) return null;
  return f.instances.some((i) => i.id === want) ? want : null;
}

/** `path` as the page sends it: a session route goes to the machine shown. */
export function routed(path: string, shown: string | null = shownMachine()): string {
  if (!shown || !MACHINE_ROUTES.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"))) {
    return path;
  }
  return `/m/${encodeURIComponent(shown)}${path}`;
}

/** A fresh list from the machine the page is on. True when the machine shown
 *  changed with it (the main moved, say). */
export function noteFleet(text: string): boolean {
  const next = parseFleet(text);
  if (!next) return false;
  const before = shownMachine();
  fleet = next;
  write(FLEET_KEY, text);
  for (const l of listeners) l();
  return shownMachine() !== before;
}

/** Show machine `id` from now on (the page reloads to show it). */
export function pickMachine(id: string): void {
  pick = id;
  write(PICK_KEY, id);
}

/** What the picker lists: every machine, the one shown marked. */
export function pickerItems(f: PhoneFleet | null = fleet): (FleetInstance & { shown: boolean })[] {
  if (!f?.here) return [];
  const shown = shownMachine(f) ?? f.here;
  return f.instances.map((i) => ({ ...i, shown: i.id === shown }));
}

/** The machine shown is Duck's (the main), so its snapshot's Duck threads are the
 *  phone's Duck's. Without a fleet, always. */
export function showsDuck(f: PhoneFleet | null = fleet, picked: string | null = pick): boolean {
  if (!f?.here || !f.main) return true;
  return (shownMachine(f, picked) ?? f.here) === f.main;
}

/** A key that differs per machine shown, for what's kept of its sessions. */
export function machineSuffix(): string {
  const m = shownMachine();
  return m ? `@${m}` : "";
}
