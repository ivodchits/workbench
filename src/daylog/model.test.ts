import { describe, expect, it } from "vitest";
import type { Entry } from "../assistant/daylog";
import { byProject, copyText, dayTitle, monthGrid, shiftDay } from "./model";

const at = (h: number) => new Date(2026, 10, 24, h).getTime();
const entry = (id: string, project: string, h: number, over: Partial<Entry> = {}): Entry => ({
  id,
  project,
  projectName: project.toUpperCase(),
  title: `Did ${id}`,
  detail: null,
  status: "done",
  from: at(h),
  to: at(h),
  machines: ["desktop"],
  edited: false,
  notes: [],
  ...over,
});

describe("the day bar", () => {
  it("moves by day across months", () => {
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayTitle("2026-11-24", at(12))).toBe("Tuesday 24 November");
    expect(dayTitle("2025-11-24", at(12))).toContain("2025");
  });
});

describe("the calendar", () => {
  it("is weeks from Monday, with marks, and no future days to pick", () => {
    const g = monthGrid(2026, 11, new Set(["2026-11-20"]), "2026-11-24");
    // 1 November 2026 is a Sunday: the first week starts on 26 October.
    expect(g[0][0]).toMatchObject({ day: "2026-10-26", inMonth: false });
    expect(g[0][6]).toMatchObject({ day: "2026-11-01", inMonth: true, n: 1 });
    const cells = g.flat();
    expect(cells.find((c) => c.day === "2026-11-20")?.marked).toBe(true);
    expect(cells.find((c) => c.day === "2026-11-24")).toMatchObject({ today: true, future: false });
    expect(cells.find((c) => c.day === "2026-11-25")?.future).toBe(true);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[g.length - 1].some((c) => c.day === "2026-11-30")).toBe(true);
  });
});

describe("the list", () => {
  it("groups by project, the busiest first, in time order, without hidden ones", () => {
    const g = byProject([
      entry("a", "web", 14),
      entry("b", "app", 9),
      entry("c", "web", 10),
      entry("d", "web", 11, { hidden: true }),
    ]);
    expect(g.map((x) => [x.name, x.entries.map((e) => e.id)])).toEqual([
      ["WEB", ["c", "a"]],
      ["APP", ["b"]],
    ]);
    expect(byProject([entry("d", "web", 11, { hidden: true })], true)[0].entries).toHaveLength(1);
  });

  it("copies as plain text with the marks", () => {
    const g = byProject([
      entry("a", "web", 9, { title: "Added a dark theme; reverted later that day", status: "reverted" }),
      entry("b", "web", 10, { title: "Search page", status: "in_progress", detail: "Half the filters work." }),
    ]);
    expect(copyText("2026-11-24", g, at(12))).toBe(
      ["Tuesday 24 November", "", "WEB", "- Added a dark theme; reverted later that day", "- Search page (in progress)", "  Half the filters work."].join("\n"),
    );
    expect(copyText("2026-11-24", [], at(12))).toContain("Nothing logged.");
  });
});
