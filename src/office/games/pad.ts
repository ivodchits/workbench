// The games' controller (office plan O5.1): the keyboard and any gamepads (the Gamepad
// API, standard mapping) read as one pad. Arrows or WASD and the left stick or d-pad
// steer; Space, Z or a gamepad's A is A, X, Shift or B is B, Enter or Start is Start,
// and Back (Select) on a gamepad closes the game, as Esc does. Games for two hands
// (the kicker, O5.2) read it split: WASD, the d-pad or the left stick is the left hand,
// IJKL or the arrows, the face buttons as a diamond (Y up, A down, X left, B right)
// or the right stick the right. Each hand also moves left or right along a row of
// things (the kicker's rods): Q and E for the left, U and O for the right; on a
// gamepad each hand's bumper moves it outward and its trigger inward.

export interface Pad {
  /** Steering, -1 (left, up) to 1 (right, down). */
  x: number;
  y: number;
  a: boolean;
  b: boolean;
  start: boolean;
  back: boolean;
  /** The two hands, for games played with both: each -1 to 1 like `x` and `y`. */
  left: { x: number; y: number };
  right: { x: number; y: number };
  /** Each hand moving along: -1 to the left, 1 to the right, 0 staying. */
  move: { left: number; right: number };
  /** The gamepad that last had anything pressed, by its name; null for the keyboard. */
  gamepad: string | null;
}

/** The parts of a `Gamepad` read, so tests can make one. */
export interface PadLike {
  id: string;
  mapping: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean }[];
}

/** Stick travel below this is no push at all. */
export const DEADZONE = 0.25;

const KEYS = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  a: ["Space", "KeyZ"],
  b: ["KeyX", "ShiftLeft", "ShiftRight"],
  start: ["Enter"],
  // The two hands' own keys; the right hand's sit round IJKL as Q and E round WASD.
  hands: ["KeyI", "KeyJ", "KeyK", "KeyL", "KeyQ", "KeyE", "KeyU", "KeyO"],
} as const;

/** Every key the pad reads (by `KeyboardEvent.code`): the page leaves them to the game. */
export const PAD_KEYS: ReadonlySet<string> = new Set(Object.values(KEYS).flat());

// The standard mapping's buttons.
const A = 0;
const B = 1;
const X = 2;
const Y = 3;
const LB = 4;
const RB = 5;
const LT = 6;
const RT = 7;
const BACK = 8;
const START = 9;
const UP = 12;
const DOWN = 13;
const LEFT = 14;
const RIGHT = 15;

const stick = (v: number | undefined) => (v === undefined || Math.abs(v) < DEADZONE ? 0 : Math.max(-1, Math.min(1, v)));
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The pad from the keys held (`codes`) and the gamepads connected. */
export function readPad(codes: ReadonlySet<string>, gamepads: readonly (PadLike | null)[] = []): Pad {
  const held = (keys: readonly string[]) => keys.some((k) => codes.has(k));
  const axis = (plus: string, minus: string) => (codes.has(plus) ? 1 : 0) - (codes.has(minus) ? 1 : 0);
  const pad: Pad = {
    x: (held(KEYS.right) ? 1 : 0) - (held(KEYS.left) ? 1 : 0),
    y: (held(KEYS.down) ? 1 : 0) - (held(KEYS.up) ? 1 : 0),
    a: held(KEYS.a),
    b: held(KEYS.b),
    start: held(KEYS.start),
    back: false,
    left: { x: axis("KeyD", "KeyA"), y: axis("KeyS", "KeyW") },
    right: {
      x: clamp(axis("KeyL", "KeyJ") + axis("ArrowRight", "ArrowLeft")),
      y: clamp(axis("KeyK", "KeyI") + axis("ArrowDown", "ArrowUp")),
    },
    move: { left: axis("KeyE", "KeyQ"), right: axis("KeyO", "KeyU") },
    gamepad: null,
  };
  for (const g of gamepads) {
    if (!g) continue;
    const on = (n: number) => g.mapping === "standard" && !!g.buttons[n]?.pressed;
    const x = stick(g.axes[0]) + (on(RIGHT) ? 1 : 0) - (on(LEFT) ? 1 : 0);
    const y = stick(g.axes[1]) + (on(DOWN) ? 1 : 0) - (on(UP) ? 1 : 0);
    // Without the standard mapping only the first two buttons mean anything for sure.
    const a = g.mapping === "standard" ? on(A) : !!g.buttons[0]?.pressed;
    const b = g.mapping === "standard" ? on(B) : !!g.buttons[1]?.pressed;
    const rx = stick(g.axes[2]) + (on(B) ? 1 : 0) - (on(X) ? 1 : 0);
    const ry = stick(g.axes[3]) + (on(A) ? 1 : 0) - (on(Y) ? 1 : 0);
    const moveLeft = (on(LT) ? 1 : 0) - (on(LB) ? 1 : 0);
    const moveRight = (on(RB) ? 1 : 0) - (on(RT) ? 1 : 0);
    if (x || y || a || b || rx || ry || moveLeft || moveRight || on(START) || on(BACK)) pad.gamepad = g.id;
    pad.x = clamp(pad.x + x);
    pad.y = clamp(pad.y + y);
    pad.left = { x: clamp(pad.left.x + x), y: clamp(pad.left.y + y) };
    pad.right = { x: clamp(pad.right.x + rx), y: clamp(pad.right.y + ry) };
    pad.move = { left: clamp(pad.move.left + moveLeft), right: clamp(pad.move.right + moveRight) };
    pad.a ||= a;
    pad.b ||= b;
    pad.start ||= on(START);
    pad.back ||= on(BACK);
  }
  return pad;
}
