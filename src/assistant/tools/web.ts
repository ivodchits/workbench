// Duck's own web tools (step B1): the API's server-side search and fetch, for quick
// lookups with citations. The server runs them inside the reply, so they have no
// `run` here and never reach the gate: they only read, and the fetch can only open
// a URL that's already in the conversation (the API's rule), so a page can't be
// made to send anything out. Real research still goes to a worker (`run_task`).
//
// The basic versions: X0 measured the dynamic-filtering ones at three times the
// time and more cost for a quick lookup (they add code-execution rounds). Both
// models take them, so a turn on Haiku past the soft limit keeps them.
//
// Built once, so the tools prefix stays byte-identical (the timezone is read once).

import type Anthropic from "@anthropic-ai/sdk";

/** Searches a reply may make. */
export const SEARCH_MAX_USES = 5;
/** Pages a reply may fetch. */
export const FETCH_MAX_USES = 8;
/** A fetched page is cut to this many tokens: it stays in the thread. */
export const FETCH_MAX_TOKENS = 12_000;

function timezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const zone = timezone();

export const WEB_TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: SEARCH_MAX_USES,
    // Local results ("the weather", "near me") follow the user's timezone.
    ...(zone && { user_location: { type: "approximate", timezone: zone } }),
  },
  {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: FETCH_MAX_USES,
    max_content_tokens: FETCH_MAX_TOKENS,
  },
] as Anthropic.Beta.BetaToolUnion[];

export const WEB_TOOL_NAMES: readonly string[] = ["web_search", "web_fetch"];
