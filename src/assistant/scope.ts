// Duck's side effects, undone together (fleet plan F6.3). Duck's core is stopped
// and started again when it moves to this machine, without reloading the window,
// so every listener, timer and watcher it starts has to go with it. A leak here
// is a doubled reminder, routine or permission answer.

/** A Tauri listener's unsubscribe, usable at once: one called before the listener
 *  is registered drops it when it is. */
export function unlisten(p: Promise<() => void>): () => void {
  let stop: (() => void) | null = null;
  let off = false;
  void p.then(
    (f) => {
      if (off) f();
      else stop = f;
    },
    () => {},
  );
  return () => {
    off = true;
    stop?.();
    stop = null;
  };
}

export interface Scope {
  /** Undo `off` when the scope is disposed (or at once, if it already was). */
  add(off: () => void): void;
  /** A Tauri `listen`, unlistened on dispose. */
  listen(p: Promise<() => void>): void;
  every(ms: number, cb: () => void): void;
  after(ms: number, cb: () => void): void;
  readonly disposed: boolean;
  /** Undo everything, newest first. Idempotent. */
  dispose(): void;
}

export function createScope(): Scope {
  const offs: (() => void)[] = [];
  let disposed = false;
  const run = (off: () => void) => {
    try {
      off();
    } catch (e) {
      console.warn("duck: undoing a side effect failed", e);
    }
  };
  const scope: Scope = {
    add(off) {
      if (disposed) run(off);
      else offs.push(off);
    },
    listen(p) {
      scope.add(unlisten(p));
    },
    every(ms, cb) {
      const h = setInterval(cb, ms);
      scope.add(() => clearInterval(h));
    },
    after(ms, cb) {
      const h = setTimeout(cb, ms);
      scope.add(() => clearTimeout(h));
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (offs.length) run(offs.pop()!);
    },
  };
  return scope;
}
