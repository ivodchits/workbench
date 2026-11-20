// Typed wrappers over the Claude profile commands (profiles plan P1.1). A profile
// is a Claude Code config dir a project's consoles run under (`CLAUDE_CONFIG_DIR`),
// so a project can use another account. A project with no profile uses Personal.

import { invoke } from "@tauri-apps/api/core";

export interface ClaudeProfile {
  id: string;
  name: string;
  configDir: string;
  /** Whether the dir holds a claude.ai login; if not, its first console asks. */
  loggedIn: boolean;
  projectCount: number;
}

export interface PersonalProfile {
  configDir: string | null;
  loggedIn: boolean;
}

export const listProfiles = () => invoke<ClaudeProfile[]>("profiles_list");
export const personalProfile = () => invoke<PersonalProfile>("profiles_personal");
/** Adopt an existing config dir as it is, or create an empty one. */
export const addProfile = (name: string, configDir: string) =>
  invoke<ClaudeProfile>("profiles_add", { name, configDir });
export const renameProfile = (id: string, name: string) =>
  invoke<void>("profiles_rename", { id, name });
/** Forget a profile; its projects go back to Personal and the dir stays on disk. */
export const removeProfile = (id: string) => invoke<void>("profiles_remove", { id });
