import { describe, expect, it } from "vitest";

import {
  BALL_R,
  DEAD_STEPS,
  ATTACK,
  DEFENCE,
  FIELD,
  FOOT_R,
  GOAL_H,
  GOAL_STEPS,
  GOALIE,
  LEG,
  LIFT,
  MID_Y,
  MIDFIELD,
  SERVE_STEPS,
  footX,
  placeOf,
  TO_WIN,
  kickerState,
  manY,
  rodOf,
  stepKicker,
  type KickerState,
} from "./kicker";
import { readPad, type Pad } from "./pad";

const idle = readPad(new Set());
const hands = (left: Partial<Pad["left"]> = {}, right: Partial<Pad["right"]> = {}, more: Partial<Pad> = {}): Pad => ({
  ...idle,
  left: { x: 0, y: 0, ...left },
  right: { x: 0, y: 0, ...right },
  ...more,
});
const run = (s: KickerState, pad: Pad | null, steps: number) => {
  for (let n = 0; n < steps; n++) stepKicker(s, pad);
};
/** A game in play with the ball placed, still unless given a speed. */
function playing(x: number, y: number, vx = 0, vy = 0): KickerState {
  const s = kickerState(1, true);
  run(s, idle, SERVE_STEPS);
  Object.assign(s, { phase: "play", still: 0 });
  s.ball = { x, y, vx, vy };
  return s;
}

describe("the kicker's table", () => {
  const s = kickerState(1, true);
  const touch = FOOT_R + BALL_R;

  it("has four rods a side, interleaved, goalies at the ends", () => {
    // The computer's goal on the left, yours on the right.
    expect(s.rods.map((r) => r.side)).toEqual([1, 1, 0, 1, 0, 1, 0, 0]);
    expect(s.rods.map((r) => r.men)).toEqual([1, 2, 3, 5, 5, 3, 2, 1]);
  });

  it("lets every rod's men reach across the field, and the goalies across the goal", () => {
    for (const rod of s.rods) {
      const ys = rod.kind === GOALIE ? [MID_Y - GOAL_H / 2, MID_Y + GOAL_H / 2] : [FIELD.y + BALL_R, FIELD.y + FIELD.h - BALL_R];
      for (let y = ys[0]; y <= ys[1]; y++) {
        const gap = Math.min(...Array.from({ length: rod.men }, (_, n) => Math.max(0, Math.abs(y - manY(rod, n, 0)) - rod.travel)));
        expect(gap).toBeLessThanOrEqual(touch);
      }
    }
  });

  it("leaves no strip between rods out of a swing's reach", () => {
    for (let n = 1; n < s.rods.length; n++) {
      expect((s.rods[n].x - s.rods[n - 1].x) / 2).toBeLessThan(LEG * Math.sin(LIFT) + touch);
    }
  });
});

describe("your hands", () => {
  const move = (left: number, right: number) => hands({}, {}, { move: { left, right } });

  it("start on midfield (left) and the goalie (right), and slide their own rods", () => {
    const s = kickerState(1, true);
    expect(s.hands.map((h) => s.rods.filter((r) => r.side === 0).sort((p, q) => p.x - q.x)[h].kind)).toEqual([MIDFIELD, GOALIE]);
    expect(placeOf(s, MIDFIELD)).toBe(1);
    run(s, hands({ y: 1 }, { y: -1 }), 5);
    expect(rodOf(s, 0, MIDFIELD).pos).toBeGreaterThan(3);
    expect(rodOf(s, 0, GOALIE).pos).toBeLessThan(-3);
    expect(rodOf(s, 0, DEFENCE).pos).toBe(0);
    expect(rodOf(s, 0, ATTACK).pos).toBe(0);
  });

  it("move along one rod a press, each on its own, never crossing", () => {
    const s = kickerState(1, true);
    // Held, a press counts once.
    run(s, move(-1, 0), 10);
    expect(s.hands).toEqual([0, 3]);
    run(s, move(-1, 0), 1);
    expect(s.hands).toEqual([0, 3]);
    // The right hand comes left up to the left hand's neighbour, no further.
    for (let n = 0; n < 6; n++) run(s, move(0, n % 2 === 0 ? -1 : 0), 1);
    expect(s.hands).toEqual([0, 1]);
    // Nor can the left hand go onto it; once it's moved off, it can.
    run(s, move(1, 0), 1);
    expect(s.hands).toEqual([0, 1]);
    run(s, idle, 1);
    run(s, move(0, 1), 1);
    run(s, idle, 1);
    run(s, move(1, 0), 1);
    expect(s.hands).toEqual([1, 2]);
    run(s, idle, 1);
    run(s, move(0, 1), 1);
    run(s, idle, 1);
    run(s, move(0, 1), 1);
    expect(s.hands).toEqual([1, 3]);
  });

  it("swing the men the way pushed on a spring, back to rest when let go", () => {
    const s = kickerState(1, true);
    const mid = rodOf(s, 0, MIDFIELD);
    run(s, hands({ x: -1 }), 30);
    expect(mid.th).toBeGreaterThan(LIFT);
    expect(footX(mid)).toBeLessThan(mid.x - LEG / 2);
    run(s, hands({ x: 1 }), 30);
    expect(mid.th).toBeLessThan(-LIFT);
    run(s, idle, 60);
    expect(Math.abs(mid.th)).toBeLessThan(0.05);
  });
});

describe("the ball", () => {
  // Your men face left: in front of them is lower x.
  it("bounces back off a foot standing still", () => {
    const mid = rodOf(kickerState(1, true), 0, MIDFIELD);
    const s = playing(mid.x - 8, MID_Y, 2);
    run(s, idle, 6);
    expect(s.ball.vx).toBeLessThan(0);
    expect(s.ball.vx).toBeGreaterThan(-2);
    expect(s.touch).toEqual({ side: 0, kind: MIDFIELD });
  });

  it("is shot by a swing, harder from a wind-up", () => {
    const shot = (windUp: boolean) => {
      const mid = rodOf(kickerState(1, true), 0, MIDFIELD);
      const s = playing(mid.x - FOOT_R - BALL_R - 0.5, MID_Y);
      if (windUp) run(s, hands({ x: 1 }), 12);
      let fastest = 0;
      for (let n = 0; n < 12; n++) {
        stepKicker(s, hands({ x: -1 }));
        fastest = Math.max(fastest, -s.ball.vx);
      }
      return fastest;
    };
    expect(shot(false)).toBeGreaterThan(1);
    expect(shot(true)).toBeGreaterThan(shot(false) + 0.5);
  });

  it("rolls under feet swung up", () => {
    const s = kickerState(1, true);
    const mid = rodOf(s, 0, MIDFIELD);
    // The feet go up while the ball waits to be served.
    run(s, hands({ x: -1 }), 20);
    Object.assign(s, { phase: "play", ball: { x: mid.x - 14, y: MID_Y, vx: 2, vy: 0 } });
    run(s, hands({ x: -1 }), 10);
    expect(s.ball.x).toBeGreaterThan(mid.x + 4);
    expect(s.ball.vx).toBeGreaterThan(1.5);
  });

  it("scores in a goal, then is served again", () => {
    // Yours is the left goal to score in.
    const s = playing(FIELD.x + 6, MID_Y, -3);
    run(s, idle, 5);
    expect(s.score).toEqual([1, 0]);
    expect(s.phase).toBe("goal");
    run(s, idle, GOAL_STEPS + SERVE_STEPS);
    expect(s.phase).toBe("play");
    expect(Math.abs(s.ball.x - (FIELD.x + FIELD.w / 2))).toBeLessThan(5);
  });

  it("bounces off the ends beside the goal", () => {
    const s = playing(FIELD.x + 6, FIELD.y + 6, -3);
    run(s, idle, 5);
    expect(s.score).toEqual([0, 0]);
    expect(s.ball.vx).toBeGreaterThan(0);
    expect(s.ball.x).toBeGreaterThanOrEqual(FIELD.x + BALL_R);
  });

  it("is served again when it lies dead out of reach", () => {
    const s = playing(FIELD.x + 3, FIELD.y + 3);
    run(s, idle, DEAD_STEPS);
    expect(s.phase).toBe("play");
    run(s, idle, 2);
    expect(s.phase).toBe("serve");
  });

  it("stays on the table through a long game", () => {
    const s = kickerState(7, true);
    for (let n = 0; n < 60 * 180; n++) {
      stepKicker(s, null);
      const { x, y } = s.ball;
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(FIELD.y);
      expect(y).toBeLessThanOrEqual(FIELD.y + FIELD.h);
      if (Math.abs(y - MID_Y) > GOAL_H / 2) {
        expect(x).toBeGreaterThanOrEqual(FIELD.x);
        expect(x).toBeLessThanOrEqual(FIELD.x + FIELD.w);
      }
    }
  });
});

describe("the game", () => {
  it("is won by the computer against a player who does nothing, from either end", () => {
    for (const right of [true, false]) {
      const s = kickerState(3, right);
      for (let n = 0; n < 60 * 600 && s.phase !== "over"; n++) stepKicker(s, idle);
      expect(s.phase).toBe("over");
      expect(s.score[1]).toBe(TO_WIN);
    }
  });

  it("puts you at either end by chance, mirrored from the left", () => {
    const ends = new Set(Array.from({ length: 20 }, (_, n) => kickerState(n).right));
    expect(ends).toEqual(new Set([true, false]));
    const s = kickerState(1, false);
    expect(s.rods.map((r) => r.side)).toEqual([0, 0, 1, 0, 1, 0, 1, 1]);
    // The left hand starts on your goalie, the right on midfield.
    expect(s.hands).toEqual([placeOf(s, GOALIE), placeOf(s, MIDFIELD)]);
    expect(s.hands).toEqual([0, 2]);
    // Your men face right now: a swing right kicks.
    const mid = rodOf(s, 0, MIDFIELD);
    Object.assign(s, { phase: "play", ball: { x: mid.x + FOOT_R + BALL_R + 0.5, y: MID_Y, vx: 0, vy: 0 } });
    run(s, hands({}, { x: -1 }), 12);
    let fastest = 0;
    for (let n = 0; n < 8; n++) {
      stepKicker(s, hands({}, { x: 1 }));
      fastest = Math.max(fastest, s.ball.vx);
    }
    expect(fastest).toBeGreaterThan(1.5);
    // And you score in the right goal.
    s.ball = { x: FIELD.x + FIELD.w - 6, y: MID_Y, vx: 3, vy: 0 };
    run(s, idle, 5);
    expect(s.score).toEqual([1, 0]);
  });

  it("pauses on Start, and starts again on it once over", () => {
    const s = kickerState(1, true);
    run(s, hands({}, {}, { start: true }), 3);
    expect(s.paused).toBe(true);
    const ball = { ...s.ball };
    run(s, idle, 100);
    expect(s.ball).toEqual(ball);
    run(s, hands({}, {}, { start: true }), 1);
    expect(s.paused).toBe(false);
    Object.assign(s, { phase: "over", score: [5, 2] });
    run(s, idle, 1);
    run(s, hands({}, {}, { start: true }), 1);
    expect(s.score).toEqual([0, 0]);
    expect(s.phase).toBe("serve");
    // Every rematch at the other end.
    expect(s.right).toBe(false);
    expect(rodOf(s, 0, GOALIE).x).toBeLessThan(FIELD.x + FIELD.w / 2);
    Object.assign(s, { phase: "over" });
    run(s, idle, 1);
    run(s, hands({}, {}, { start: true }), 1);
    expect(s.right).toBe(true);
  });
});
