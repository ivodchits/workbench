// Duck's prompts as data (step L3): the system prompt and the spoken-reply note are
// files in Duck's workspace, `config/system.md` and `config/voice.md`, which you can
// read and edit, and which Duck changes only through an approved diff
// (`propose_config_change`). The built-in texts in `prompt.ts` are the defaults.
//
// - A missing file is written with its default (the seed), so there's something to
//   read and edit. A file nobody has changed since its seed follows a new build's
//   default; an edited one is kept, and `current` says the default moved.
// - A file that's unusable (too short, too long, or without the safety rules
//   verbatim) is left on disk, and Duck uses the default and says why.
// - A thread is pinned on the prompts it starts with (`forThread`): its system
//   prompt stays byte-identical for its life, so its cached prefix holds, and a
//   change reaches the threads started after it. Threads from before L3 are pinned
//   at their next turn.

import { configPin, configPinned, configRead, configWrite, type ConfigFileRow } from "../ipc/config";
import { SYSTEM_PROMPT, VOICE_NOTE } from "./prompt";

export const CONFIG_FILES = ["system.md", "voice.md"] as const;
export type ConfigFile = (typeof CONFIG_FILES)[number];

/** What a thread runs with. */
export interface Prompts {
  system: string;
  voice: string;
}

export const DEFAULT_PROMPTS: Prompts = { system: SYSTEM_PROMPT, voice: VOICE_NOTE };

const KEY: Record<ConfigFile, keyof Prompts> = { "system.md": "system", "voice.md": "voice" };

/** What each file is, for the tools. */
export const CONFIG_ABOUT: Record<ConfigFile, string> = {
  "system.md": "Duck's system prompt: who Duck is, how it works, the routing rules and examples, the tool tiers and the safety rules",
  "voice.md": "the note sent with a spoken message: how a reply that may be read aloud starts",
};

/** The system prompt's safety rules, which a config file must keep verbatim. */
export const SAFETY_RULES = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Safety rules that always hold:"));

const SIZE: Record<ConfigFile, { min: number; max: number }> = {
  "system.md": { min: 2000, max: 60_000 },
  "voice.md": { min: 40, max: 4000 },
};

/** Why `text` can't be used as `file`; empty when it can. */
export function problemsWith(file: ConfigFile, text: string): string[] {
  const out: string[] = [];
  const { min, max } = SIZE[file];
  const n = text.trim().length;
  if (n < min) out.push(`it's too short (${n} characters; at least ${min})`);
  if (n > max) out.push(`it's too long (${n} characters; at most ${max})`);
  if (file === "system.md" && !text.includes(SAFETY_RULES))
    out.push('it must keep the "Safety rules that always hold" section exactly as built in');
  return out;
}

/** A short SHA-256 of `text`. */
export async function hashOf(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const promptsHash = (p: Prompts) => hashOf(JSON.stringify({ system: p.system, voice: p.voice }));

/** One edit of a config file: `find` (once, exactly) becomes `replace`. */
export interface ConfigEdit {
  find: string;
  replace: string;
}

/** `text` with `edits` made in order; throws when a `find` isn't there exactly
 *  once. An empty `find` appends `replace` on a line of its own. */
export function applyEdits(text: string, edits: readonly ConfigEdit[]): string {
  let out = text;
  for (const [i, e] of edits.entries()) {
    if (!e.find) {
      out = `${out.replace(/\s*$/, "")}\n${e.replace}`;
      continue;
    }
    const at = out.indexOf(e.find);
    if (at < 0) throw new Error(`edit ${i + 1}: its find text isn't in the file (read it again with improve_duck)`);
    if (out.indexOf(e.find, at + 1) >= 0) throw new Error(`edit ${i + 1}: its find text is in the file more than once; quote more of it`);
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return out;
}

/** Where the config lives: the IPC commands, or fakes in tests. */
export interface ConfigStore {
  read(): Promise<ConfigFileRow[]>;
  write(file: ConfigFile, text: string, expected: string | null, message: string, seed?: string | null): Promise<void>;
  pin(threadId: string, hash: string, json: string): Promise<void>;
  pinned(threadId: string): Promise<string | null>;
}

export function ipcConfigStore(workspace: () => string | null): ConfigStore {
  return {
    read: () => configRead(workspace()),
    write: (file, text, expected, message, seed) => configWrite(workspace(), file, text, expected, message, seed ?? null),
    pin: configPin,
    pinned: configPinned,
  };
}

/** One file as Duck reads it now. */
export interface ConfigFileState {
  file: ConfigFile;
  /** `config/system.md`. */
  path: string;
  /** On disk (null: none, and the seed couldn't be written). */
  text: string | null;
  /** What Duck uses: the file, or the default (with `problems` saying why). */
  used: "file" | "default";
  problems: string[];
  /** You or Duck edited it, and the built-in default has changed since. */
  defaultChanged: boolean;
}

export interface ConfigState {
  prompts: Prompts;
  hash: string;
  files: ConfigFileState[];
}

export interface ConfigHost {
  /** The prompts `threadId` runs with: its pin, else the files now (and it's
   *  pinned on them). */
  forThread(threadId: string): Promise<Prompts>;
  /** The files now, seeding the missing ones. */
  current(): Promise<ConfigState>;
  /** Write a file over `expected` (what was read) and commit it. */
  write(file: ConfigFile, text: string, expected: string | null, message: string): Promise<void>;
}

const isPrompts = (v: unknown): v is Prompts =>
  typeof v === "object" && v !== null && typeof (v as Prompts).system === "string" && typeof (v as Prompts).voice === "string";

export function createConfig(store: ConfigStore): ConfigHost {
  const threads = new Map<string, Promise<Prompts>>();
  let reading: Promise<ConfigState> | null = null;

  async function fileState(row: ConfigFileRow | undefined, file: ConfigFile): Promise<{ text: string; state: ConfigFileState }> {
    const def = DEFAULT_PROMPTS[KEY[file]];
    const defHash = await hashOf(def);
    const base = { file, path: `config/${file}`, problems: [] as string[], defaultChanged: false };
    const text = row?.text ?? null;
    const seedWith = async (expected: string | null, message: string) => {
      try {
        await store.write(file, def, expected, message, defHash);
        return def;
      } catch (e) {
        console.warn(`duck: config/${file} couldn't be written`, e);
        return expected;
      }
    };
    if (text === null) {
      const onDisk = await seedWith(null, `config: ${file}, Duck's built-in default`);
      return { text: def, state: { ...base, text: onDisk, used: "default" } };
    }
    // Untouched since its seed, and the build's default has moved: follow it.
    if (row?.seed && row.seed !== defHash && (await hashOf(text)) === row.seed) {
      const onDisk = await seedWith(text, `config: ${file} follows the new built-in default`);
      return { text: def, state: { ...base, text: onDisk, used: "default" } };
    }
    const problems = problemsWith(file, text);
    const defaultChanged = !!row?.seed && row.seed !== defHash;
    if (problems.length) return { text: def, state: { ...base, text, used: "default", problems, defaultChanged } };
    return { text, state: { ...base, text, used: "file", defaultChanged } };
  }

  async function read(): Promise<ConfigState> {
    const rows = await store.read();
    const prompts: Prompts = { ...DEFAULT_PROMPTS };
    const files: ConfigFileState[] = [];
    for (const file of CONFIG_FILES) {
      const { text, state } = await fileState(
        rows.find((r) => r.file === file),
        file,
      );
      prompts[KEY[file]] = text;
      files.push(state);
    }
    return { prompts, hash: await promptsHash(prompts), files };
  }

  /** One read at a time, so two threads starting together seed once. */
  const current = () => {
    reading ??= read().finally(() => (reading = null));
    return reading;
  };

  async function pinned(threadId: string): Promise<Prompts> {
    const json = await store.pinned(threadId);
    if (json) {
      try {
        const p: unknown = JSON.parse(json);
        if (isPrompts(p)) return { system: p.system, voice: p.voice };
      } catch {
        // An unreadable pin: pin the thread again below.
      }
    }
    const { prompts, hash } = await current();
    await store.pin(threadId, hash, JSON.stringify(prompts));
    return prompts;
  }

  return {
    forThread(threadId) {
      let p = threads.get(threadId);
      if (!p) {
        p = pinned(threadId);
        threads.set(threadId, p);
        // A failure isn't kept: the next turn tries again.
        p.catch(() => threads.delete(threadId));
      }
      return p;
    },
    current,
    write: (file, text, expected, message) => store.write(file, text, expected, message),
  };
}
