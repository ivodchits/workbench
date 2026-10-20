import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { callCost, runApiWorker, type ApiCall } from "./apiWorker";

type Block = Anthropic.Beta.BetaContentBlock;

const usage = (o: Partial<Anthropic.Beta.BetaUsage> = {}) =>
  ({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o }) as Anthropic.Beta.BetaUsage;

const reply = (stop: string, content: Block[], model = "claude-sonnet-5-5") =>
  ({ model, stop_reason: stop, content, usage: usage() }) as unknown as Anthropic.Beta.BetaMessage;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const submit = (input: unknown) => ({ type: "tool_use", id: "tu1", name: "submit_result", input }) as Block;

const RESULT = { status: "done", headline: "Use the plugin.", question: null, markdown: "# Use the plugin" };

/** A call that answers from a script and records what it was sent. */
function scripted(replies: Anthropic.Beta.BetaMessage[]) {
  const sent: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const call: ApiCall = (params) => {
    sent.push(structuredClone(params));
    const r = replies.shift();
    if (!r) throw new Error("no more replies");
    return Promise.resolve(r);
  };
  return { call, sent };
}

const last = <T>(xs: T[]) => xs[xs.length - 1];

const task = { title: "Updater", model: "sonnet", effort: "high" };

describe("API worker", () => {
  it("runs the tier's model with the web tools and returns what it submitted", async () => {
    const { call, sent } = scripted([reply("tool_use", [text("Done."), submit(RESULT)])]);
    const o = await runApiWorker(task, "Find the best updater.", call);
    expect(o.result).toEqual(RESULT);
    expect(sent[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      fallbacks: "default",
      messages: [{ role: "user", content: "# Updater\n\nFind the best updater." }],
    });
    expect(sent[0].tools).toMatchObject([
      { type: "web_search_20260209" },
      { type: "web_fetch_20260209" },
      { name: "submit_result", strict: true },
    ]);
    expect(o.costUsd).toBeCloseTo(0.003);
  });

  it("carries on a paused server turn, sending it back as it is", async () => {
    const paused = reply("pause_turn", [text("searching")]);
    const { call, sent } = scripted([paused, reply("tool_use", [submit(RESULT)])]);
    await runApiWorker(task, "b", call);
    expect(sent).toHaveLength(2);
    expect(last(sent[1].messages)).toEqual({ role: "assistant", content: paused.content });
  });

  it("asks once for the result, then takes a text answer as it is", async () => {
    const { call, sent } = scripted([reply("end_turn", [text("Some answer")]), reply("end_turn", [text("## Headline here\nBody")])]);
    const o = await runApiWorker(task, "b", call);
    expect(last(sent[1].messages)).toEqual({ role: "user", content: "Call submit_result now with the whole result." });
    expect(o.result).toEqual({ status: "done", headline: "Headline here", question: null, markdown: "## Headline here\nBody" });
  });

  it("sends an invalid result back as an error", async () => {
    const { call, sent } = scripted([reply("tool_use", [submit({ status: "great" })]), reply("tool_use", [submit(RESULT)])]);
    const o = await runApiWorker(task, "b", call);
    expect(o.result.headline).toBe("Use the plugin.");
    const back = last(sent[1].messages)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(back[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1", is_error: true });
  });

  it("fails on a refusal; Haiku gets the basic web tools and no fallbacks", async () => {
    const { call } = scripted([reply("refusal", [])]);
    await expect(runApiWorker(task, "b", call)).rejects.toThrow(/declined/);
    const h = scripted([reply("tool_use", [submit(RESULT)])]);
    await runApiWorker({ ...task, model: "haiku" }, "b", h.call);
    expect(h.sent[0]).not.toHaveProperty("fallbacks");
    expect(h.sent[0].tools![0]).toMatchObject({ type: "web_search_20250305" });
  });

  it("prices calls like the proxy does, searches included", () => {
    expect(callCost("claude-opus-5-5", usage({ input_tokens: 1e6, output_tokens: 0 }))).toBeCloseTo(4);
    expect(
      callCost("claude-sonnet-5-5", usage({ input_tokens: 0, output_tokens: 1e6, server_tool_use: { web_search_requests: 3 } } as never)),
    ).toBeCloseTo(10.03);
  });
});
