import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AssistantRemoteInput } from "../ipc/remote";
import { connectLocal, createHosts, serveHost, type HostDown, type HostUp } from "./hosts";
import { PROTOCOL_VERSION } from "./protocol";
import { startRemoteBridge } from "./remoteBridge";
import { createRegistry, defineTool, toolsOn } from "./tools/registry";

const signal = () => new AbortController().signal;
const declared = (h: string) => new Set(h === "phone" ? ["phone_torch", "phone_volume"] : ["pc_echo"]);

describe("hosts", () => {
  it("counts only the engine's tools of what a host announces, and refuses another version", async () => {
    const hosts = createHosts(declared);
    const sent: HostDown[] = [];
    hosts.connect({ type: "hello", host: "phone", tools: ["phone_torch", "rm_rf"], version: PROTOCOL_VERSION }, (m) => void sent.push(m));
    expect([...hosts.tools("phone")!]).toEqual(["phone_torch"]);
    await expect(hosts.call("phone", "rm_rf", {}, signal())).rejects.toThrow("the phone doesn't offer rm_rf");
    await expect(hosts.call("phone", "phone_volume", {}, signal())).rejects.toThrow("doesn't offer phone_volume");
    expect(sent).toEqual([]);
    expect(() => hosts.connect({ type: "hello", host: "phone", tools: [], version: 99 }, () => {})).toThrow("version 99");
  });

  it("fails the open calls of a host that reconnects", async () => {
    const hosts = createHosts(declared);
    const hello: HostUp = { type: "hello", host: "phone", tools: ["phone_torch"], version: PROTOCOL_VERSION };
    hosts.connect(hello, () => {});
    const p = hosts.call("phone", "phone_torch", {}, signal());
    hosts.connect(hello, () => {});
    await expect(p).rejects.toThrow("the phone reconnected");
  });

  it("serves a host's side: runs what it announced, refuses the rest, aborts on cancel", async () => {
    const up: HostUp[] = [];
    let aborted = false;
    const served = serveHost(
      "phone",
      {
        phone_torch: (input) => ({ lit: (input as { on: boolean }).on }),
        phone_volume: (_, s) => new Promise((_r, reject) => s.addEventListener("abort", () => ((aborted = true), reject(new Error("x"))))),
      },
      (m) => void up.push(m),
    );
    expect(served.hello).toEqual({ type: "hello", host: "phone", tools: ["phone_torch", "phone_volume"], version: PROTOCOL_VERSION });
    served.receive({ type: "device.call", id: "1", tool: "phone_torch", input: { on: true } });
    served.receive({ type: "device.call", id: "2", tool: "toString", input: {} });
    served.receive({ type: "device.call", id: "3", tool: "phone_volume", input: {} });
    await new Promise((r) => setTimeout(r, 0));
    served.receive({ type: "device.cancel", id: "3" });
    await new Promise((r) => setTimeout(r, 0));
    expect(up).toEqual([
      { type: "device.result", id: "2", ok: false, output: "this host has no tool toString" },
      { type: "device.result", id: "1", ok: true, output: { lit: true } },
    ]);
    expect(aborted).toBe(true);
  });

  it("runs the desktop's own tools in process, and a host's error comes back as the call's", async () => {
    const hosts = createHosts(declared);
    expect(hosts.tools("pc")).toBeNull();
    connectLocal(hosts, "pc", {
      pc_echo: (input) => {
        if ((input as { say: string }).say === "") throw new Error("nothing to say");
        return input;
      },
    });
    await expect(hosts.call("pc", "pc_echo", { say: "hi" }, signal())).resolves.toEqual({ say: "hi" });
    await expect(hosts.call("pc", "pc_echo", { say: "" }, signal())).rejects.toThrow("nothing to say");
  });

  it("keeps a host tool's schema in the engine, defers it, and runs it only through a host", () => {
    const echo = defineTool({ name: "pc_echo", description: "Echo.", schema: z.object({}), tier: "read", host: "pc" });
    expect(toolsOn([echo], "pc")).toEqual(new Set(["pc_echo"]));
    const reg = createRegistry([echo]);
    expect(reg.apiTools.map((t) => ("defer_loading" in t ? t.name : t.type))).toEqual(["tool_search_tool_regex_20251119", "pc_echo"]);
    expect(() => defineTool({ name: "pc_x", description: "", schema: z.object({}), tier: "read", host: "pc", run: () => "" })).toThrow(
      "runs on pc",
    );
  });
});

describe("a host over the phone's socket", () => {
  function phoneSocket() {
    const hosts = createHosts(declared);
    let input: (i: AssistantRemoteInput) => void = () => {};
    const down: { frame: unknown; conn: number | null }[] = [];
    startRemoteBridge({
      duck: { handle: () => {}, onEvent: () => () => {} },
      link: { onInput: (cb) => ((input = cb), () => {}), emit: (frame, conn) => void down.push({ frame, conn }), push: () => {} },
      watching: () => false,
      fixVoice: (t) => t,
      prepare: async () => null,
      render: async () => ({ id: "a", seconds: 1 }),
      warm: () => {},
      hosts,
    });
    const send = (conn: number, msg: unknown) => input({ conn, device: "d", kind: "message", msg });
    return { hosts, down, send, close: (conn: number) => input({ conn, device: "d", kind: "close", msg: null }) };
  }

  it("takes the phone as a host, sends its calls to its socket only, and drops it when it closes", async () => {
    const s = phoneSocket();
    s.send(2, { type: "hello", host: "phone", tools: ["phone_torch"], version: PROTOCOL_VERSION });
    const p = s.hosts.call("phone", "phone_torch", { on: true }, signal());
    expect(s.down).toEqual([
      { frame: { type: "device.call", id: expect.any(String), tool: "phone_torch", input: { on: true }, v: PROTOCOL_VERSION }, conn: 2 },
    ]);
    const id = (s.down[0].frame as { id: string }).id;
    s.send(2, { type: "device.result", id, ok: true, output: "on" });
    await expect(p).resolves.toBe("on");
    s.close(2);
    expect(s.hosts.tools("phone")).toBeNull();
  });

  it("refuses the PC's hello from a phone, and a result before any hello", () => {
    const s = phoneSocket();
    s.send(3, { type: "hello", host: "pc", tools: ["pc_echo"], version: PROTOCOL_VERSION });
    s.send(4, { type: "device.result", id: "c1", ok: true, output: null });
    expect(s.hosts.tools("pc")).toBeNull();
    expect(s.down).toEqual([
      { frame: { type: "error", message: "not a host message, or not the phone's", v: PROTOCOL_VERSION }, conn: 3 },
      { frame: { type: "error", message: "say hello first", v: PROTOCOL_VERSION }, conn: 4 },
    ]);
  });
});
