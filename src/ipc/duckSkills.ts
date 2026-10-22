// Duck's own skills (step S2), not Claude Code's (that's `skills.ts`):
// `skills/<name>/SKILL.md` in Duck's workspace. See `src-tauri/src/assistant/skills.rs`.

import { invoke } from "@tauri-apps/api/core";

/** One skill's file as it is on disk. */
export interface SkillFileRow {
  /** The folder's name. */
  name: string;
  /** The `SKILL.md`'s absolute path. */
  path: string;
  /** `skills/<name>/SKILL.md`, relative to the workspace. */
  rel: string;
  /** The frontmatter's `key: value` lines, in file order. */
  fields: [string, string][];
  body: string;
  /** The whole file. */
  text: string;
  /** Why it can't be used as it is (read by the backend). */
  problems: string[];
}

export function skillsList(workspace: string | null): Promise<SkillFileRow[]> {
  return invoke("assistant_skills_list", { workspace });
}

/** Write over `expected` (what was read; null: no file) and commit with `message`;
 *  throws "stale: …" over a newer edit. */
export function skillWrite(workspace: string | null, name: string, text: string, expected: string | null, message: string): Promise<void> {
  return invoke("assistant_skill_write", { workspace, name, text, expected, message });
}
