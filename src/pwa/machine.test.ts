import { describe, expect, it } from "vitest";
import type { PhoneFleet } from "./fleetList";
import { pickerItems, routed, shownMachine, showsDuck } from "./machine";

const fleet = (here: string, main: string): PhoneFleet => ({
  here,
  main,
  pinned: false,
  instances: ["d", "l"].map((id) => ({
    id,
    name: id === "d" ? "desktop" : "laptop",
    kind: id === "d" ? "desktop" : "laptop",
    url: null,
    online: true,
    main: id === main,
    here: id === here,
  })),
});

describe("the machine shown", () => {
  it("is the main unless one was picked, and none for the machine the page is on", () => {
    expect(shownMachine(fleet("l", "d"), null)).toBe("d");
    expect(shownMachine(fleet("d", "d"), null)).toBeNull();
    expect(shownMachine(fleet("d", "d"), "l")).toBe("l");
    expect(shownMachine(fleet("l", "d"), "l")).toBeNull();
    // A pick no longer in the fleet; no list yet.
    expect(shownMachine(fleet("d", "d"), "gone")).toBeNull();
    expect(shownMachine(null, "l")).toBeNull();
  });

  it("sends only the session routes there", () => {
    expect(routed("/api/ws", "l")).toBe("/m/l/api/ws");
    expect(routed("/api/notes/list", "l")).toBe("/m/l/api/notes/list");
    expect(routed("/api/notes", "l")).toBe("/m/l/api/notes");
    expect(routed("/api/session/upload", "l")).toBe("/m/l/api/session/upload");
    expect(routed("/api/assistant", "l")).toBe("/api/assistant");
    expect(routed("/api/push/mute", "l")).toBe("/api/push/mute");
    expect(routed("/api/wsx", "l")).toBe("/api/wsx");
    expect(routed("/api/ws", null)).toBe("/api/ws");
  });

  it("knows when the machine shown is Duck's", () => {
    expect(showsDuck(fleet("l", "d"), null)).toBe(true); // the main, by default
    expect(showsDuck(fleet("l", "d"), "l")).toBe(false);
    expect(showsDuck(fleet("d", "d"), null)).toBe(true);
    expect(showsDuck(null, null)).toBe(true);
  });

  it("lists every machine with the shown one marked", () => {
    const items = pickerItems(fleet("d", "l"));
    expect(items.map((i) => [i.name, i.shown])).toEqual([
      ["desktop", false],
      ["laptop", true],
    ]);
    expect(pickerItems(null)).toEqual([]);
  });
});
