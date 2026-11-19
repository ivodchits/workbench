// Projects' git remotes (fleet plan F3.2): the same project on several machines
// lives in different folders but has the same `origin`, so Duck can tell "the
// workbench project on the laptop" from a different project that's also called
// workbench, and find a project by its repo. Looked up once per folder in the
// background (the port's reads are synchronous), then attached to every listing.

import type { ProjectRef } from "./port";

/** A remote URL as `host/owner/repo`, lower case: https, ssh and scp forms alike. */
export function normalizeRemote(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  u = u.replace(/^[a-z+]+:\/\//i, ""); // https://, ssh://, git+ssh://
  u = u.replace(/^[^@/]+@/, ""); // user@
  u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/"); // scp form host:owner/repo
  u = u.replace(/^([^/:]+):\d+\//, "$1/"); // a port
  u = u.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  return u.includes("/") ? u.toLowerCase() : null;
}

/** Whether `ref` (what the user or Duck said) names the repo `remote`: the whole
 *  thing, or its `owner/repo` tail. */
export function remoteMatches(remote: string, ref: string): boolean {
  const r = normalizeRemote(ref.includes("/") && !ref.includes(".") ? `x/${ref}` : ref);
  if (!r) return false;
  const tail = r.startsWith("x/") ? r.slice(2) : r;
  return remote === r || remote.endsWith("/" + tail);
}

export interface Remotes {
  /** `projects` with the remotes known so far; the rest are looked up. */
  attach(projects: ProjectRef[]): ProjectRef[];
}

export function createRemotes(lookup: (root: string) => Promise<string | null>): Remotes {
  const known = new Map<string, string | null>();
  const asking = new Set<string>();
  return {
    attach(projects) {
      return projects.map((p) => {
        if (p.remote) return p; // an SSH project's folder isn't on this machine
        const k = known.get(p.rootPath);
        if (k === undefined && !asking.has(p.rootPath)) {
          asking.add(p.rootPath);
          void lookup(p.rootPath)
            .then((url) => known.set(p.rootPath, url ? normalizeRemote(url) : null))
            .catch(() => known.set(p.rootPath, null))
            .finally(() => asking.delete(p.rootPath));
        }
        return k ? { ...p, gitRemote: k } : p;
      });
    },
  };
}
