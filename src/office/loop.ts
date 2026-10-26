// The office's clock (office plan O0.1). The simulation steps at a fixed 10 Hz; the
// picture is redrawn at most 30 times a second, and only when something in it changed:
// a step said so, an input asked, or an animation reached its next frame. Between those
// nothing runs but the step timer. Everything stops while the page is hidden.

/** Milliseconds per simulation step. */
export const SIM_STEP = 100;
const FRAME_GAP = 1000 / 30;
/** Steps made up after a stall (a busy main thread); the rest are dropped. */
const MAX_CATCH_UP = 5;

export interface Scene {
  /** One fixed step of the simulation; true when it changed what's on screen. */
  step(): boolean;
  /** Draws the picture at `ms`; returns how long until it changes by itself
   *  (Infinity when only a step or an input can change it). */
  draw(ms: number): number;
}

export interface LoopStats {
  draws: number;
  /** Total time spent drawing, ms. */
  drawMs: number;
  steps: number;
}

export interface Loop {
  /** Redraw soon (within the frame cap), e.g. after an input. */
  invalidate(): void;
  /** Running totals since the page loaded; the HUD takes differences. */
  readonly stats: LoopStats;
}

export function startLoop(scene: Scene): Loop {
  const stats: LoopStats = { draws: 0, drawMs: 0, steps: 0 };
  let raf: number | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let stepTimer: ReturnType<typeof setInterval> | undefined;
  let stepDue = 0;
  let lastDraw = -Infinity;

  const requestDraw = () => {
    if (raf === undefined && !document.hidden) raf = requestAnimationFrame(frame);
  };

  /** Draw again in `ms`. Never later than a wake already set: every caller is
   *  either the draw that set it or asking for sooner. */
  const wakeIn = (ms: number) => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      requestDraw();
    }, ms);
  };

  function frame(now: number): void {
    raf = undefined;
    const early = lastDraw + FRAME_GAP - now;
    if (early > 1) return wakeIn(early);
    lastDraw = now;
    const t0 = performance.now();
    const next = scene.draw(now);
    stats.drawMs += performance.now() - t0;
    stats.draws++;
    // +1: land just past the frame boundary, not on it.
    if (Number.isFinite(next)) wakeIn(Math.max(next + 1, FRAME_GAP));
    else clearTimeout(wakeTimer);
  }

  function steps(): void {
    const now = performance.now();
    let changed = false;
    for (let n = 0; stepDue <= now && n < MAX_CATCH_UP; n++) {
      changed = scene.step() || changed;
      stepDue += SIM_STEP;
      stats.steps++;
    }
    if (stepDue <= now) stepDue = now + SIM_STEP;
    if (changed) requestDraw();
  }

  function start(): void {
    stepDue = performance.now() + SIM_STEP;
    stepTimer = setInterval(steps, SIM_STEP);
    requestDraw();
  }

  function stop(): void {
    clearInterval(stepTimer);
    clearTimeout(wakeTimer);
    if (raf !== undefined) cancelAnimationFrame(raf);
    stepTimer = wakeTimer = raf = undefined;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
  return { invalidate: requestDraw, stats };
}
