// The SDK client (step A2), pointed at the loopback proxy (step A1). The webview never
// holds the API key: `apiKey` is this launch's proxy token, which the proxy swaps for
// the real key. `dangerouslyAllowBrowser` only silences the SDK's browser warning;
// nothing secret is in the page.
//
// Every call says what it is for in `x-wb-purpose`, which the proxy records in the
// ledger and strips before forwarding. The main thread sends `thread`: at the budget
// cap that is what the proxy refuses while Haiku primitives keep running.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getProxyInfo } from "../ipc/assistant";
import { PRIMITIVES, PRIMITIVE_MODEL, type PrimitiveName } from "./prompt";

export const THREAD_PURPOSE = "thread";
/** The proxy's error type for a call refused at the budget cap. */
export const CAP_ERROR = "budget_exceeded";

let client: Promise<Anthropic> | null = null;

/** The app's client, built on first use. */
export function getClient(): Promise<Anthropic> {
  client ??= getProxyInfo()
    .then(
      ({ baseUrl, token }) =>
        new Anthropic({
          baseURL: baseUrl,
          apiKey: token,
          dangerouslyAllowBrowser: true,
        }),
    )
    .catch((e: unknown) => {
      client = null; // try again next time (e.g. the hook server came up late)
      throw e;
    });
  return client;
}

export function purpose(p: string): { headers: Record<string, string> } {
  return { headers: { "x-wb-purpose": p } };
}

/** The proxy's budget refusal, if `err` is one. */
export function capMessage(err: unknown): string | null {
  if (!(err instanceof Anthropic.APIError) || err.status !== 402) return null;
  const body = err.error as { error?: { type?: string; message?: string } };
  if (body?.error?.type !== CAP_ERROR) return null;
  return body.error.message ?? "Duck's monthly API budget is used up.";
}

/** A short, human message for any error from a call. */
export function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** One call with structured output (or plain text without `schema`). */
export interface StructuredRequest<S extends z.ZodType> {
  model: string;
  system: string;
  input: string;
  maxTokens: number;
  think: boolean;
  /** The call's `x-wb-purpose`. */
  purpose: string;
  schema?: S;
  signal?: AbortSignal;
}

export async function structured<S extends z.ZodType = z.ZodString>(
  r: StructuredRequest<S>,
): Promise<z.infer<S>> {
  const c = await getClient();
  const format = r.schema && {
    type: "json_schema" as const,
    schema: z.toJSONSchema(r.schema) as Record<string, unknown>,
  };
  const msg = await c.messages.create(
    {
      model: r.model,
      max_tokens: r.maxTokens,
      system: r.system,
      thinking: { type: r.think ? "adaptive" : "disabled" },
      output_config: { effort: "low", ...(format && { format }) },
      messages: [{ role: "user", content: r.input }],
    },
    { ...purpose(r.purpose), signal: r.signal },
  );
  if (msg.stop_reason === "refusal") throw new Error(`${r.purpose}: refused`);
  // Cut-off JSON won't parse; cut-off text (a title) is still usable.
  if (msg.stop_reason === "max_tokens" && r.schema) throw new Error(`${r.purpose}: the reply was cut off`);
  const text = msg.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return (r.schema ? r.schema.parse(JSON.parse(text)) : text) as z.infer<S>;
}

/**
 * One Haiku call with a frozen prompt (`PRIMITIVES[name]`), for background jobs
 * that need no judgment: titles, summaries, rewrites. With `schema`, the reply is
 * constrained to it (structured output) and parsed; without, it's the reply text.
 */
export function oneShot<S extends z.ZodType = z.ZodString>(
  name: PrimitiveName,
  input: string,
  opts: { schema?: S; signal?: AbortSignal } = {},
): Promise<z.infer<S>> {
  const p = PRIMITIVES[name];
  return structured({
    model: PRIMITIVE_MODEL,
    system: p.system,
    input,
    maxTokens: p.maxTokens,
    think: p.think,
    purpose: name,
    schema: opts.schema,
    signal: opts.signal,
  });
}
