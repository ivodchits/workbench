// A right-click menu (G3), styled as one of the console's own boxes (§5.x) rather
// than a foreign OS menu. Built here, outside `panels/`, because it's the first of
// its kind in the app — there were **no** `onContextMenu` handlers anywhere in
// `src/` before this step — and the instance rail and Diff panel want the same
// thing next. Nothing in it knows about git.
//
// Three properties the panel relies on:
//   * It renders through a portal onto `document.body`. Every row this menu opens
//     from lives inside a scroll box inside a `Splitter` pane, and those clip
//     their overflow — a menu drawn in the tree would be cut off at the pane edge.
//   * It clamps itself into the viewport after measuring, so a right-click on the
//     last row of a panel docked at the bottom of the screen still shows the menu.
//   * Every disabled item carries its *reason* in `title`. Half the items this
//     step lands are waiting on a later step's backend, and a greyed row that
//     won't say why is worse than no row at all.
//
// Dismissal is deliberately broad: Escape, Tab, an outside press, a scroll, a
// resize, or the window losing focus. A menu that outlives what it was pointing
// at is a menu that acts on the wrong thing.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** One clickable row. */
export interface MenuAction {
  kind?: "item";
  /** Row text. Lead with a glyph, the way the panel's buttons do (`⎘ copy path`). */
  label: string;
  onClick: () => void;
  /** Greyed and unclickable. Always pair with `title`. */
  disabled?: boolean;
  /** Hover text: what the item does, or *why it can't*. */
  title?: string;
  /** Destructive — drawn in the "needs" colour. */
  danger?: boolean;
  /** Dim right-aligned text: a shortcut, a count, a target. */
  hint?: string;
}

/** A rule between groups of rows. */
export interface MenuSeparator {
  kind: "separator";
}

export type MenuEntry = MenuAction | MenuSeparator;

const isAction = (e: MenuEntry): e is MenuAction => e.kind !== "separator";

/** Gap kept between the menu and the viewport edge when it has to be nudged. */
const MARGIN = 6;

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  /** Where the pointer was, in viewport coordinates (`clientX` / `clientY`). */
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Keyboard cursor, as an index into `items` (-1 = nothing highlighted yet, which
  // is the state a mouse user stays in).
  const [active, setActive] = useState(-1);

  // Measure, then pull the box back inside the viewport. Done in a layout effect so
  // the correction lands before paint — a menu that visibly jumps on open reads as
  // a glitch rather than a placement.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Flip to the other side of the cursor when there's room there, since that's
    // what an OS menu does; only fall back to clamping when neither side fits.
    const nx =
      x + width <= window.innerWidth - MARGIN
        ? x
        : Math.max(MARGIN, Math.min(x - width, window.innerWidth - MARGIN - width));
    const ny =
      y + height <= window.innerHeight - MARGIN
        ? y
        : Math.max(MARGIN, Math.min(y - height, window.innerHeight - MARGIN - height));
    setPos({ x: nx, y: ny });
  }, [x, y, items]);

  // Take focus so arrow keys and Escape land here rather than in the terminal, and
  // hand it back on close (the same bargain `Modal` makes).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Capture on scroll: a menu anchored to a row that has scrolled away points at
    // nothing, and scroll events from inner boxes don't bubble. The same
    // outside-only test as the press guard, because a menu long enough to scroll
    // *itself* must not close the instant you reach for its last item.
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  /** Step the keyboard cursor to the next selectable row, skipping rules and
   *  disabled items — landing on something you can't press is a dead end. */
  const step = (delta: number) => {
    const n = items.length;
    for (let i = 1; i <= n; i++) {
      const idx = (((active === -1 ? (delta > 0 ? -1 : 0) : active) + delta * i) % n + n) % n;
      const entry = items[idx];
      if (isAction(entry) && !entry.disabled) {
        setActive(idx);
        return;
      }
    }
  };

  const fire = (item: MenuAction) => {
    if (item.disabled) return;
    onClose();
    item.onClick();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const entry = items[active];
          if (entry && isAction(entry)) fire(entry);
        }
      }}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 200,
        minWidth: 176,
        // Taller than the window is possible once a row has a dozen items; scroll
        // rather than run off the bottom where the clamp can't help.
        maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        padding: "3px 0",
        background: "var(--wb-panel)",
        border: "1px solid var(--wb-borderActive)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
        outline: "none",
        userSelect: "none",
      }}
    >
      {items.map((entry, i) =>
        !isAction(entry) ? (
          <span
            key={`sep${i}`}
            aria-hidden
            style={{ height: 1, margin: "3px 0", background: "var(--wb-border)" }}
          />
        ) : (
          <button
            key={`${entry.label}${i}`}
            role="menuitem"
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => fire(entry)}
            onMouseEnter={() => setActive(entry.disabled ? -1 : i)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              textAlign: "left",
              padding: "4px 12px",
              border: "none",
              background: active === i ? "var(--wb-sel)" : "transparent",
              cursor: entry.disabled ? "default" : "pointer",
              color: entry.disabled
                ? "var(--wb-textFaint)"
                : entry.danger
                  ? "var(--wb-needs)"
                  : "var(--wb-textDim2)",
              font: "11.5px var(--wb-mono)",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ flex: 1 }}>{entry.label}</span>
            {entry.hint && (
              <span style={{ flex: "0 0 auto", color: "var(--wb-textFaint)", font: "10px var(--wb-mono)" }}>
                {entry.hint}
              </span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
