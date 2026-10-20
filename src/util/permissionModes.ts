// The permission modes a Claude Code session can be started in (step M4). The
// list comes from the installed Claude Code's `--help` (`pty::permission_modes`),
// read once per run and shared by every picker.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

let modes: Promise<string[]> | null = null;

/** The modes the installed Claude Code lists, without the `default` alias (it is
 *  `manual` now). Empty when they couldn't be read; asked again next time. */
export function loadPermissionModes(): Promise<string[]> {
  modes ??= invoke<string[]>("claude_permission_modes")
    .then((all) => all.filter((m) => m !== "default"))
    .catch(() => []);
  const p = modes;
  void p.then((m) => {
    if (m.length === 0 && modes === p) modes = null;
  });
  return p;
}

/** {@link loadPermissionModes} for a component, plus `current` when the list
 *  doesn't have it, so a stored value always shows. */
export function usePermissionModes(current: string | null): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void loadPermissionModes().then((m) => live && setList(m));
    return () => {
      live = false;
    };
  }, []);
  return current && !list.includes(current) ? [...list, current] : list;
}

/** The mode a session launches in: its own, else its project's default; null
 *  leaves Claude Code's default. Mirrors `registry::launch_permission_mode`. */
export function effectivePermissionMode(
  instance: { permissionMode: string | null },
  project: { defaultPermissionMode: string | null } | undefined,
): string | null {
  return instance.permissionMode ?? project?.defaultPermissionMode ?? null;
}
