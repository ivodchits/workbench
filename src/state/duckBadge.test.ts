import { describe, expect, it } from "vitest";
import type { ConfirmRequest } from "../assistant/protocol";
import { badgeLabel, duckBadgeCount } from "./duckBadge";

describe("duck badge", () => {
  it("counts unread replies across threads plus waiting confirmations", () => {
    expect(duckBadgeCount({ unread: {}, asks: [] })).toBe(0);
    expect(duckBadgeCount({ unread: { a: 2, b: 1 }, asks: [{} as ConfirmRequest] })).toBe(4);
  });

  it("labels the number, capped at 9+, and nothing at zero", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
  });
});
