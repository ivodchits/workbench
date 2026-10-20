// Trust rules (step T1), in Claude Code's own permission syntax so a rule reads
// the same in both places: `Tool` or `Tool(specifier)`.
//
//   Bash(npm test:*)          a command and everything after it (`:*` is a prefix)
//   Bash(git log *)           `*` matches anything, anywhere
//   Edit(src/**)              a path glob, relative to the project root
//   Read(//etc/hosts)         `//` is an absolute path, `~/` the home folder
//   WebFetch(domain:docs.rs)  a host (and its subdomains)
//   assistant:write_note      one of Duck's own tools
//   assistant:answer_choice(question)
//                             with what the tool says about the call (its
//                             "specifier": here the kind of prompt it answers)
//
// Precedence is Claude Code's: deny beats ask beats allow, whatever the order.

/** What a rule does when it matches. */
export type Effect = "allow" | "ask" | "deny";

export interface Rule {
  id: string;
  effect: Effect;
  pattern: string;
  /** null: a global rule. */
  projectId: string | null;
  created: number;
}

export interface ParsedRule {
  /** The tool name, or a glob over it (`assistant:*`, `mcp__github__*`). */
  tool: string;
  specifier: string | null;
}

/** The call a rule is matched against. */
export interface RuleTarget {
  /** `assistant:<tool>` for Duck's own tools, Claude Code's name otherwise. */
  tool: string;
  projectId: string | null;
  /** Duck's tools: what the tool says about the call. */
  specifier?: string;
  /** Bash: the command line. */
  command?: string;
  /** File tools: the path, absolute or relative to `root`. */
  path?: string;
  /** WebFetch: the URL. */
  url?: string;
  /** The project root, for relative path rules. */
  root?: string;
  /** The home folder, for `~/` rules. */
  home?: string;
}

const RULE = /^([A-Za-z_*][\w*:.-]*)(?:\((.*)\))?$/s;

/** Parse a rule's pattern; throws an Error saying what's wrong. */
export function parseRule(pattern: string): ParsedRule {
  const m = RULE.exec(pattern.trim());
  if (!m) throw new Error(`"${pattern}" isn't a rule: write Tool or Tool(specifier).`);
  const specifier = m[2] === undefined ? null : m[2].trim();
  if (specifier === "") throw new Error(`"${pattern}" has an empty specifier: leave out the parentheses.`);
  return { tool: m[1], specifier };
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `*` matches anything (the rest of the string, spaces and slashes included). */
function wildcard(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map(escape).join(".*")}$`, "s");
}

/** A path glob: `**` crosses folders, `*` stays within one. */
function pathGlob(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches no folder too, so `src/**/x` covers `src/x`.
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  return new RegExp(`^${re}$`, "i");
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** An absolute path for a rule's glob (or a target's path), forward slashes. */
function absolute(p: string, root: string | undefined, home: string | undefined): string | null {
  const s = slashes(p);
  // `//C:/x` is a Windows path: drop the slash before the drive.
  if (s.startsWith("//")) return s.slice(1).replace(/^\/([A-Za-z]:\/)/, "$1");
  if (s.startsWith("~/")) return home ? `${slashes(home)}${s.slice(1)}` : null;
  if (/^([A-Za-z]:)?\//.test(s)) return s;
  return root ? `${slashes(root)}/${s.replace(/^\.\//, "")}` : null;
}

function bashMatch(spec: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, " ");
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2).trim();
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  return wildcard(spec.trim().replace(/\s+/g, " ")).test(cmd);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"]);

/** Whether one parsed rule covers the target (its scope is checked by `evaluate`). */
export function matches(rule: ParsedRule, t: RuleTarget): boolean {
  if (!wildcard(rule.tool).test(t.tool)) return false;
  const spec = rule.specifier;
  if (spec === null) return true;
  if (t.tool === "Bash") return t.command !== undefined && bashMatch(spec, t.command);
  if (t.tool === "WebFetch" && spec.startsWith("domain:")) {
    const want = spec.slice(7).trim().toLowerCase();
    const host = t.url && hostOf(t.url);
    return !!host && (host === want || host.endsWith(`.${want}`));
  }
  if (PATH_TOOLS.has(t.tool)) {
    if (!t.path) return false;
    const glob = absolute(spec, t.root, t.home);
    const path = absolute(t.path, t.root, t.home);
    return !!glob && !!path && pathGlob(glob).test(path);
  }
  return t.specifier !== undefined && wildcard(spec).test(t.specifier);
}

export interface RuleHit {
  effect: Effect;
  rule: Rule;
}

const RANK: Record<Effect, number> = { deny: 3, ask: 2, allow: 1 };

/** The rule that decides the target: global rules and the target project's, deny
 *  over ask over allow. A rule that doesn't parse never matches. */
export function evaluate(rules: readonly Rule[], t: RuleTarget): RuleHit | null {
  let best: RuleHit | null = null;
  for (const r of rules) {
    if (r.projectId !== null && r.projectId !== t.projectId) continue;
    let parsed: ParsedRule;
    try {
      parsed = parseRule(r.pattern);
    } catch {
      continue;
    }
    if (!matches(parsed, t)) continue;
    if (!best || RANK[r.effect] > RANK[best.effect]) best = { effect: r.effect, rule: r };
  }
  return best;
}

/** Words that end a Bash rule's prefix: flags, paths, quoted or variable text. */
const NOT_A_WORD = /^[-./~"'$`\\]|[/\\=]/;

/**
 * The rule "make a rule" offers for a logged call: one of Duck's tools as it is;
 * a Bash command by its first words (`Bash(npm test:*)`, at most two, stopping at
 * a flag or a path); a file tool by its folder (`Edit(//C:/app/src/**)`); WebFetch
 * by its host; anything else by its name.
 */
export function suggestRule(tool: string, input: unknown): string {
  if (tool.startsWith("assistant:")) return tool;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "Bash" && typeof i.command === "string") {
    const words = i.command.trim().split(/\s+/);
    const head: string[] = [];
    for (const w of words) {
      if (head.length === 2 || NOT_A_WORD.test(w) || /[;&|<>()]/.test(w)) break;
      head.push(w);
    }
    return head.length ? `Bash(${head.join(" ")}:*)` : "Bash";
  }
  const path = ["file_path", "notebook_path", "path"].map((k) => i[k]).find((v) => typeof v === "string") as
    | string
    | undefined;
  if (PATH_TOOLS.has(tool) && path) {
    const dir = slashes(path).replace(/\/[^/]*$/, "");
    if (dir) return `${tool}(${/^[A-Za-z]:\//.test(dir) ? "//" : ""}${dir}/**)`;
  }
  if (tool === "WebFetch" && typeof i.url === "string") {
    const host = hostOf(i.url);
    if (host) return `WebFetch(domain:${host})`;
  }
  return tool;
}
