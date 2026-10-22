// Promotion (step T3): fewer prompts over time. When Duck has approved the same
// kind of Claude Code call `PROMOTE_AT` times in a project (by a rule or the judge,
// in shadow mode too: then it was left to you), the decisions view offers to
// promote it:
//
//   to Claude Code   its pattern goes on the project's own allow list
//                    (`.claude/settings.local.json` `permissions.allow`), shown as a
//                    diff first, so Claude Code stops asking at all;
//   to a Duck rule   an allow rule for the project, so Duck answers it at once,
//                    without the judge.
//
// The pattern is "make a rule"'s (`suggestRule`): a command's first words, a file
// tool's folder, a host. A bare tool name is never offered (it would allow every
// call of the tool). An offer you take or dismiss is settled and isn't made again.
// Per project only: Claude Code's user-level settings are never touched.

import type { DecisionRow } from "../../ipc/assistant";
import type { ProjectRef } from "../port";
import type { TrustConfig } from "./decide";
import { suggestRule } from "./rules";
import type { TrustStore } from "./store";

/** Approvals of one pattern in one project before it's offered. */
export const PROMOTE_AT = 3;
/** How many of the newest decisions are counted. */
export const TALLY_ROWS = 2000;

export interface Promotion {
  /** `<projectId> <pattern>`: what settles it. */
  key: string;
  projectId: string;
  pattern: string;
  /** Approvals counted. */
  count: number;
  /** Of them, decided in shadow mode (you answered the prompt). */
  shadow: number;
  /** The latest, epoch ms. */
  last: number;
  /** One of the calls, as the log says it. */
  example: string;
  /** A Duck allow rule covers it already: only Claude Code's list is offered. */
  ruled: boolean;
}

export interface PromotionPreview {
  key: string;
  /** The file it would change, for the view. */
  path: string;
  /** Its text now; null when there is none. */
  before: string | null;
  after: string;
  /** The pattern is on the list already. */
  already: boolean;
}

export const promotionKey = (projectId: string, pattern: string) => `${projectId} ${pattern}`;

/** A pattern narrow enough for an allow list: `Tool(something)`. */
const narrow = (p: string) => /^[A-Za-z][\w-]*\(.+\)$/.test(p);

/** The offers in `rows` (newest first), most approved first. */
export function promotions(rows: readonly DecisionRow[], cfg: TrustConfig, settled: readonly string[]): Promotion[] {
  const by = new Map<string, Promotion>();
  for (const r of rows) {
    if (!r.threadId.startsWith("session:") || r.decision !== "allow" || !r.projectId) continue;
    if (r.layer !== "rule" && r.layer !== "judge") continue;
    if (r.tool.startsWith("assistant:")) continue;
    const pattern = suggestRule(r.tool, r.input);
    if (!narrow(pattern)) continue;
    const key = promotionKey(r.projectId, pattern);
    const p = by.get(key);
    if (p) {
      p.count++;
      if (r.shadow) p.shadow++;
      p.last = Math.max(p.last, r.ts);
    } else
      by.set(key, {
        key,
        projectId: r.projectId,
        pattern,
        count: 1,
        shadow: r.shadow ? 1 : 0,
        last: r.ts,
        example: r.summary,
        ruled: false,
      });
  }
  const done = new Set(settled);
  return [...by.values()]
    .filter((p) => p.count >= PROMOTE_AT && !done.has(p.key))
    .map((p) => ({
      ...p,
      ruled: cfg.rules.some(
        (x) => x.effect === "allow" && x.pattern === p.pattern && (x.projectId === null || x.projectId === p.projectId),
      ),
    }))
    .sort((a, b) => b.count - a.count || b.last - a.last);
}

/** The indent a JSON file uses (its first indented line), two spaces by default. */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

/**
 * `text` (a settings file, null when there is none) with `pattern` on its
 * `permissions.allow` list; everything else is kept. Throws when the file isn't a
 * JSON object, or its `permissions` / `allow` aren't what Claude Code reads.
 */
export function withAllow(text: string | null, pattern: string): { text: string; already: boolean } {
  let doc: unknown = {};
  if (text !== null && text.trim()) {
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error("the file isn't valid JSON: fix it by hand first");
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the file isn't a JSON object");
  const d = doc as Record<string, unknown>;
  const perms = d.permissions ?? {};
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) throw new Error("its `permissions` isn't an object");
  const p = perms as Record<string, unknown>;
  const allow = p.allow ?? [];
  if (!Array.isArray(allow)) throw new Error("its `permissions.allow` isn't a list");
  if (allow.includes(pattern)) return { text: text ?? "", already: true };
  p.allow = [...allow, pattern];
  d.permissions = p;
  return { text: `${JSON.stringify(d, null, text ? indentOf(text) : 2)}\n`, already: false };
}

/** A line diff of two small texts (the preview's), unchanged lines included. */
export function lineDiff(a: string, b: string): { op: " " | "-" | "+"; text: string }[] {
  const x = a ? a.replace(/\n$/, "").split("\n") : [];
  const y = b.replace(/\n$/, "").split("\n");
  // The longest common subsequence, from the end.
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { op: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ op: " ", text: x[i++] });
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  return out;
}

/** The settings the promoter keeps: the offers taken or dismissed. */
export interface PromoterDeps {
  trust: Pick<TrustStore, "config" | "decisions" | "subscribe" | "addRule">;
  projects(): ProjectRef[];
  settled(): readonly string[];
  settle(keys: string[]): Promise<void>;
  readSettings(root: string): Promise<string | null>;
  /** Refused (`stale:`) when the file isn't `expected` any more. */
  writeSettings(root: string, text: string, expected: string | null): Promise<void>;
}

export interface Promoter {
  list(): Promotion[];
  /** What promoting it to Claude Code would write. */
  preview(key: string): Promise<PromotionPreview>;
  /** Promote it: to Claude Code's allow list (from the `before` the preview
   *  showed), or as a Duck rule. Either settles it. */
  promote(key: string, to: "claude" | "rule", before?: string | null): Promise<string>;
  dismiss(key: string): Promise<void>;
  /** Hear the list change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export function createPromoter(deps: PromoterDeps): Promoter {
  let rows: DecisionRow[] = [];
  let last = "";
  const listeners = new Set<() => void>();
  const list = () => promotions(rows, deps.trust.config(), deps.settled());
  /** Tell the listeners when the offers changed. */
  const changed = () => {
    const now = JSON.stringify(list().map((p) => [p.key, p.count, p.ruled]));
    if (now === last) return;
    last = now;
    for (const l of listeners) l();
  };
  deps.trust.subscribe(({ decision }) => {
    if (decision) rows = [decision, ...rows].slice(0, TALLY_ROWS);
    changed();
  });
  void deps.trust
    .decisions(null, TALLY_ROWS)
    .then((r) => {
      const seen = new Set(rows.map((x) => x.id));
      rows = [...rows, ...r.filter((x) => !seen.has(x.id))].slice(0, TALLY_ROWS);
      changed();
    })
    .catch((e: unknown) => console.warn("duck: the decisions weren't counted for promotion", e));

  const find = (key: string) => {
    const p = list().find((x) => x.key === key);
    if (!p) throw new Error("That suggestion isn't open any more.");
    const project = deps.projects().find((x) => x.id === p.projectId);
    if (!project) throw new Error("Its project isn't in Workbench any more.");
    if (project.remote) throw new Error(`${project.name} is a remote project: its settings are on the other machine.`);
    return { p, project };
  };
  const settle = async (key: string) => {
    await deps.settle([...new Set([...deps.settled(), key])]);
    changed();
  };

  return {
    list,
    async preview(key) {
      const { p, project } = find(key);
      const before = await deps.readSettings(project.rootPath);
      const next = withAllow(before, p.pattern);
      return { key, path: `${project.rootPath}/.claude/settings.local.json`, before, after: next.text, already: next.already };
    },
    async promote(key, to, before = null) {
      const { p, project } = find(key);
      if (to === "rule") {
        await deps.trust.addRule("allow", p.pattern, p.projectId);
        await settle(key);
        return `allow ${p.pattern} is a Duck rule for ${project.name}`;
      }
      const next = withAllow(before, p.pattern);
      if (!next.already) await deps.writeSettings(project.rootPath, next.text, before);
      await settle(key);
      return `${p.pattern} is on ${project.name}'s Claude Code allow list`;
    },
    async dismiss(key) {
      await settle(key);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
