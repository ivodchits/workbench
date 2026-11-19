import { describe, expect, it } from "vitest";
import { connectLocal, createHosts, serveHost, type HostDown } from "./hosts";

const declared = () => new Set(["media_control"]);
const signal = () => new AbortController().signal;

/** Another machine's `pc`, served as `fleetHosts.ts` serves it. */
function remotePc(hosts: ReturnType<typeof createHosts>, id: string, name: string, said: string) {
  let conn: ReturnType<typeof hosts.connect> | null = null;
  const served = serveHost("pc", { media_control: () => said }, (m) => conn?.receive(m), name);
  conn = hosts.connect(served.hello, (m: HostDown) => served.receive(m), id);
  return conn;
}

describe("named hosts (fleet plan F3.1)", () => {
  it("runs a PC tool on the machine named, or here", async () => {
    const hosts = createHosts(declared, () => ({ id: "d1", name: "desktop" }));
    connectLocal(hosts, "pc", { media_control: () => "desktop paused" });
    remotePc(hosts, "l1", "Laptop", "laptop paused");
    expect(await hosts.call("pc", "media_control", {}, signal())).toBe("desktop paused");
    expect(await hosts.call("pc", "media_control", {}, signal(), "desktop")).toBe("desktop paused");
    expect(await hosts.call("pc", "media_control", {}, signal(), "laptop")).toBe("laptop paused");
    expect(await hosts.call("pc", "media_control", {}, signal(), "l1")).toBe("laptop paused");
    await expect(hosts.call("pc", "media_control", {}, signal(), "server")).rejects.toThrow(
      /"server" isn't connected; the machines here: desktop, Laptop/,
    );
    expect(hosts.machines("pc")).toEqual([{ id: "l1", name: "Laptop" }]);
    expect(hosts.machines("phone")).toEqual([]);
  });

  it("drops a machine's host without touching this one's", async () => {
    const hosts = createHosts(declared, () => ({ id: "d1", name: "desktop" }));
    connectLocal(hosts, "pc", { media_control: () => "desktop paused" });
    const laptop = remotePc(hosts, "l1", "laptop", "laptop paused");
    laptop.close();
    await expect(hosts.call("pc", "media_control", {}, signal(), "laptop")).rejects.toThrow(/isn't connected/);
    expect(await hosts.call("pc", "media_control", {}, signal())).toBe("desktop paused");
    // Reconnecting replaces it.
    remotePc(hosts, "l1", "laptop", "again");
    expect(await hosts.call("pc", "media_control", {}, signal(), "laptop")).toBe("again");
  });
});
