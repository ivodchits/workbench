// The models a Claude Code session can be started on (step M1). These are Claude
// Code's own `--model` aliases, so each follows the latest model of its family;
// the backend also accepts a full model id (`registry::valid_model`).

export const SESSION_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;

/** The permission modes Duck may start a session in (step M4: `create_session` and
 *  its coding pref). Never `bypassPermissions`: that would step around the trust
 *  policy (track T). The pickers list what the installed Claude Code accepts
 *  (`util/permissionModes.ts`). */
export const DUCK_PERMISSION_MODES = ["acceptEdits", "auto", "manual", "dontAsk", "plan"] as const;

/** The model a session launches on: its own, else its project's default; null
 *  leaves Claude Code's default. Mirrors `registry::launch_model`. */
export function effectiveModel(
  instance: { model: string | null },
  project: { defaultModel: string | null } | undefined,
): string | null {
  return instance.model ?? project?.defaultModel ?? null;
}
