// The office (office plan O0.2): Workbench serves it on loopback and opens it in the
// default browser with a one-time launch token. Everything else the office needs
// rides the remote snapshot and actions (`ipc/remote.ts`).

import { invoke } from "@tauri-apps/api/core";

/** Start the office's listener if needed and open the office in the default browser.
 *  Resolves to the URL opened. */
export function officeOpen(): Promise<string> {
  return invoke("office_open");
}

/** Each repo's latest commit time (epoch seconds), in order; null where there is none. */
export function officeLastCommits(repoRoots: string[]): Promise<(number | null)[]> {
  return invoke("office_last_commits", { repoRoots });
}
