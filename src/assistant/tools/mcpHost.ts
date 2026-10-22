// The hosted MCP servers' tools (step B2): each opted-in stdio server from your
// Claude Code config (`settings.mcpHost`) lends Duck its tools as
// `<server>__<tool>`, built from its cached list (`hostedTools`) and registered
// deferred (`Registry.setExternal`). What a server returns is another app's data,
// so it comes back wrapped as untrusted, as X1's does.
//
// Your Firefox bridge (`settings.firefox.server`) gets tiers by tool:
// - **read:** listing browsers, tabs, windows, history and bookmarks; a page's text,
//   HTML, snapshot or screenshot;
// - **in-app** (reversible: runs without asking): navigating, tabs, clicking,
//   typing, keys;
// - **consequential:** uploading a file, running a script, changing bookmarks or
//   history, pasting your own clipboard, and any tool not listed here;
// - **by the element:** a click, a submitted field or an Enter on something that
//   reads as submit, pay, log in, or send (from its text, its selector, or what
//   the tab's last snapshot said about its ref) is consequential; logging in,
//   paying and sending also trip the floor (`browser login|payment|send`), so they
//   always ask. Typing into a password, card or one-time-code field is refused
//   outright: Duck never types credentials (`browser_login` hands that to you).
//
// `browsers_select` isn't offered: the host keeps each thread in its profile
// (`browser.ts`), which `use_personal_browser`, `use_agent_browser` and the login
// card change. Every browser result names the profile it ran in, for the chip.
//
// Another server's tools are read when the server marks them `readOnlyHint`, and
// consequential otherwise (a rule like `assistant:<server>__<tool>` can allow one).

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { HostedTool } from "../../ipc/mcpHost";
import { hostedDescription, personalAllowed, siteOf, textOf, type BrowserHost, type McpCallResult, type Profile } from "../browser";
import { defineTool, type Tier, type ToolDef, type ToolContext, type ToolOutput } from "./registry";

/** What the hosted tools call through (`ToolContext.hosted`). */
export interface HostedCaller {
  call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  browser: BrowserHost;
}

const TIMEOUT_MS = 60_000;

const BROWSER_READ = new Set([
  "browsers_list",
  "tabs_list",
  "tabs_groups_query",
  "list_windows",
  "get_window",
  "get_current_window",
  "history_get_recent",
  "history_query",
  "bookmarks_list",
  "bookmarks_search",
  "content_get_text",
  "content_get_html",
  "content_snapshot",
  "tabs_capture_screenshot",
  "requests_list_captured",
  "requests_get_content",
  "debug_websocket_status",
]);

const BROWSER_IN_APP = new Set([
  "navigation_go_to_url",
  "navigation_back",
  "navigation_forward",
  "navigation_reload",
  "tabs_create",
  "tabs_switch",
  "tabs_close",
  "tabs_move",
  "tabs_group",
  "tabs_ungroup",
  "tabs_groups_update",
  "tabs_release",
  "create_window",
  "focus_window",
  "update_window",
  "close_window",
  "content_click",
  "content_type",
  "content_press_key",
  "content_hover",
  "content_drag",
  "content_copy_image",
  "content_paste",
  "requests_start_monitoring",
  "requests_stop_monitoring",
]);

/** Duck's, not the model's (`browser.ts`). */
const BROWSER_HIDDEN = new Set(["browsers_select"]);

const LOGIN = /\b(?:log\s*-?\s*in|sign\s*-?\s*in|sign\s*on|password|passcode|войти|вход|пароль|anmelden)\b/i;
const PAY = /\b(?:pay|payment|checkout|check\s*out|buy(?:\s+now)?|purchase|place\s+(?:your\s+)?order|subscribe|donate|оплат\w*|купить)\b/i;
const SEND = /\b(?:send|post|publish|reply|comment|tweet|отправить|опубликовать)\b/i;
const SUBMIT = /\b(?:submit|confirm|save|delete|remove|accept|approve|apply)\b|type=["']?submit/i;
const SECRET_FIELD = /\b(?:password|passcode|passwort|пароль|cvv|cvc|card\s*number|security\s*code|one-?time\s*(?:code|password)|otp|2fa|pin)\b|type=["']?password/i;

export type Sensitive = "login" | "payment" | "send";

export interface BrowserCallClass {
  tier: Tier;
  /** Trips the floor: always asks. */
  floor?: Sensitive;
  /** Refused before any card. */
  refuse?: string;
  /** What the call acts on, for the card. */
  target?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A browser call's tier, from the tool and what it acts on. */
export function classifyBrowserCall(
  tool: string,
  args: Record<string, unknown>,
  refLine: (tabId: unknown, ref: unknown) => string | undefined,
): BrowserCallClass {
  if (BROWSER_READ.has(tool)) return { tier: "read" };
  if (!BROWSER_IN_APP.has(tool)) return { tier: "consequential" };
  const target = [str(args.text), str(args.field), str(args.selector), refLine(args.tab_id, args.ref) ?? ""]
    .filter(Boolean)
    .join(" · ");
  const sensitive = (s: string): Sensitive | undefined =>
    LOGIN.test(s) ? "login" : PAY.test(s) ? "payment" : SEND.test(s) ? "send" : undefined;
  const t = target || undefined;
  switch (tool) {
    case "content_type": {
      const field = [str(args.field), str(args.selector), refLine(args.tab_id, args.ref) ?? ""].join(" ");
      if (SECRET_FIELD.test(field))
        return {
          tier: "consequential",
          refuse:
            "Duck never types passwords, card numbers or one-time codes. For a login, call browser_login so the user logs in themselves; anything else secret, ask the user to type it.",
        };
      if (args.submit === true) {
        const s = sensitive(field);
        return { tier: "consequential", ...(s && { floor: s }), target: t };
      }
      return { tier: "reversible", target: t };
    }
    case "content_click": {
      const s = sensitive(target);
      if (s) return { tier: "consequential", floor: s, target: t };
      return { tier: SUBMIT.test(target) ? "consequential" : "reversible", target: t };
    }
    case "content_press_key": {
      if (args.allow_clipboard === true) return { tier: "consequential", target: t };
      if (!/^enter$/i.test(str(args.key))) return { tier: "reversible", target: t };
      const s = sensitive(target);
      return { tier: "consequential", ...(s && { floor: s }), target: t };
    }
    case "content_paste":
      return { tier: args.allow_clipboard === true ? "consequential" : "reversible", target: t };
    default:
      return { tier: "reversible", target: t };
  }
}

/** `server` as a tool-name prefix: lowercase letters, digits and `_`. */
export function namespaceOf(server: string): string {
  return server.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "mcp";
}

/** The API name of a hosted tool, or null when it can't be one. */
export function apiName(server: string, tool: string): string | null {
  const name = `${namespaceOf(server)}__${tool.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : null;
}

const attr = (v: string) => v.replace(/["<>]/g, "");

/** A hosted result as tool output: its text wrapped as untrusted (the profile it
 *  ran in, for a browser call), its images as they are. */
export function hostedOutput(server: string, tool: string, r: McpCallResult, profile?: Profile): ToolOutput {
  const text = textOf(r).replace(/<\/mcp_result>/gi, "</mcp_result_>");
  const open = `<mcp_result server="${attr(server)}" tool="${attr(tool)}"${profile ? ` profile="${profile}"` : ""} untrusted>`;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: `${open}\n${text || "(no text)"}\n</mcp_result>` }];
  for (const b of r.content ?? []) {
    if (b?.type !== "image" || typeof b.data !== "string") continue;
    const media = b.mimeType === "image/jpeg" || b.mimeType === "image/gif" || b.mimeType === "image/webp" ? b.mimeType : "image/png";
    blocks.push({ type: "image", source: { type: "base64", media_type: media, data: b.data } });
  }
  return blocks.length === 1 ? (blocks[0] as { text: string }).text : (blocks as ToolOutput);
}

function hosted(ctx: ToolContext): HostedCaller {
  if (!ctx.hosted) throw new Error("Duck's MCP host isn't available here.");
  return ctx.hosted;
}

function argsLine(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s === "{}" ? "" : s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

const SENSITIVE_WORDS: Record<Sensitive, string> = { login: "logging in", payment: "paying", send: "sending something" };

/** A server's tools as Duck's (`<server>__<tool>`). `isBrowser`: the Firefox
 *  bridge's tiers and profiles. */
export function hostedTools(
  server: string,
  tools: readonly HostedTool[],
  opts: { isBrowser: boolean; refLine?: BrowserHost["refLine"] },
): ToolDef[] {
  const refLine = opts.refLine ?? (() => undefined);
  const out: ToolDef[] = [];
  for (const t of tools) {
    if (opts.isBrowser && BROWSER_HIDDEN.has(t.name)) continue;
    const name = apiName(server, t.name);
    if (!name) continue;
    const schema = t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
    const classify = (input: Record<string, unknown>): BrowserCallClass =>
      opts.isBrowser
        ? classifyBrowserCall(t.name, input, refLine)
        : { tier: t.annotations?.readOnlyHint === true ? "read" : "consequential" };
    const prefix = opts.isBrowser ? `[Firefox, through Duck's bridge] ` : `[${server}, a local MCP server] `;
    out.push(
      defineTool({
        name,
        description: prefix + hostedDescription(t),
        schema: z.record(z.string(), z.unknown()),
        inputSchema: schema,
        tier: opts.isBrowser ? (BROWSER_READ.has(t.name) ? "read" : BROWSER_IN_APP.has(t.name) ? "reversible" : "consequential") : classify({}).tier,
        tierFor: (input) => classify(input).tier,
        timeoutMs: TIMEOUT_MS,
        async prepare(input) {
          const c = classify(input);
          if (c.refuse) throw new Error(c.refuse);
          return undefined;
        },
        describe(input) {
          const c = classify(input);
          if (c.floor) return `${server}: ${t.name} on "${c.target ?? "?"}", which looks like ${SENSITIVE_WORDS[c.floor]}`;
          const line = argsLine(input);
          return `${server}: ${t.name}${line ? ` ${line}` : ""}`;
        },
        trust(input) {
          const c = classify(input);
          return {
            projectId: null,
            specifier: `${server}:${t.name}`,
            ...(c.floor && { texts: [`browser ${c.floor}: ${c.target ?? ""}`] }),
          };
        },
        async run(input, ctx) {
          const h = hosted(ctx);
          if (opts.isBrowser) {
            const { result, profile } = await h.browser.run(ctx.threadId, ctx.settings.firefox, t.name, input, TIMEOUT_MS - 2_000);
            if (result.isError) throw new Error(`${t.name} failed (${profile} profile): ${textOf(result)}`);
            return hostedOutput(server, t.name, result, profile);
          }
          const r = ((await h.call(server, t.name, input, TIMEOUT_MS - 2_000)) ?? {}) as McpCallResult;
          if (r.isError) throw new Error(`${server}: ${t.name} failed: ${textOf(r)}`);
          return hostedOutput(server, t.name, r);
        },
      }) as ToolDef,
    );
  }
  return out;
}

// ── the profiles and the login card ─────────────────────────────────────────

function firefoxOn(ctx: Pick<ToolContext, "settings">) {
  const fx = ctx.settings.firefox;
  if (!ctx.settings.mcpHost.includes(fx.server))
    throw new Error("Firefox isn't set up for Duck: turn the firefox server on in Duck's settings (skills → MCP servers).");
  return fx;
}

const siteArg = z
  .string()
  .max(300)
  .optional()
  .describe("The site it's for (a URL or host, e.g. youtrack.example.com), so the card and the rules can name it.");

interface PersonalPrepared {
  site: string | null;
  /** On the settings' site list: runs unasked. */
  listed: boolean;
}

export const usePersonalBrowser = defineTool({
  name: "use_personal_browser",
  description:
    "Move this conversation's browser work to the user's personal Firefox profile, where they're logged in to their own accounts (e.g. their YouTrack, their bank's read-only pages). The agent profile is the default; use this only when the task needs the user's own logged-in session or tabs, and say why. The user is asked unless a rule or their site list allows it. Back with use_agent_browser.",
  schema: z.object({
    reason: z.string().min(3).max(300).describe('Why the personal profile, in a few words: "needs your logged-in YouTrack".'),
    site: siteArg,
  }),
  tier: "consequential",
  // A site on the settings' list runs unasked.
  tierFor: (_input, _port, prepared?: PersonalPrepared) => (prepared?.listed ? "reversible" : "consequential"),
  async prepare({ site }, _port, env): Promise<PersonalPrepared> {
    const fx = env?.settings.firefox;
    return { site: siteOf(site), listed: !!fx && personalAllowed(siteOf(site), fx.personalSites) };
  },
  describe: ({ reason }, _port, prepared) =>
    `Use your personal Firefox profile${prepared?.site ? ` for ${prepared.site}` : ""}: ${reason}`,
  trust: (_input, _port, prepared) => ({
    projectId: null,
    asTool: "assistant:firefox",
    specifier: `profile:personal${prepared?.site ? `@${prepared.site}` : ""}`,
  }),
  async run(_input, ctx) {
    const fx = firefoxOn(ctx);
    const h = hosted(ctx);
    if (!(await h.browser.connected(fx, "personal")))
      throw new Error(
        fx.personalBrowser
          ? `Your personal profile ("${fx.personalBrowser}") isn't connected to the bridge right now: is that Firefox open, with the add-on?`
          : "Your personal profile isn't set up for Duck yet: install the bridge add-on in it and name it in Duck's settings (skills → Firefox).",
      );
    h.browser.setProfile(ctx.threadId, "personal");
    return "This conversation's browser calls now run in the user's personal Firefox profile. Their own accounts and tabs: read what the task needs, change nothing they didn't ask for, and move back with use_agent_browser when done.";
  },
});

export const useAgentBrowser = defineTool({
  name: "use_agent_browser",
  description: "Move this conversation's browser work back to the agent Firefox profile (the default).",
  schema: z.object({}),
  tier: "reversible",
  run(_input, ctx) {
    hosted(ctx).browser.setProfile(ctx.threadId, "agent");
    return "Browser calls run in the agent profile again.";
  },
});

export const LOGIN_CHOICES = [
  { id: "agent", label: "I'll log in in the agent profile" },
  { id: "personal", label: "Use my personal profile" },
] as const;

export const browserLogin = defineTool({
  name: "browser_login",
  description:
    "A page needs the user to log in. Never type a password or a code yourself: call this, and the user chooses on a card to log in in the agent profile themselves (Duck opens the page there), to use their personal profile instead, or to skip. Then wait for them, or carry on as the result says.",
  schema: z.object({
    url: z.string().min(1).max(2_000).describe("The login page, or the page that needs the login."),
    why: z.string().min(3).max(300).describe("What you were doing that needs it."),
  }),
  tier: "consequential",
  choices: LOGIN_CHOICES,
  denyLabel: "Skip",
  async prepare() {
    return {} as { choice?: string };
  },
  describe: ({ url, why }) => `${siteOf(url) ?? url} needs you to log in (${why})`,
  trust: ({ url }) => ({
    projectId: null,
    specifier: siteOf(url) ?? undefined,
    asks: "a login: you choose how",
  }),
  async run({ url }, ctx) {
    const fx = firefoxOn(ctx);
    const h = hosted(ctx);
    const choice = (ctx.prepared as { choice?: string } | undefined)?.choice ?? "agent";
    if (choice === "personal") {
      if (!(await h.browser.connected(fx, "personal")))
        throw new Error("The user chose their personal profile, but it isn't connected to the bridge: tell them, and ask how to go on.");
      h.browser.setProfile(ctx.threadId, "personal");
      return "The user chose their personal profile, where they're logged in. This conversation's browser calls now run there: go on with the task. Back with use_agent_browser when done.";
    }
    h.browser.setProfile(ctx.threadId, "agent");
    const { result } = await h.browser.run(ctx.threadId, fx, "tabs_create", { url, active: true }, TIMEOUT_MS - 2_000);
    if (result.isError) throw new Error(`opening ${url} failed: ${textOf(result)}`);
    return `Opened ${url} in the agent profile for the user to log in themselves (${textOf(result).slice(0, 200)}). Tell them in a few words, and wait: go on only when they say they're logged in. The login stays in that profile for next time.`;
  },
});

export const BROWSER_TOOLS = [usePersonalBrowser, useAgentBrowser, browserLogin];
