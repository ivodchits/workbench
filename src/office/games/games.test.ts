import { describe, expect, it } from "vitest";

import { buildOffice } from "../map/build";
import { TEST_H, TEST_W, stepTest, testState } from "./game";
import { DEADZONE, PAD_KEYS, readPad, type PadLike } from "./pad";
import { gamePropAt } from "./props";

const gamepad = (axes: number[], pressed: number[] = [], mapping = "standard"): PadLike => ({
  id: "Test pad",
  mapping,
  axes,
  buttons: Array.from({ length: 17 }, (_, n) => ({ pressed: pressed.includes(n) })),
});

describe("the pad", () => {
  it("reads the keyboard", () => {
    const pad = readPad(new Set(["ArrowLeft", "KeyS", "KeyZ", "Enter"]));
    expect(pad).toEqual({ x: -1, y: 1, a: true, b: false, start: true, back: false, gamepad: null });
    expect(readPad(new Set(["ArrowLeft", "ArrowRight"])).x).toBe(0);
    expect(PAD_KEYS.has("Space")).toBe(true);
    expect(PAD_KEYS.has("Escape")).toBe(false);
  });

  it("reads a gamepad's stick, d-pad and buttons, past a deadzone", () => {
    expect(readPad(new Set(), [gamepad([DEADZONE / 2, -0.6])])).toMatchObject({ x: 0, y: -0.6, gamepad: "Test pad" });
    expect(readPad(new Set(), [gamepad([0, 0], [0, 15, 8])])).toMatchObject({ x: 1, a: true, back: true });
    expect(readPad(new Set(), [gamepad([0, 0])]).gamepad).toBeNull();
    // Keyboard and gamepad together, kept to full push.
    expect(readPad(new Set(["ArrowRight"]), [gamepad([0.9, 0])]).x).toBe(1);
    // Without the standard mapping, only A and B are trusted.
    expect(readPad(new Set(), [gamepad([0, 0], [1, 8], "")])).toMatchObject({ b: true, back: false });
    expect(readPad(new Set(), [null]).gamepad).toBeNull();
  });
});

describe("the test game", () => {
  const still = readPad(new Set());

  it("steers the dot, faster with B, and keeps it in the field", () => {
    const s = testState();
    const x0 = s.x;
    stepTest(s, { ...still, x: 1 });
    expect(s.x).toBeCloseTo(x0 + 1.2);
    stepTest(s, { ...still, x: 1, b: true });
    expect(s.x).toBeCloseTo(x0 + 3.6);
    for (let n = 0; n < 500; n++) stepTest(s, { ...still, x: -1, y: 1 });
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.y).toBeLessThan(TEST_H);
    expect(s.x).toBeLessThan(TEST_W);
    expect(s.trail.length).toBeLessThanOrEqual(40);
  });
});

describe("the game props", () => {
  const office = buildOffice();
  const at = (id: string) => office.props.find((p) => p.id === id)!;

  it("are the TV and the kicker", () => {
    const tv = at("tvOn");
    const kicker = at("kicker");
    expect(gamePropAt(office, tv.x + 2, tv.y + 2)).toBe("tv");
    expect(gamePropAt(office, kicker.x + kicker.prop.w / 2, kicker.y + kicker.prop.h / 2)).toBe("kicker");
    const sofa = at("sofa");
    expect(gamePropAt(office, sofa.x + 2, sofa.y + sofa.prop.h - 2)).toBeNull();
  });
});
