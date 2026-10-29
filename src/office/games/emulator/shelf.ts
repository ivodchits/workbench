// The Library's games as the listener has them (office plan O5.3d,
// `src-tauri/src/remote/office/library.rs`): the folder you chose and what's in it,
// each game's image, its core, and its save state; and its in-game save, which is
// RetroArch's (O5.3e, `saves.rs`). A disc (O5.3f, `disc.rs`) comes as its small files
// whole and its tracks to be read in pieces.

import type { Link } from "../../net";
import { lazyPart, type Part, rangeReader } from "./disc";
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
  /** Where in-game saves go. */
  saves?: SavesPlace;
}

export interface SavesPlace {
  /** The folder; null when they go beside each game. */
  folder: string | null;
  /** Found in RetroArch's config, chosen by hand, or the office's own for want of one. */
  from: "retroarch" | "hand" | "office";
}

/** An in-game save as it is on disk: its bytes (null for none yet) and its version. */
export interface Save {
  bytes: Uint8Array | null;
  version: string;
}

/** A save written, its version now; or not, the file having changed to `changed`. */
export type Written = { version: string } | { changed: string };

/** A game's image as the core is given it: the file it opens, and for a disc the
 *  tracks beside it, read as it goes (the file it opens among them when that's big,
 *  `bytes` being empty then). */
export interface Rom {
  name: string;
  bytes: Blob;
  parts?: Part[];
}

/** A disc's files up to this size come whole (a `.cue`). */
const WHOLE_MAX = 1024 * 1024;

/** What the emulator needs from the listener. */
export interface Files {
  core(name: string): Promise<{ js: Blob; wasm: Blob } | null>;
  rom(path: string): Promise<Rom | null>;
  /** A disc's files; null when they can't be read. */
  disc(path: string): Promise<Rom | null>;
  /** The PlayStation's BIOS; null for none (the core has a stand-in). */
  bios(): Promise<{ name: string; bytes: Blob } | null>;
  /** The save state, and the in-game save's version it was kept with ("" unknown). */
  state(path: string): Promise<{ state: Blob; save: string } | null>;
  /** Keeps a save state, noting the in-game save's version; false when it wasn't kept. */
  keep(path: string, state: Blob, save: string): Promise<boolean>;
  /** The in-game save; null when saves can't be reached. */
  save(path: string): Promise<Save | null>;
  /** Writes the in-game save over version `base` only, unless `force` (keeping the
   *  copy on disk as a backup); null when it couldn't be written. */
  write(path: string, bytes: Uint8Array, base: string, force?: boolean): Promise<Written | null>;
  /** Keeps the TV's copy as a backup, the one on disk being taken instead. */
  backUp(path: string, bytes: Uint8Array): Promise<boolean>;
}

export interface Shelf extends Files {
  list(): Promise<Listing | null>;
  /** Asks for a folder, in a dialog on the PC; the listing after. */
  choose(): Promise<Listing | null>;
  /** Asks for the saves folder the same way. */
  chooseSaves(): Promise<Listing | null>;
}

type Request = Link["request"];
type Signed = Link["signed"];

/** `v` as a listing, dropping anything not a game of a known system. */
export function readListing(v: unknown): Listing | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const games = Array.isArray(o.games) ? o.games : [];
  const saves = o.saves as Record<string, unknown> | null | undefined;
  const from = saves?.from;
  return {
    folder: typeof o.folder === "string" ? o.folder : null,
    missing: o.missing === true,
    ...(from === "retroarch" || from === "hand" || from === "office"
      ? { saves: { folder: typeof saves!.folder === "string" ? saves!.folder : null, from } }
      : {}),
    games: games.flatMap((g: Record<string, unknown>) =>
      g && typeof g.path === "string" && typeof g.title === "string" && isSystem(g.system)
        ? [{ path: g.path, title: g.title, system: g.system, size: Number(g.size) || 0, state: g.state === true }]
        : [],
    ),
  };
}

export function linkShelf(request: Request, signed: Signed): Shelf {
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
    chooseSaves: () => json("library/saves", { method: "POST" }),
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
    async disc(path) {
      const res = await request(`library/disc${q(path)}`);
      const listed = res?.ok ? ((await res.json().catch(() => null)) as { files?: unknown } | null) : null;
      const files = (Array.isArray(listed?.files) ? (listed.files as { name?: unknown; size?: unknown }[]) : []).filter(
        (f): f is { name: string; size: number } => typeof f?.name === "string" && typeof f.size === "number",
      );
      if (!files.length) return null;
      const part = (name: string) => `library/disc/part${q(path)}&file=${encodeURIComponent(name)}`;
      const [first, ...rest] = files;
      const whole = first.size <= WHOLE_MAX;
      const parts: Part[] = [];
      for (const f of whole ? rest : files) {
        const to = signed(part(f.name));
        if (!to) return null;
        parts.push(lazyPart(f.name, f.size, rangeReader(to.url, to.headers)));
      }
      if (!whole) return { name: first.name, bytes: new Blob([]), parts };
      const got = await blob(part(first.name));
      return got && { name: first.name, bytes: got.blob, parts };
    },
    async bios() {
      const got = await blob("library/bios");
      const name = got?.res.headers.get("x-bios-name");
      return got && name ? { name, bytes: got.blob } : null;
    },
    async state(path) {
      const got = await blob(`library/state${q(path)}`);
      return got && { state: got.blob, save: got.res.headers.get("x-save-version") ?? "" };
    },
    async keep(path, state, save) {
      const res = await request(`library/state${q(path)}`, { method: "PUT", body: state, headers: { "x-save-version": save } });
      return !!res?.ok;
    },
    async save(path) {
      const res = await request(`library/save${q(path)}`);
      const version = res?.ok ? res.headers.get("x-save-version") : null;
      if (!res || !version) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes: version === "none" ? null : bytes, version };
    },
    async write(path, bytes, base, force = false) {
      const headers: Record<string, string> = { "x-save-base": base };
      if (force) headers["x-save-force"] = "1";
      const res = await request(`library/save${q(path)}`, { method: "PUT", body: bytes, headers });
      const version = res?.headers.get("x-save-version");
      if (!res || !version) return null;
      return res.ok ? { version } : res.status === 409 ? { changed: version } : null;
    },
    async backUp(path, bytes) {
      const res = await request(`library/save/backup${q(path)}`, { method: "PUT", body: bytes });
      return !!res?.ok;
    },
  };
}
