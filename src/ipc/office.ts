// The office (office plan O0.2): Workbench serves it on loopback and opens it in the
// default browser with a one-time launch token. Everything else the office needs
// rides the remote snapshot and actions (`ipc/remote.ts`).

import { invoke } from "@tauri-apps/api/core";

/** Start the office's listener if needed and open the office in the default browser.
 *  Resolves to the URL opened. */
export function officeOpen(): Promise<string> {
  return invoke("office_open");
}

/** A repo's commits: the latest one's time (epoch seconds), and how many since the
 *  `since` asked for; null where there are none. */
export interface RepoCommits {
  lastAt: number | null;
  since: number | null;
}

/** Each repo's commits, in order (office plan O1.6: `since` is the local midnight). */
export function officeCommits(repoRoots: string[], since: number): Promise<RepoCommits[]> {
  return invoke("office_commits", { repoRoots, since });
}
