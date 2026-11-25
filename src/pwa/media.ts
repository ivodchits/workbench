// The phone's media strip (improvement plan S3): files a session showed with
// `show_media`, from the machine the page shows (`/api/media`, relayed like the
// other session routes). A media element can't send the device token, so a file is
// fetched with it and shown from a blob URL: pictures up to 20 MB and video or
// sound up to 50 MB at once, a bigger one only when asked ("fetch anyway"), and any
// of them can be opened on the machine that has it.

import { fetchable, type MediaRef, type ViewerActions } from "../transcript/media";
import type { MediaSource } from "../transcript/render";
import { heldActions, peerRef, type PeerMedia } from "../transcript/peerMedia";
import { machines, routed, shownMachine } from "./machine";
import { action, authHeader } from "./net";

/** The name of the machine whose sessions the page shows. */
function machineName(): string {
  const f = machines();
  const id = shownMachine() ?? f?.here ?? null;
  return f?.instances.find((i) => i.id === id)?.name ?? "the desktop";
}

async function info(id: string): Promise<PeerMedia | undefined> {
  const r = await fetch(routed(`/api/media/${id}/info`), { headers: authHeader() });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`the file's details didn't load (${r.status})`);
  return (await r.json()) as PeerMedia;
}

const blobs = new Map<string, Promise<string>>();

/** The file as an object URL, fetched once. */
function blobUrl(id: string): Promise<string> {
  let u = blobs.get(id);
  if (!u) {
    u = fetch(routed(`/api/media/${id}`), { headers: authHeader() }).then(async (r) => {
      if (!r.ok) throw new Error(`the file didn't load (${r.status})`);
      return URL.createObjectURL(await r.blob());
    });
    u.catch(() => blobs.delete(id));
    blobs.set(id, u);
  }
  return u;
}

export const phoneMedia: MediaSource = {
  async resolve(ids) {
    const name = machineName();
    return Promise.all(
      ids.map(async (id): Promise<MediaRef> => {
        const i = await info(id).catch(() => undefined);
        const ref = peerRef(i, id, name, () => "");
        // One fetched anyway before is here already.
        const asked = blobs.has(id) && i && i.kind !== "file" && !ref.gone;
        if (!i || ref.gone || ((ref.held || !fetchable(i.kind, i.size)) && !asked)) return ref;
        try {
          return { ...ref, kind: i.kind, held: undefined, note: undefined, src: await blobUrl(id) };
        } catch {
          return { ...ref, kind: "file", src: "", note: "didn't load", held: i.kind };
        }
      }),
    );
  },
};

export function phoneActions(): ViewerActions {
  return heldActions(
    machineName(),
    (ref) => ref.id && action({ type: "openMedia", mediaId: ref.id }),
    async (ref) =>
      ref.held && ref.id ? { ...ref, kind: ref.held, held: undefined, note: undefined, src: await blobUrl(ref.id) } : undefined,
  );
}
