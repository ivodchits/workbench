// Another machine's files as the strip draws them (improvement plan S3), shared by
// the desktop's remote console (`state/fleetMedia.ts`) and the phone
// (`pwa/media.ts`). No Tauri and no framework here: the phone imports it.

import { fetchable, kindWord, type MediaKind, type MediaRef, type ViewerActions } from "./media";

/** What another machine says about one of its files (its info, without the path). */
export interface PeerMedia {
  id: string;
  kind: MediaKind;
  mime: string;
  name: string;
  size: number;
  caption: string | null;
  state: "ok" | "changed" | "gone";
}

/** A file of `machineName`'s as the strip draws it. */
export function peerRef(info: PeerMedia | undefined, id: string, machineName: string, url: (id: string, big?: boolean) => string): MediaRef {
  if (!info) return { kind: "file", src: "", label: "a shown file", id, note: `not known on ${machineName}`, gone: true };
  const base = { label: info.name, id, size: info.size };
  if (info.state === "gone") return { ...base, kind: info.kind, src: "", note: "file gone", gone: true };
  if (fetchable(info.kind, info.size)) {
    return { ...base, kind: info.kind, src: url(id), note: info.state === "changed" ? "changed since it was shown" : undefined };
  }
  return { ...base, kind: "file", src: "", held: info.kind === "file" ? undefined : info.kind, note: `${kindWord(info.kind)} on ${machineName}` };
}

/** What the viewer offers for another machine's file: open it over there, or fetch
 *  one that's too big anyway. */
export function heldActions(
  machineName: string,
  openThere: (ref: MediaRef) => void,
  fetchAnyway: (ref: MediaRef) => MediaRef | void | Promise<MediaRef | void>,
): ViewerActions {
  return {
    openLabel: `open on ${machineName}`,
    open: openThere,
    more: (ref) => (ref.held ? [{ label: "fetch anyway", title: `fetch it from ${machineName} and play it here`, run: () => fetchAnyway(ref) }] : []),
  };
}
