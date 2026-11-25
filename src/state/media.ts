// Files this machine's sessions showed with `show_media` (improvement plan S2): what
// the transcript's strip draws for an id, what the viewer can do with one, and the
// console header's badge (how many were shown while you were in the terminal) and
// its tray.

import { useSyncExternalStore } from "react";

import { mediaInfo, mediaList, mediaUrl, onMediaShown, type MediaInfo } from "../ipc/media";
import { openPath, revealPath } from "../ipc/os";
import { openPanelBeside } from "./dock";
import type { MediaRef, ViewerActions } from "../transcript/media";
import type { MediaSource } from "../transcript/render";
import { flash } from "../util/flash";

/** A registered file as the strip and viewer draw it. */
export function refOf(info: MediaInfo, src: (id: string) => string = mediaUrl): MediaRef {
  return {
    kind: info.kind,
    src: info.state === "gone" ? "" : src(info.id),
    label: info.name,
    id: info.id,
    size: info.size,
    note: info.state === "gone" ? "file gone" : info.state === "changed" ? "changed since it was shown" : undefined,
    gone: info.state === "gone",
  };
}

const known = new Map<string, MediaInfo>();

/** This machine's registered files, by id. An id it doesn't know is a card saying so. */
export const desktopMedia: MediaSource = {
  async resolve(ids) {
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) for (const info of await mediaInfo(missing)) known.set(info.id, info);
    return ids.map((id) => {
      const info = known.get(id);
      return info ? refOf(info) : { kind: "file", src: "", label: "a shown file", id, note: "not known here", gone: true };
    });
  },
};

async function pathOf(ref: MediaRef): Promise<string | null> {
  if (!ref.id) return null;
  const info = known.get(ref.id) ?? (await mediaInfo([ref.id]))[0];
  return info?.path ?? null;
}

function fail(what: string) {
  return (e: unknown) => flash(`couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
}

/** What the viewer offers for session `instanceId`'s files. */
export function desktopActions(instanceId: string): ViewerActions {
  return {
    open: (ref) => void pathOf(ref).then((p) => (p ? openPath(p) : undefined)).catch(fail("open it")),
    reveal: (ref) => void pathOf(ref).then((p) => (p ? revealPath(p) : undefined)).catch(fail("show it")),
    popOut: (ref) => ref.id && openMediaPanel(instanceId, ref.id, ref.label),
  };
}

export interface MediaPanelParams {
  mediaId: string;
  instanceId: string;
  title: string;
}

/** Open one file in a dockable panel beside the session's console. */
export function openMediaPanel(instanceId: string, mediaId: string, title: string): void {
  const params: MediaPanelParams = { mediaId, instanceId, title };
  openPanelBeside(instanceId, { id: `media:${mediaId}`, component: "media", title: `media · ${title}`, params: { ...params } });
}

// ── the badge and the tray ──

interface Counts {
  /** Shown since you last looked. */
  unseen: number;
  /** All the session's files. */
  total: number;
}

let counts: ReadonlyMap<string, Counts> = new Map();
let tray: string | null = null;
const listeners = new Set<() => void>();
const asked = new Set<string>();

function emit(): void {
  for (const l of listeners) l();
}

function set(instanceId: string, c: Counts): void {
  const next = new Map(counts);
  next.set(instanceId, c);
  counts = next;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const NONE: Counts = { unseen: 0, total: 0 };

/** The session's counts; the first ask reads how many it already has. */
export function useMediaCounts(instanceId: string): Counts {
  if (!asked.has(instanceId)) {
    asked.add(instanceId);
    void mediaList(instanceId)
      .then((all) => {
        const c = counts.get(instanceId) ?? NONE;
        if (all.length > c.total) set(instanceId, { ...c, total: all.length });
      })
      .catch(() => {});
  }
  return useSyncExternalStore(subscribe, () => counts.get(instanceId) ?? NONE);
}

/** You've seen the session's files (its transcript is on screen, or the tray opened). */
export function markMediaSeen(instanceId: string): void {
  const c = counts.get(instanceId);
  if (c && c.unseen > 0) set(instanceId, { ...c, unseen: 0 });
}

export function openMediaTray(instanceId: string): void {
  tray = instanceId;
  markMediaSeen(instanceId);
  emit();
}

export function closeMediaTray(): void {
  if (tray === null) return;
  tray = null;
  emit();
}

export function useMediaTray(): string | null {
  return useSyncExternalStore(subscribe, () => tray);
}

let started = false;

/** Hear what sessions show; once, at startup. */
export function initMedia(): void {
  if (started) return;
  started = true;
  void onMediaShown((instanceId, ids) => {
    const c = counts.get(instanceId) ?? NONE;
    set(instanceId, { unseen: c.unseen + ids.length, total: c.total + ids.length });
  });
}
