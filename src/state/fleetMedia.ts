// Another machine's media in this machine's strip (improvement plan S3): what the
// remote console's transcript draws for a `show_media` call made over there.
//
// Pictures up to 20 MB and video or sound up to 50 MB come through the `wbmedia`
// scheme's `/m/<machine>/<id>`, which fetches them once into a cache here
// (`media/fleet.rs`). A bigger one is a card ("1.2 GB video on laptop") with "open
// on laptop" (an `openMedia` action there) and "fetch anyway" (each range passed
// through, nothing cached).

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { sendRemote } from "../panels/remoteSession";
import type { ViewerActions } from "../transcript/media";
import { heldActions, peerRef, type PeerMedia } from "../transcript/peerMedia";
import type { MediaSource } from "../transcript/render";

export function fleetMediaInfo(machine: string, ids: string[]): Promise<PeerMedia[]> {
  return invoke("fleet_media_info", { machine, ids });
}

/** Where the webview loads machine `machine`'s file `id` (`big` passes each range
 *  through instead of fetching it whole). Built by hand: `convertFileSrc` would
 *  encode the slashes. */
export function fleetMediaUrl(machine: string, id: string, big = false): string {
  return `${convertFileSrc("", "wbmedia")}m/${encodeURIComponent(machine)}/${id}${big ? "?big=1" : ""}`;
}

export function fleetMedia(machine: string, machineName: string): MediaSource {
  return {
    async resolve(ids) {
      const infos = new Map((await fleetMediaInfo(machine, ids)).map((i) => [i.id, i]));
      return ids.map((id) => peerRef(infos.get(id), id, machineName, (i, big) => fleetMediaUrl(machine, i, big)));
    },
  };
}

export function fleetActions(machine: string, machineName: string): ViewerActions {
  return heldActions(
    machineName,
    (ref) => ref.id && sendRemote(machine, { type: "openMedia", mediaId: ref.id }),
    (ref) => (ref.held && ref.id ? { ...ref, kind: ref.held, held: undefined, note: undefined, src: fleetMediaUrl(machine, ref.id, true) } : undefined),
  );
}
