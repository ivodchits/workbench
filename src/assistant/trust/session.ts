// Claude Code permission prompts (step T2): the deterministic half of deciding
// one. The layers of `decide.ts` in the same order, over the structured call the
// `PermissionRequest` hook carries (never text read off the screen):
//
//   1. kill switch   trust paused, or the project `off`: you answer (not logged)
//      rate guard   this session tripped it: you answer
//   2. floor        `floor.ts` over the command, path or URL; and a file write
//                   outside the session's folder
//   3. rules        your rules, in Claude Code's syntax (`Bash(npm test:*)`)
//   4–5.            nothing settled it: the judge reads it against the session's
//                   mandate (`judge.ts`), or you answer when there is no mandate
//
// The watcher (`watcher.ts`) runs the judge and answers the prompt.

import type { ChoiceRef } from "../port";
import type { Decision, TrustConfig } from "./decide";
import { floorHit } from "./floor";
import { evaluate, type RuleTarget } from "./rules";

export interface PromptRequest {
  instanceId: string;
  projectId: string;
  /** Claude Code's tool name: `Bash`, `Edit`, `WebFetch`, `mcp__…`. */
  tool: string;
  input: Record<string, unknown>;
  /** The session's working folder (its worktree, else the project root). */
  root: string;
  home?: string;
}

/** The rate guard's key for a session (threads use their own id). */
export const sessionKey = (instanceId: string) => `session:${instanceId}`;

const FILE_WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) if (str(input[k])) return input[k] as string;
  return undefined;
}

/** What the rules match a prompt's call against. */
export function promptTarget(req: PromptRequest): RuleTarget {
  return {
    tool: req.tool,
    projectId: req.projectId,
    command: str(req.input.command),
    path: pathOf(req.input),
    url: str(req.input.url),
    root: req.root,
    home: req.home,
  };
}

/** The text the floor reads in a call. */
export function promptTexts(req: PromptRequest): string[] {
  const out = [req.tool];
  for (const k of ["command", "file_path", "path", "notebook_path", "url", "pattern"])
    if (str(req.input[k])) out.push(req.input[k] as string);
  return out;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Whether `path` (absolute, or relative to `root`) lies outside `root`. */
export function outside(path: string, root: string): boolean {
  const p = norm(path);
  if (!/^([a-z]:)?\//.test(p)) return /(^|\/)\.\.(\/|$)/.test(p);
  const r = norm(root);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const resolved = parts.join("/");
  return resolved !== r && !resolved.startsWith(`${r}/`);
}

/** Claude Code's own working files, which it writes without asking: a session's
 *  scratchpad (`<temp>/claude/<project>/<session>/scratchpad`), its memory
 *  (`~/.claude/projects/<project>/memory`) and its plan files (`~/.claude/plans`). */
export function claudeOwn(path: string): boolean {
  const p = norm(path);
  return (
    /(?:^|\/)(?:appdata\/local\/temp|tmp)\/claude\/[^/]+\/[^/]+\/scratchpad(?:\/|$)/.test(p) ||
    /\/\.claude\/(?:plans|projects\/[^/]+\/memory)\//.test(p)
  );
}

/** The judge still has to read it. */
export interface NeedsJudge {
  outcome: "judge";
  shadow: boolean;
}

/** The deterministic layers' decision, or that the judge decides. `null`: trust
 *  doesn't apply here (paused, or the project's trust is off), so the prompt is
 *  simply left to you and nothing is logged. */
export function decidePrompt(
  req: PromptRequest,
  cfg: TrustConfig,
): Decision | NeedsJudge | null {
  const mode = cfg.modes[req.projectId] ?? "live";
  if (cfg.paused || mode === "off") return null;
  const shadow = mode === "shadow";
  const out = (d: Omit<Decision, "shadow">): Decision => ({ ...d, shadow });
  if (cfg.tripped.includes(sessionKey(req.instanceId)))
    return out({ outcome: "ask", layer: "rate", reason: "the rate guard paused trust for this session" });

  const floor = floorHit(promptTexts(req), cfg.floorOff);
  if (floor) return out({ outcome: "ask", layer: "floor", reason: `floor: ${floor.label}` });
  const path = pathOf(req.input);
  if (FILE_WRITES.has(req.tool) && path && outside(path, req.root) && !claudeOwn(path))
    return out({ outcome: "ask", layer: "floor", reason: "floor: a write outside the session's folder" });

  const hit = evaluate(cfg.rules, promptTarget(req));
  if (hit)
    return out({
      outcome: hit.effect,
      layer: "rule",
      reason: `${hit.effect} ${hit.rule.pattern}${hit.rule.projectId ? " (this project)" : ""}`,
      ruleId: hit.rule.id,
    });
  return { outcome: "judge", shadow };
}

/** "Yes" once, found by its label among options read off the screen. Null when the
 *  prompt doesn't look like the permission prompt we know (a "Yes" and a "No…"),
 *  so nothing is pressed. Never a "don't ask again" or "allow all" option. */
export function pickYes(choice: ChoiceRef): number | null {
  if (choice.kind !== "permission" || choice.optionsFrom !== "terminal") return null;
  const yes = choice.options.filter((o) => /^yes\.?$/i.test(o.label.trim()) && !o.typed);
  const no = choice.options.some((o) => /^no\b/i.test(o.label.trim()));
  return yes.length === 1 && no ? yes[0].key : null;
}

/** One line for a call: the command, else the path or URL, else the tool. */
export function callLine(tool: string, input: Record<string, unknown>): string {
  const detail = str(input.command) ?? pathOf(input) ?? str(input.url) ?? str(input.pattern);
  const line = detail ? detail.replace(/\s+/g, " ").trim() : "";
  const cut = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  return cut ? `${tool}: ${cut}` : tool;
}
