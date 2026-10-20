import { describe, expect, it } from "vitest";
import { Animator, MAT_EYE, render, type Pose } from "./duck3d";

const pose = (yaw: number): Pose => ({ yaw, rock: 0, bob: 0, nod: 0, mouth: 0, blink: 1 });

/** Eye cells and lit (catchlight) eye cells in a frame. */
function eyes(yaw: number, cols: number) {
  const f = render(pose(yaw), cols, Math.round(cols / 2), 0.52);
  let cells = 0;
  let lit = 0;
  for (let i = 0; i < f.lum.length; i++) {
    if (f.lum[i] < 0 || f.mat[i] !== MAT_EYE) continue;
    cells++;
    if (f.lum[i] > 0.5) lit++;
  }
  return { cells, lit };
}

describe("render", () => {
  it("draws a duck that fills a good part of the frame", () => {
    const f = render(pose(0.62), 72, 36, 0.52);
    const hits = f.lum.filter((l) => l >= 0).length / f.lum.length;
    expect(hits).toBeGreaterThan(0.25);
    expect(hits).toBeLessThan(0.7);
  });

  it("gives a visible eye a catchlight at every turn, and keeps most of it dark", () => {
    for (const cols of [40, 72, 130]) {
      for (let k = 0; k < 48; k++) {
        const { cells, lit } = eyes((k / 48) * 2 * Math.PI, cols);
        // Both eyes count here; at 6+ cells at least one of them shows 3+.
        if (cells >= 6) expect(lit).toBeGreaterThan(0);
        expect(lit).toBeLessThanOrEqual(Math.max(1, cells / 2));
      }
    }
  });
});

describe("Animator", () => {
  it("opens the beak only while talking", () => {
    const a = new Animator();
    let open = 0;
    for (let t = 0; t < 3; t += 0.05) open = Math.max(open, a.step(t, 0.05, "idle").mouth);
    expect(open).toBe(0);
    for (let t = 3; t < 6; t += 0.05) open = Math.max(open, a.step(t, 0.05, "talking").mouth);
    expect(open).toBeGreaterThan(0.5);
  });

  it("spins while thinking, then turns back to face you", () => {
    const a = new Animator();
    const start = a.pose.yaw;
    let turned = 0;
    for (let t = 0; t < 2; t += 0.05) {
      const before = a.pose.yaw;
      a.step(t, 0.05, "thinking");
      turned += Math.abs(a.pose.yaw - before) < 1 ? Math.abs(a.pose.yaw - before) : 0;
    }
    expect(turned).toBeGreaterThan(3);
    for (let t = 2; t < 6; t += 0.05) a.step(t, 0.05, "listening");
    expect(Math.abs(Math.atan2(Math.sin(a.pose.yaw - start), Math.cos(a.pose.yaw - start)))).toBeLessThan(0.3);
  });
});
