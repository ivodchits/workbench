// The Library's games as the listener has them (office plan O5.3d,
// `src-tauri/src/remote/office/library.rs`): the folder you chose and what's in it,
// each game's image, its core, and its save state.

import type { Link } from "../../net";
import { isSystem, type SystemId } from "./systems";

export interface LibraryEntry {
  /** Under the folder, `/` between parts; the game's name to the listener. */
  path: string;
  title: string;
  system: SystemId;
  /** Bytes; 0 for an empty file (a cloud copy that never uploaded). */
  size: number;
  /** A save state is kept for it: it resumes. */
  state: boolean;
}

export interface Listing {
  /** The folder chosen; null before one is. */
  folder: string | null;
  games: LibraryEntry[];
  /** The folder is gone (a drive not mounted). */
  missing?: boolean;
}

/** What the emulator needs from the listener. */
export interface Files {
  core(name: string): Promise<{ js: Blob; wasm: Blob } | null>;
  rom(path: string): Promise<{ name: string; bytes: Blob } | null>;
  state(path: string): Promise<Blob | null>;
  /** Keeps a save state; false when it wasn't kept. */
  keep(path: string, state: Blob): Promise<boolean>;
}

export interface Shelf extends Files {
  list(): Promise<Listing | null>;
  /** Asks for a folder, in a dialog on the PC; the listing after. */
  choose(): Promise<Listing | null>;
}

type Request = Link["request"];

/** `v` as a listing, dropping anything not a game of a known system. */
export function readListing(v: unknown): Listing | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const games = Array.isArray(o.games) ? o.games : [];
  return {
    folder: typeof o.folder === "string" ? o.folder : null,
    missing: o.missing === true,
    games: games.flatMap((g: Record<string, unknown>) =>
      g && typeof g.path === "string" && typeof g.title === "string" && isSystem(g.system)
        ? [{ path: g.path, title: g.title, system: g.system, size: Number(g.size) || 0, state: g.state === true }]
        : [],
    ),
  };
}

export function linkShelf(request: Request): Shelf {
  const json = async (path: string, init?: RequestInit) => {
    const res = await request(path, init);
    return res?.ok ? readListing(await res.json().catch(() => null)) : null;
  };
  const blob = async (path: string) => {
    const res = await request(path);
    return res?.ok ? { res, blob: await res.blob() } : null;
  };
  const q = (path: string) => `?path=${encodeURIComponent(path)}`;
  return {
    list: () => json("library"),
    choose: () => json("library/folder", { method: "POST" }),
    async core(name) {
      const [js, wasm] = await Promise.all([blob(`core/${name}/js`), blob(`core/${name}/wasm`)]);
      return js && wasm ? { js: js.blob, wasm: wasm.blob } : null;
    },
    async rom(path) {
      const got = await blob(`library/rom${q(path)}`);
      if (!got) return null;
      const name = got.res.headers.get("x-rom-name");
      return { name: name ? decodeURIComponent(name) : (path.split("/").pop() ?? "game"), bytes: got.blob };
    },
    async state(path) {
      return (await blob(`library/state${q(path)}`))?.blob ?? null;
    },
    async keep(path, state) {
      const res = await request(`library/state${q(path)}`, { method: "PUT", body: state });
      return !!res?.ok;
    },
  };
}
