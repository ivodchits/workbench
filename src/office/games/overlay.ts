// The game overlay (office plan O5.1): a game opened from a prop plays in a window over
// the dimmed office, scaled up by whole pixels, on its own 60 Hz loop that stops while
// the page is hidden. It reads the keyboard and gamepads as one pad (pad.ts). It closes
// on ✕, Esc, a gamepad's Back, or a click on the dimmed office; Esc and Back go to the
// game first, which may take them (the TV console back to its menu). The office's own
// picture stays still behind it till then (the page holds its drawing). ⛶ or F fills
// the screen with it (O5.3d), still scaled by whole pixels.

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
/** The window's title bar and padding, before the help under the game is counted. */
const CHROME_H = 40;

const gamepads = (): readonly (PadLike | null)[] => (typeof navigator.getGamepads === "function" ? navigator.getGamepads() : []);

export function createGameOverlay(root: HTMLElement, closed: () => void): GameOverlay {
  const title = el("h2");
  const close = el("button", "close", "✕");
  close.type = "button";
  close.title = "close (Esc)";
  const full = el("button", "close", "⛶");
  full.type = "button";
  full.title = "fill the screen (F)";
  const head = el("header");
  head.append(title, full, close);
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

  /** Follows the game's size and help, which may change as it goes (the console). */
  function follow(): void {
    if (!current) return;
    const { game, def } = current;
    if (screen.width !== game.w || screen.height !== game.h) {
      screen.width = game.w;
      screen.height = game.h;
      fit();
    }
    const says = game.help ?? def.help;
    if (help.textContent !== says) help.textContent = says;
  }

  /** Esc or Back: to the game first (the console's menu), else closing. */
  function back(): void {
    if (current?.game.back?.()) follow();
    else shut();
  }

  /** The largest whole-pixel scale at which the window, as wide as the game with its
   *  help wrapped under it, fits. */
  function fit(): void {
    if (!current) return;
    const { w, h } = current.game;
    const room = root.clientHeight - 2 * MARGIN;
    let scale = Math.max(1, Math.floor(Math.min((root.clientWidth - 2 * MARGIN) / w, (room - CHROME_H) / h)));
    for (;;) {
      screen.style.width = `${w * scale}px`;
      screen.style.height = `${h * scale}px`;
      if (scale === 1 || box.offsetHeight <= room) break;
      scale--;
    }
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    if (!current) return;
    due += Math.min(now - last, MAX_CATCH_UP * STEP_MS);
    last = now;
    let stepped = false;
    while (due >= STEP_MS) {
      const pad = readPad(keys, gamepads());
      const pressed = pad.back && !backHeld && !current.game.keepsBack;
      backHeld = pad.back;
      if (pressed) {
        back();
        if (!current) return;
      } else current.game.step(pad);
      due -= STEP_MS;
      stepped = true;
    }
    if (stepped) {
      follow();
      current.game.draw(ctx);
    }
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

  /** Fills the screen with the game, or stops doing so. */
  function fullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.requestFullscreen?.().catch(() => {});
  }

  function shut(): void {
    if (!current) return;
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
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
      if (e.type === "keydown" && !e.repeat) back();
      e.preventDefault();
      return;
    }
    if (e.code === "KeyF") {
      if (e.type === "keydown" && !e.repeat) fullscreen();
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
  full.addEventListener("click", () => {
    fullscreen();
    full.blur();
  });
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
      keys.clear();
      backHeld = true;
      root.hidden = false;
      follow();
      fit();
      game.draw(ctx);
      // Keys go to the game, not to whatever had focus.
      (document.activeElement as HTMLElement | null)?.blur?.();
      run();
    },
    close: shut,
  };
}
