// The game overlay (office plan O5.1): a game opened from a prop plays in a window over
// the dimmed office, scaled up by whole pixels, on its own 60 Hz loop that stops while
// the page is hidden. It reads the keyboard and gamepads as one pad (pad.ts). It closes
// on ✕, Esc, a gamepad's Back, or a click on the dimmed office; the office's own picture
// stays still behind it till then (the page holds its drawing).

import { el } from "../../pwa/dom";
import { STEP_MS, type Game, type GameDef } from "./game";
import { PAD_KEYS, readPad, type PadLike } from "./pad";

export interface GameOverlay {
  /** The game open, by title; null when none is. */
  readonly open: string | null;
  show(def: GameDef): void;
  close(): void;
}

/** Steps made up after a stall; the rest are dropped. */
const MAX_CATCH_UP = 5;
/** Room kept round the window, and taken by its header and help line, in CSS pixels. */
const MARGIN = 24;
const CHROME_H = 64;

const gamepads = (): readonly (PadLike | null)[] => (typeof navigator.getGamepads === "function" ? navigator.getGamepads() : []);

export function createGameOverlay(root: HTMLElement, closed: () => void): GameOverlay {
  const title = el("h2");
  const close = el("button", "close", "✕");
  close.type = "button";
  close.title = "close (Esc)";
  const head = el("header");
  head.append(title, close);
  const screen = el("canvas");
  const help = el("p", "muted");
  const box = el("div", "window");
  box.append(head, screen, help);
  root.replaceChildren(box);
  const ctx = screen.getContext("2d")!;

  let current: { def: GameDef; game: Game } | null = null;
  const keys = new Set<string>();
  let raf: number | undefined;
  let last = 0;
  let due = 0;
  /** Back was held: it has to be let go before it closes, so one held at open doesn't. */
  let backHeld = true;

  function fit(): void {
    if (!current) return;
    const { w, h } = current.game;
    const scale = Math.max(1, Math.floor(Math.min((root.clientWidth - 2 * MARGIN) / w, (root.clientHeight - 2 * MARGIN - CHROME_H) / h)));
    screen.style.width = `${w * scale}px`;
    screen.style.height = `${h * scale}px`;
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    if (!current) return;
    due += Math.min(now - last, MAX_CATCH_UP * STEP_MS);
    last = now;
    let stepped = false;
    while (due >= STEP_MS) {
      const pad = readPad(keys, gamepads());
      if (pad.back && !backHeld) return shut();
      backHeld = pad.back;
      current.game.step(pad);
      due -= STEP_MS;
      stepped = true;
    }
    if (stepped) current.game.draw(ctx);
  }

  function run(): void {
    if (raf !== undefined || !current || document.hidden) return;
    last = performance.now();
    due = 0;
    raf = requestAnimationFrame(frame);
  }

  function halt(): void {
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = undefined;
  }

  function shut(): void {
    if (!current) return;
    halt();
    current.game.stop?.();
    current = null;
    keys.clear();
    root.hidden = true;
    closed();
  }

  const onKey = (e: KeyboardEvent) => {
    if (!current) return;
    if (e.key === "Escape") {
      if (e.type === "keydown") shut();
      e.preventDefault();
      return;
    }
    if (!PAD_KEYS.has(e.code)) return;
    // Not scrolling the page, nor pressing a focused button.
    e.preventDefault();
    if (e.type === "keydown") keys.add(e.code);
    else keys.delete(e.code);
  };
  addEventListener("keydown", onKey);
  addEventListener("keyup", onKey);
  // Keys let go while elsewhere never come up here.
  addEventListener("blur", () => keys.clear());
  document.addEventListener("visibilitychange", () => (document.hidden ? halt() : run()));
  new ResizeObserver(fit).observe(root);
  close.addEventListener("click", shut);
  root.addEventListener("click", (e) => e.target === root && shut());
  root.hidden = true;

  return {
    get open() {
      return current?.def.title ?? null;
    },
    show(def) {
      if (current) shut();
      const game = def.make();
      current = { def, game };
      title.textContent = def.title;
      help.textContent = def.help;
      screen.width = game.w;
      screen.height = game.h;
      keys.clear();
      backHeld = true;
      root.hidden = false;
      fit();
      game.draw(ctx);
      // Keys go to the game, not to whatever had focus.
      (document.activeElement as HTMLElement | null)?.blur?.();
      run();
    },
    close: shut,
  };
}
