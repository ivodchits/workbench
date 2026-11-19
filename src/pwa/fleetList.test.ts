import { describe, expect, it } from "vitest";
import { candidates, firstReachable, parseFleet, type PhoneFleet } from "./fleetList";

const fleet = (main: string): PhoneFleet => ({
  here: "d",
  main,
  pinned: false,
  instances: [
    { id: "d", name: "desktop", kind: "desktop", url: "https://desktop.t.ts.net", online: true, main: main === "d", here: true },
    { id: "s", name: "server", kind: "server", url: null, online: false, main: main === "s", here: false },
    { id: "l", name: "laptop", kind: "laptop", url: "https://laptop.t.ts.net/", online: true, main: main === "l", here: false },
  ],
});

describe("the phone's list of machines", () => {
  it("tries the main first, then the priority order, then the typed address", () => {
    expect(candidates("https://old.t.ts.net", fleet("l"))).toEqual([
      "https://laptop.t.ts.net",
      "https://desktop.t.ts.net",
      "https://old.t.ts.net",
    ]);
    // The typed address is in the list: once.
    expect(candidates("desktop.t.ts.net", fleet("d"))).toEqual([
      "https://desktop.t.ts.net",
      "https://laptop.t.ts.net",
    ]);
  });

  it("is the typed address alone without a list", () => {
    expect(candidates("https://desktop.t.ts.net", null)).toEqual(["https://desktop.t.ts.net"]);
    expect(candidates(null, null)).toEqual([]);
  });

  it("drops what the app can't open", () => {
    const f = fleet("d");
    f.instances[0].url = "http://100.64.0.1:48990";
    expect(candidates(null, f)).toEqual(["https://laptop.t.ts.net"]);
  });

  it("reads a kept list, or nothing", () => {
    expect(parseFleet(JSON.stringify(fleet("d")))?.instances).toHaveLength(3);
    expect(parseFleet("{")).toBeNull();
    expect(parseFleet('{"here":null}')).toBeNull();
    expect(parseFleet(null)).toBeNull();
  });

  it("opens the best one that answers, without waiting for each in turn", async () => {
    const slow = (ok: boolean, ms: number) => () => new Promise<boolean>((r) => setTimeout(() => r(ok), ms));
    const probes: Record<string, () => Promise<boolean>> = {
      a: slow(false, 40),
      b: slow(true, 40),
      c: slow(true, 1),
    };
    const t = Date.now();
    expect(await firstReachable(["a", "b", "c"], (x) => probes[x]())).toBe("b");
    expect(Date.now() - t).toBeLessThan(75);
    expect(await firstReachable(["a"], (x) => probes[x]())).toBeNull();
    expect(await firstReachable(["x"], () => Promise.reject(new Error("no")))).toBeNull();
  });
});
