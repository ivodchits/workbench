import { describe, expect, it } from "vitest";

import { createBrowserHost, DEFAULT_FIREFOX, findBrowser, parseBrowsers, personalAllowed, siteOf, START_WAIT_MS } from "./browser";

const LIST = `Connected browsers (2):
- Firefox 2: id ae62b9aa, add-on 1.11.1, connected 472 min ago
- Ivo: id 0c11dd03, add-on 1.11.1, connected 3 min ago
The selected browser "Firefox 1" is disconnected.`;

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("Firefox's profiles (B2)", () => {
  it("reads the bridge's browser list", () => {
    expect(parseBrowsers(LIST)).toEqual([
      { name: "Firefox 2", id: "ae62b9aa" },
      { name: "Ivo", id: "0c11dd03" },
    ]);
    expect(parseBrowsers("Connected browsers (0):")).toEqual([]);
  });

  it("finds the agent and the personal browser", () => {
    const list = parseBrowsers(LIST);
    const fx = { ...DEFAULT_FIREFOX, personalBrowser: "ivo" };
    expect(findBrowser(list, "agent", fx)?.id).toBe("ae62b9aa");
    expect(findBrowser(list, "personal", fx)?.id).toBe("0c11dd03");
    // Two browsers and neither named: Duck can't tell which is the agent.
    expect(findBrowser(list, "agent", DEFAULT_FIREFOX)).toBeNull();
    expect(findBrowser(list, "agent", { ...DEFAULT_FIREFOX, agentBrowser: "ae62" })?.name).toBe("Firefox 2");
    expect(findBrowser(list.slice(0, 1), "agent", DEFAULT_FIREFOX)?.id).toBe("ae62b9aa");
    expect(findBrowser(list, "personal", DEFAULT_FIREFOX)).toBeNull();
    expect(findBrowser([{ name: "claude-agent", id: "1" }, { name: "x", id: "2" }], "agent", DEFAULT_FIREFOX)?.id).toBe("1");
  });

  it("selects the thread's profile before a call, one call at a time", async () => {
    const calls: string[] = [];
    let release = () => {};
    const host = createBrowserHost({
      async call(_server, tool, args) {
        calls.push(`${tool}${args.browser ? ` ${args.browser}` : ""}`);
        if (tool === "browsers_list") return text(LIST);
        if (tool === "content_get_text") await new Promise<void>((r) => (release = r));
        return text(`${tool} ok`);
      },
      startProfile: async () => {
        throw new Error("not expected");
      },
    });
    const fx = { ...DEFAULT_FIREFOX, personalBrowser: "Ivo" };
    const first = host.run("t1", fx, "content_get_text", { tab_id: 1 }, 1000);
    host.setProfile("t2", "personal");
    const second = host.run("t2", fx, "tabs_list", {}, 1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["browsers_list", "browsers_select ae62b9aa", "content_get_text"]);
    release();
    expect((await first).profile).toBe("agent");
    expect((await second).profile).toBe("personal");
    expect(calls.slice(3)).toEqual(["browsers_list", "browsers_select 0c11dd03", "tabs_list"]);
    expect(host.profileOf("t1")).toBe("agent");
  });

  it("gives a new bridge's add-on time to connect, then starts the agent profile and waits for it", async () => {
    const one = LIST.split("\n").slice(0, 2).join("\n");
    // The add-on reconnects to a bridge just started: no Firefox is started.
    let lists = 0;
    let started: string | null = null;
    const host = createBrowserHost({
      async call(_s, tool) {
        if (tool === "browsers_list") return text(++lists < 3 ? "No browser is connected" : one);
        return text("ok");
      },
      startProfile: async (p) => void (started = p),
      sleep: async () => {},
    });
    expect((await host.run("t", DEFAULT_FIREFOX, "tabs_list", {}, 1000)).profile).toBe("agent");
    expect(lists).toBe(3);
    expect(started).toBeNull();

    // The profile is closed: started after the grace, then waited for.
    let on = false;
    const closed = createBrowserHost({
      call: async (_s, tool) => text(tool === "browsers_list" && !on ? "No browser is connected" : one),
      startProfile: async (p) => {
        started = p;
        on = true;
      },
      sleep: async () => {},
    });
    expect((await closed.run("t", DEFAULT_FIREFOX, "tabs_list", {}, 1000)).profile).toBe("agent");
    expect(started).toBe("claude-agent");

    // An add-on that never connects: a plain reason, and the next call lists again.
    const never = createBrowserHost({
      call: async () => text("Connected browsers (0):"),
      startProfile: async () => {},
      sleep: async () => {},
    });
    await expect(never.run("t", DEFAULT_FIREFOX, "tabs_list", {}, 1000)).rejects.toThrow(
      `its add-on didn't connect in ${START_WAIT_MS / 1000} s`,
    );
    never.setProfile("t", "personal");
    await expect(never.run("t", DEFAULT_FIREFOX, "tabs_list", {}, 1000)).rejects.toThrow("isn't set up for Duck");
  });

  it("remembers a snapshot's refs per tab", async () => {
    const host = createBrowserHost({
      async call(_s, tool) {
        if (tool === "browsers_list") return text(LIST.split("\n").slice(0, 2).join("\n"));
        if (tool === "content_snapshot") return text('r1 link "Notifications"\nr2 button "Sign in"\n');
        return text("ok");
      },
      startProfile: async () => {},
    });
    await host.run("t", DEFAULT_FIREFOX, "content_snapshot", { tab_id: 7 }, 1000);
    expect(host.refLine(7, "r2")).toBe('r2 button "Sign in"');
    expect(host.refLine(8, "r2")).toBeUndefined();
    expect(host.refLine(7, 3)).toBeUndefined();
  });

  it("reads sites for the personal profile's list", () => {
    expect(siteOf("https://YouTrack.example.com/issues")).toBe("youtrack.example.com");
    expect(siteOf("github.com")).toBe("github.com");
    expect(siteOf("")).toBeNull();
    expect(personalAllowed("app.youtrack.cloud", ["youtrack.cloud"])).toBe(true);
    expect(personalAllowed("evilyoutrack.cloud", ["youtrack.cloud"])).toBe(false);
    expect(personalAllowed(null, ["youtrack.cloud"])).toBe(false);
  });
});
