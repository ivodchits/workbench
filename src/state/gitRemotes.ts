// This machine's projects' git remotes (fleet plan F9.1), normalized as Duck's port
// has them (`assistant/remotes.ts`): the snapshot carries them to the other
// machines, and the rail matches their projects to these by them. Looked up once
// per folder, in the background; an SSH project has none here.

import { useSyncExternalStore } from "react";
import { gitOriginUrl } from "../ipc/git";
import type { Project } from "../ipc/registry";
import { normalizeRemote } from "../assistant/remotes";

/** By folder: the remote, null for none, absent while unknown. */
const known = new Map<string, string | null>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function look(root: string): void {
  if (known.has(root) || asking.has(root)) return;
  asking.add(root);
  gitOriginUrl(root)
    .then((url) => known.set(root, url ? normalizeRemote(url) : null))
    .catch(() => known.set(root, null))
    .finally(() => {
      asking.delete(root);
      version++;
      for (const l of listeners) l();
    });
}

/** A project's remote: a string, null for none (or an SSH project), undefined while
 *  it's being looked up. Starts the lookup. */
export function gitRemoteOf(p: Pick<Project, "rootPath" | "remoteSshDest">): string | null | undefined {
  if (p.remoteSshDest != null) return null;
  look(p.rootPath);
  return known.get(p.rootPath);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders as lookups finish; read the remotes with `gitRemoteOf`. */
export function useGitRemotesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
