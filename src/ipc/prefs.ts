// Typed access to the app preferences store (step 1.2), backed by
// `tauri-plugin-store` (a JSON file under the app config dir). This is for small
// user prefs that aren't part of the relational registry — the per-project
// layout, instances, and groups live in SQLite (see `registry.ts`).
//
// The shape grows as features land; everything is optional so a missing key
// falls back to the caller's default. Known keys are typed here so callers get
// completion rather than reaching for arbitrary strings.

import { load, type Store } from "@tauri-apps/plugin-store";
import type { ReadPosition } from "../assistant/reader";

export interface Prefs {
  /** Active theme token preset id (see `theme/`). */
  themeId: string;
  /** CRT overlay on/off — off by default (step 3.9, design §5.x). */
  crtEnabled: boolean;
  /** Global UI font scale (1 = 100%); Ctrl+MouseWheel adjusts it (step 3.9). */
  fontScale: number;
  /** Last-selected project id, restored on launch so you land where you left. */
  activeProjectId: string;
  /** Override for where worktrees are provisioned (step 2.4). Empty = the default
   *  sibling `.workbench/worktrees/` next to each repo (decision 7). */
  worktreeBasePath: string;
  /** Remapped keyboard shortcuts (step 3.10): binding id → chord (empty = unbound).
   *  Only bindings that differ from their shipped default are stored. */
  keymapOverrides: Record<string, string>;
  /** Notification routing + escalation thresholds (step 4.6). */
  notifications: NotificationPrefs;
  /** Half-written Git-panel commit messages, keyed by repo root (G1). */
  commitDrafts: Record<string, CommitDraft>;
  /** Git-panel splitter positions + collapsed sections (G2). */
  gitLayout: GitLayout;
  /** Consoles showing their transcript instead of the terminal (step T3), keyed by
   *  instance id. Absent = terminal. */
  transcriptView: Record<string, boolean>;
  /** The review panel's diff layout (step V1). Absent = unified. */
  diffLayout: DiffLayout;
  /** The prompt a fresh reviewing agent gets (step A1), keyed by project id.
   *  Absent = the default; `{base}` is filled with the diff's base. */
  reviewPrompts: Record<string, string>;
  /** The editor shows markdown files formatted while editing (step N2). Absent = off. */
  editorLiveMarkdown: boolean;
  /** Duck's drawer (step A3): its width, the thread it shows, and what a message
   *  typed mid-reply does. */
  assistantDrawer: AssistantDrawerPrefs;
  /** Duck's settings (step W2), as `src/assistant/settings.ts` keeps them. */
  assistant: Partial<{
    confirmPrompts: boolean;
    codingModel: string;
    codingPermissionMode: string | null;
  }>;
  /** Voice input (step V1). */
  voice: {
    gpu: "always" | "ac_only" | "never";
    hotkey: string | null;
    device: string | null;
    /** Send a transcript to Duck at once; off, it lands in the composer to edit. */
    sendNow: boolean;
  };
  /** Read-aloud positions (step V3): source key → where it stopped. */
  readAloud: Record<string, ReadPosition>;
  /** Spoken replies (step V2). */
  speech: {
    /** Which of Duck's replies are spoken: none, those to a spoken message, all. */
    speak: "off" | "voice" | "always";
    /** Kokoro + Silero on this PC, or Google Chirp 3 HD. */
    engine: "local" | "chirp";
    /** Chirp speaks when the local engine fails. */
    chirpFallback: boolean;
    voiceEn: string;
    voiceRu: string;
    /** 1 is normal. */
    rate: number;
  };
  /** The project toolbar's field values (step K1): project id → `pluginId.controlId`
   *  → the last value (text for a select or text field, a flag for a checkbox). */
  pluginValues: Record<string, Record<string, string | boolean>>;
}

export interface AssistantDrawerPrefs {
  /** Width in px. */
  width: number;
  /** The thread open in the drawer; `null` = a new thread. */
  threadId: string | null;
  /** A message sent while Duck replies stops the reply and is answered instead.
   *  Off = it waits its turn. */
  interrupt: boolean;
  /** The ASCII duck at the top of the thread, and how it's drawn. */
  avatar: DuckAvatarPrefs;
  /** Replies not seen yet, per thread, and each thread's latest news line: kept
   *  across restarts so news that came in the background isn't lost. */
  unread?: Record<string, number>;
  news?: Record<string, string>;
}

export interface DuckAvatarPrefs {
  show: boolean;
  /** Duck yellow with an orange beak, or the theme's text color. */
  ink: "color" | "mono";
  /** The character ramp, dim to bright. */
  chars: "classic" | "blocks";
  /** Character columns across the drawer; rows follow from the height. */
  cols: number;
  fps: number;
}

/** One column with the old lines above the new, or the two versions side by side. */
export type DiffLayout = "unified" | "split";

/** Where the Git panel's draggable splits sit, and which sections are open (G2).
 *  Global rather than per repo: it's a shape-of-the-window preference, and the
 *  same panel is re-bound to different repos as you move between projects. */
export interface GitLayout {
  /** First-pane size in px, keyed `<split id>:<orientation>` — a split has an
   *  independent position wide vs narrow, since one is a width and one a height. */
  splits: Record<string, GitSplitState>;
  /** Collapsible sections, keyed by section id; `true` = open. */
  sections: Record<string, boolean>;
}

export interface GitSplitState {
  /** First pane's size along the split axis, in px. */
  size: number;
  /** The second pane is collapsed away — the first takes the whole box. */
  collapsed: boolean;
}

/** An unsent commit message (G1). Persisted per repo root so a half-written
 *  message survives a tab switch, a panel close/reopen, and a restart — losing one
 *  to a mis-click is the kind of thing you only forgive a text editor once. */
export interface CommitDraft {
  subject: string;
  body: string;
}

/** Where "needs you" alerts go, and when a waiting/working card escalates (step
 *  4.6, design §7). Persisted here so the routing survives restarts; the live
 *  engine + UI live in `state/notifications.ts`. (A webhook route — Discord/Slack/
 *  ntfy — is a planned future addition; this shape grows a `webhookUrl` then.) */
export interface NotificationPrefs {
  /** Desktop OS toast on a fresh needs-you and on escalation. */
  desktop: boolean;
  /** The phone route: escalation/stuck emphasis on the dashboard snapshot (step
   *  4.4), and pushes to subscribed phones on needs-you and escalation (step R6).
   *  The phone always shows live status. */
  phone: boolean;
  /** Minutes a card may sit in ● needs-you before a louder escalation re-ping. */
  escalateAfterMin: number;
  /** Minutes a card may run in ◐ working before it's flagged possibly-stuck. */
  stuckAfterMin: number;
  /** Alert (on the routes above) each time an agent finishes a turn. */
  done: boolean;
  /** Hold the done alert while the session still has background work running
   *  (agents, workflows, shells, monitors) — fire only once it's all finished. */
  doneWaitForBackground: boolean;
}
// Note: the hook-server port is owned by the Rust backend (it must bind before it
// can advertise the port), persisted in the SQLite `meta` table, and read by the
// frontend via `getHookServerStatus()` (see `ipc/hooks.ts`) — not a pref here.

// A debug build (`tauri dev`, where `import.meta.env.DEV` is true) keeps its prefs
// in a separate file so it can run alongside an installed release without sharing
// the active theme/project selection. Mirrors the `workbench.dev.db` split in the
// Rust setup.
const STORE_FILE = import.meta.env.DEV ? "prefs.dev.json" : "prefs.json";

let storePromise: Promise<Store> | null = null;

/** Lazily open the shared prefs store; `autoSave` flushes writes to disk. */
function store(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

/** Read a pref, returning `fallback` when it hasn't been set yet. */
export async function getPref<K extends keyof Prefs>(
  key: K,
  fallback: Prefs[K],
): Promise<Prefs[K]> {
  const value = await (await store()).get<Prefs[K]>(key);
  return value ?? fallback;
}

/** Write a pref (persisted via the store's autoSave). */
export async function setPref<K extends keyof Prefs>(
  key: K,
  value: Prefs[K],
): Promise<void> {
  await (await store()).set(key, value);
}
