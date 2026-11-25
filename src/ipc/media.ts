// Files a session showed with `show_media` (improvement plan S2), served by id only
// (`src-tauri/src/media/`).

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MediaKind = "image" | "video" | "audio" | "file";

/** A registered file, as it is now. */
export interface MediaInfo {
  id: string;
  instanceId: string;
  kind: MediaKind;
  mime: string;
  name: string;
  path: string;
  size: number;
  shownAt: number;
  caption: string | null;
  /** "changed" since it was shown (served as it is now), or "gone". */
  state: "ok" | "changed" | "gone";
}

export function mediaInfo(ids: string[]): Promise<MediaInfo[]> {
  return invoke("media_info", { ids });
}

/** A session's files, newest first. */
export function mediaList(instanceId: string): Promise<MediaInfo[]> {
  return invoke("media_list", { instanceId });
}

/** Where the webview loads a registered file from (the `wbmedia` scheme). */
export function mediaUrl(id: string): string {
  return convertFileSrc(id, "wbmedia");
}

export function onMediaShown(cb: (instanceId: string, ids: string[]) => void): Promise<UnlistenFn> {
  return listen<{ instanceId: string; ids: string[] }>("media-shown", (e) => cb(e.payload.instanceId, e.payload.ids));
}

/** Whether a command that only opens a media file in another app is refused. */
export function mediaRefuseGet(): Promise<boolean> {
  return invoke("media_refuse_get");
}

export function mediaRefuseSet(on: boolean): Promise<void> {
  return invoke("media_refuse_set", { on });
}
