import { describe, expect, it } from "vitest";
import { createTurnMeter } from "./spend";

describe("turn meter", () => {
  it("bills thread calls to the one running turn and restarts per turn", () => {
    const m = createTurnMeter();
    m.state("a", "thinking");
    expect(m.usage("thread", 0.002)).toBe("a");
    m.state("a", "tool");
    m.state("a", "thinking");
    expect(m.usage("thread", 0.001)).toBe("a");
    m.state("a", "idle");
    expect(m.turns()).toEqual({ a: 0.003 });
    // Idle: nothing to bill; the last turn's cost stays.
    expect(m.usage("thread", 0.5)).toBeNull();
    m.state("a", "thinking");
    expect(m.turns()).toEqual({ a: 0 });
  });

  it("skips primitives, parked threads, and calls it can't attribute", () => {
    const m = createTurnMeter();
    m.state("a", "thinking");
    expect(m.usage("title", 0.0001)).toBeNull();
    m.state("b", "waiting");
    expect(m.usage("thread", 0.002)).toBe("a");
    m.state("b", "thinking");
    expect(m.usage("thread", 0.004)).toBeNull();
    expect(m.turns()).toEqual({ a: 0.002, b: 0 });
  });
});
