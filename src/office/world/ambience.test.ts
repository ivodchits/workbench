import { describe, expect, it } from "vitest";

import { budgetOf, skyAt } from "./ambience";

describe("the sky through the day", () => {
  it("is night at midnight, day at noon, dawn in the morning and dusk in the evening", () => {
    expect([0, 3, 6, 12, 16, 18, 21, 23.99].map(skyAt)).toEqual(["night", "night", "dawn", "day", "day", "dusk", "night", "night"]);
    expect(skyAt(24)).toBe(skyAt(0));
  });
});

describe("the coffee budget", () => {
  it("takes what's used of each window, nothing once it has reset, null when not known", () => {
    const limits = { fiveHour: { usedPercentage: 42, resetsAt: 2000 }, sevenDay: { usedPercentage: 130, resetsAt: 9000 }, receivedAt: 0 };
    expect(budgetOf(limits, 1000)).toEqual({ fiveHour: 42, sevenDay: 100 });
    expect(budgetOf(limits, 3000)).toEqual({ fiveHour: 0, sevenDay: 100 });
    expect(budgetOf({ fiveHour: null, sevenDay: null, receivedAt: 0 }, 0)).toEqual({ fiveHour: null, sevenDay: null });
    expect(budgetOf(null, 0)).toEqual({ fiveHour: null, sevenDay: null });
  });
});
