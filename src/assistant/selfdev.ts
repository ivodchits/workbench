// Duck changing its own code (step L3): the pieces the tools and the task manager
// share. A code change is a serious-tier worker in a worktree of the Workbench repo
// (`improve_duck`), whose brief this module writes; when it finishes, its branch's
// files are read and checked against the safety layer; merging it is yours
// (`merge_duck_change`, on the floor, twice when the safety layer is touched).

import type { ProjectRef, WorkbenchPort } from "./port";
import { findProject } from "./tools/read";

/** The safety layer: the trust engine, the API key's proxy and the budget, the
 *  data repo's push guard (L4's `gitlane.rs`), and the guards of self-development
 *  itself. A branch touching one of these gets the red
 *  badge, and its merge a second confirm. */
export const SAFETY_PATHS: readonly RegExp[] = [
  /^src\/assistant\/trust\//,
  /^src-tauri\/src\/assistant\/(?:proxy|budget|key|trust|gitlane)\.rs$/,
  /^src\/assistant\/(?:selfdev|config)\.ts$/,
  /^src\/assistant\/tools\/improve\.ts$/,
];

/** The files in `files` that are in the safety layer. */
export const safetyFiles = (files: readonly string[]): string[] =>
  files.filter((f) => SAFETY_PATHS.some((r) => r.test(f.replace(/\\/g, "/").replace(/^\.\//, ""))));

/** The Workbench repo among your projects: `name` when given, else the one whose
 *  folder or name is "workbench". */
export function selfProject(port: WorkbenchPort, name?: string): ProjectRef {
  if (name) return findProject(port, name);
  const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const hits = port.listProjects().filter((p) => !p.remote && (base(p.rootPath) === "workbench" || p.name.toLowerCase() === "workbench"));
  if (hits.length === 1) return hits[0];
  throw new Error(
    hits.length
      ? `Several projects could be the Workbench repo (${hits.map((p) => p.name).join(", ")}): name it with \`project\`.`
      : "The Workbench repo isn't one of your projects: ask the user to add it (or name it with `project`).",
  );
}

/** The commands a code change must pass. */
export const TEST_COMMANDS = [
  "npm run lint",
  "npm test",
  "cargo test --lib (in src-tauri; set CARGO_TARGET_DIR=target-test so a running dev build's files aren't in the way)",
];

export interface BriefInput {
  request: string;
  /** `lessons` entries that may bear on it. */
  lessons: string[];
  /** The request reaches beyond Duck's own modules. */
  wide?: boolean;
}

/** The brief of a code change to Duck. */
export function improveBrief({ request, lessons, wide }: BriefInput): string {
  const lessonLines = lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "- None recorded that seem related.";
  const where = wide
    ? "The request reaches beyond Duck's own modules: change what it needs there, and say in result.md which files outside Duck's modules you touched and why."
    : "Change Duck's own modules only: `src/assistant/`, `src/panels/Assistant/`, the `src/ipc/` files of Duck's commands, `src-tauri/src/assistant/` (and their registration in `src-tauri/src/lib.rs`), their tests, and `documentation/duck-architecture.md`. Nothing else in Workbench.";
  return `This is a change to Duck, the assistant built into Workbench, asked for by the user. You work in a git worktree of the Workbench repo, on a branch of your own.

## The request

${request.trim()}

## What Duck has learned about working with the user (lessons that may bear on it)

${lessonLines}

## Finding your way

- \`documentation/duck-architecture.md\`: Duck's modules, \`WorkbenchPort\`, the Duck Protocol, the tools, trust, voice and tasks, and "Where to change X". Start there.
- \`documentation/assistant-plan.md\`: the plan Duck was built from. Read its section "## Guardrails (settled — don't violate)" before you change anything; every line of it holds for this change.
- Duck's prompts are also files in Duck's workspace (\`config/system.md\`, \`config/voice.md\`). If the request is only about what Duck says or how it routes, say so in result.md rather than changing code: that's a config change Duck makes itself.

## Where you may change things

${where}

The safety layer is \`src/assistant/trust/\`, \`src-tauri/src/assistant/{proxy,budget,key,trust,gitlane}.rs\`, and the guards of this very process (\`src/assistant/selfdev.ts\`, \`src/assistant/config.ts\`, \`src/assistant/tools/improve.ts\`). Leave it alone unless the request is about it. A change there is flagged to the user and needs their second confirm before it's merged; if you must touch it, say why at the top of result.md.

## Done means

- The change, with tests for the new behavior, in the style of the code around it.
- These pass: ${TEST_COMMANDS.map((c) => `\`${c.split(" (")[0]}\`${c.includes(" (") ? ` (${c.split(" (")[1]}` : ""}`).join("; ")}.
- \`documentation/duck-architecture.md\` says what changed.
- Your work is committed on this branch, with a clear message. Don't merge, don't push, don't touch other branches: the user reviews the branch and merges it themselves.
- result.md: a short summary of the change, the files touched, how to see it working, and the test commands' summary lines (pass counts, or what failed).`;
}

/** The commands that rebuild Workbench with a merged change in it. */
export const REBUILD = {
  dev: { command: "npm run tauri:dev", label: "Duck: dev build" },
  release: { command: "npm run tauri:build", label: "Duck: release build" },
} as const;
