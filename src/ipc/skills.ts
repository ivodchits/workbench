// Typed wrappers over the Rust skill-manager commands (step 3.7b — design §7).
// Skills are pure filesystem entries (a folder + a SKILL.md): the list scans the
// scope dirs, create/remove operate on the directory, and editing reuses the
// generic file editor (the panel opens the `skillPath` these return). The backend
// serializes these structs as camelCase, so the types map across IPC directly.

import { invoke } from "@tauri-apps/api/core";

/** Where a skill lives. `user`/`project` are editable; `plugin` is read-only. */
export type SkillScope = "user" | "project" | "plugin";

export interface Skill {
  /** Folder name — the invocation id (`/<name>`) and stable key. */
  name: string;
  scope: SkillScope;
  /** Absolute path to the skill's SKILL.md (what the editor opens). */
  skillPath: string;
  /** The `name:` frontmatter field, if present. */
  frontmatterName: string | null;
  /** The `description:` frontmatter field, if present. */
  description: string | null;
  /** Frontmatter passes validation (kebab `name` + non-empty `description`). */
  valid: boolean;
  /** Human-readable validation problems (empty when `valid`). */
  problems: string[];
  /** For `plugin` scope, the owning plugin/source label. */
  plugin: string | null;
}

export interface NewSkill {
  projectRoot: string;
  /** `user` or `project` — plugin skills can't be created here. */
  scope: Exclude<SkillScope, "plugin">;
  name: string;
  description: string;
}

/** List user + project + plugin skills visible to a project, with validation. */
export function skillList(projectRoot: string): Promise<Skill[]> {
  return invoke("skill_list", { projectRoot });
}

/** Scaffold a new skill folder + SKILL.md; returns the SKILL.md path to open. */
export function skillCreate(input: NewSkill): Promise<string> {
  return invoke("skill_create", { input });
}

/** Delete a skill folder entirely (rejected for plugin scope). */
export function skillRemove(
  projectRoot: string,
  scope: SkillScope,
  name: string,
): Promise<void> {
  return invoke("skill_remove", { projectRoot, scope, name });
}
