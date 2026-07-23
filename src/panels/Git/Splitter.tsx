// A draggable split with a collapsible second pane (G2). The Git panel shipped with
// hardcoded `flex: 0 0 300px` / `0 0 280px` / `maxHeight: 140` panes, which is the
// root cause of the panel being unusable in a narrow column: the list keeps its
// pixels and the diff gets whatever's left, which at 500px wide is nothing. This
// replaces all three.
//
// Nothing reusable existed in `src/` (dockview owns the *panel* splitters, but a
// split inside one panel isn't a dockview concern), so this is new. It's kept
// generic enough for another panel to lift, but lives here until one does.
//
// Position and collapsed-ness persist per split *per orientation* via `layout.ts`
// — a wide split's size is a width and a narrow one's is a height, and carrying a
// width over to a height is how you end up with a 300px-tall commit list.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { readSplit, writeSplit } from "./layout";
import type { Orientation } from "./useOrientation";

/** Drag-target thickness of the bar, in px (borders included). */
const THICKNESS = 5;
/** Thickness of the bar once the second pane is collapsed — enough to hold a label. */
const RAIL = 17;

export default function Splitter({
  id,
  orientation,
  direction,
  defaultSize,
  minFirst = 90,
  minSecond = 90,
  collapsible = false,
  secondLabel,
  first,
  second,
}: {
  /** Stable id for this split; the stored key is `<id>:<orientation>`. */
  id: string;
  orientation: Orientation;
  /** `row` = side-by-side (vertical bar), `column` = stacked (horizontal bar). */
  direction: "row" | "column";
  /** First-pane size until the user drags it, and the size double-click restores. */
  defaultSize: number;
  minFirst?: number;
  minSecond?: number;
  /** Offer a toggle that collapses the second pane away entirely. */
  collapsible?: boolean;
  /** What the second pane is, named on the collapsed rail so it can be found again. */
  secondLabel?: string;
  first: React.ReactNode;
  second: React.ReactNode;
}) {
  const key = `${id}:${orientation}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => readSplit(key, defaultSize).size);
  const [collapsed, setCollapsed] = useState(() => readSplit(key, defaultSize).collapsed);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  // Where along the bar the pointer grabbed, so the bar doesn't jump to centre
  // itself under the cursor on the first move.
  const grab = useRef(0);

  // An orientation flip is a different stored split; adopt its position.
  useEffect(() => {
    const stored = readSplit(key, defaultSize);
    setSize(stored.size);
    setCollapsed(stored.collapsed);
  }, [key, defaultSize]);

  const row = direction === "row";

  const clamp = (value: number, total: number): number => {
    const max = total - minSecond - THICKNESS;
    // Too small to honour both minimums: give the first pane everything it can
    // have rather than resolving to a negative size.
    if (max < minFirst) return Math.max(0, Math.min(value, total));
    return Math.max(minFirst, Math.min(max, value));
  };

  const persist = (next: Partial<{ size: number; collapsed: boolean }>) =>
    writeSplit(key, { size, collapsed, ...next });

  const onPointerDown = (e: React.PointerEvent) => {
    if (collapsed) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    grab.current = (row ? e.clientX : e.clientY) - ((row ? box.left : box.top) + size);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const origin = row ? box.left : box.top;
    const total = row ? box.width : box.height;
    setSize(clamp((row ? e.clientX : e.clientY) - grab.current - origin, total));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    // A cancel may have released the capture already; releasing twice throws.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    persist({ size });
  };

  const reset = () => {
    if (collapsed) return;
    setSize(defaultSize);
    persist({ size: defaultSize });
  };

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
    persist({ collapsed: !collapsed });
  };

  const paneStyle: CSSProperties = {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  // The first pane is *shrinkable* (`0 1 <size>px`, not `0 0`) and the second holds
  // a floor along the split axis. Together that means a box narrower than the stored
  // split eats into the list rather than squeezing the diff to nothing — which is
  // the failure this whole step exists to remove, and a fixed pane reintroduces it
  // the moment you drag the dock narrower than you left the splitter.
  const secondStyle: CSSProperties = {
    ...paneStyle,
    flex: 1,
    minWidth: row ? minSecond : 0,
    minHeight: row ? 0 : minSecond,
  };

  const active = dragging || hover;
  const barStyle: CSSProperties = {
    flex: `0 0 ${collapsed ? RAIL : THICKNESS}px`,
    boxSizing: "border-box",
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: active && !collapsed ? "var(--wb-sel)" : "var(--wb-titlebar)",
    borderLeft: row ? "1px solid var(--wb-border)" : undefined,
    borderRight: row ? "1px solid var(--wb-border)" : undefined,
    borderTop: row ? undefined : "1px solid var(--wb-border)",
    borderBottom: row ? undefined : "1px solid var(--wb-border)",
    cursor: collapsed ? "default" : row ? "col-resize" : "row-resize",
    touchAction: "none",
    userSelect: "none",
  };

  const chevron = collapsed ? (row ? "‹" : "▴") : row ? "›" : "▾";

  return (
    <div
      ref={containerRef}
      // `overflow: hidden` so that in a box too small for even the minimums the
      // panes clip instead of shoving what's docked below them (the commit box)
      // off the bottom of the panel.
      style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: direction }}
    >
      <div style={{ ...paneStyle, flex: collapsed ? 1 : `0 1 ${size}px` }}>{first}</div>

      <div
        style={barStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={collapsed ? undefined : "drag to resize · double-click to reset"}
      >
        {!collapsed && (
          <span
            aria-hidden
            style={{
              font: "8px var(--wb-mono)",
              lineHeight: 1,
              color: active ? "var(--wb-accent)" : "var(--wb-textFaint)",
              // The grip reads along the bar, so it turns with it.
              transform: row ? "none" : "rotate(90deg)",
            }}
          >
            ⋮
          </span>
        )}

        {collapsible && (
          <span
            role="button"
            tabIndex={0}
            title={collapsed ? `show ${secondLabel ?? "pane"}` : `hide ${secondLabel ?? "pane"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapsed();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleCollapsed();
              }
            }}
            style={{
              position: "absolute",
              // Parked near the start of the bar, clear of the centre grip. When
              // expanded the pill is thicker than the bar and overhangs it — which
              // is the only way a 5px seam can carry a control.
              ...(row
                ? { top: 10, left: "50%", transform: "translateX(-50%)", padding: "3px 1px" }
                : { left: 10, top: "50%", transform: "translateY(-50%)", padding: "1px 4px" }),
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "var(--wb-titlebar)",
              border: "1px solid var(--wb-border)",
              borderRadius: 2,
              cursor: "pointer",
              font: "9px var(--wb-mono)",
              lineHeight: 1,
              color: "var(--wb-textDim2)",
              whiteSpace: "nowrap",
            }}
          >
            {chevron}
            {collapsed && !row && secondLabel && <span>{secondLabel}</span>}
          </span>
        )}
      </div>

      {!collapsed && <div style={secondStyle}>{second}</div>}
    </div>
  );
}
