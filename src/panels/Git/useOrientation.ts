// Panel-width orientation (G2). The Git panel is routinely docked in a tall, narrow
// column — the side-by-side splits it shipped with squeeze the diff to nothing there
// — so every tab asks this hook whether it's laying out side-by-side or stacked.
//
// It measures the panel, not the window: the same window can hold a wide Git panel
// and a narrow one. Precedent for the ResizeObserver shape: `Console.tsx:55`.

import { useEffect, useState, type RefObject } from "react";

/** Side-by-side ("wide") or stacked ("narrow") — the panel's own shape, not the app's. */
export type Orientation = "wide" | "narrow";

/** Width below which side-by-side stops working: a 280px list beside a diff needs
 *  more than this before the diff is a column of ellipses. */
const THRESHOLD = 560;

/** Dead band around the threshold. Without it, a panel parked on the boundary flips
 *  layout on every pixel of a drag — and each flip swaps in a different stored
 *  splitter position, so the whole tab jumps. */
const HYSTERESIS = 24;

/**
 * Watch an element's width and report which layout it wants. Starts at `"wide"`
 * and corrects on the first measurement, which lands in the same frame.
 */
export function useOrientation(ref: RefObject<HTMLElement | null>): Orientation {
  const [orientation, setOrientation] = useState<Orientation>("wide");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (width: number) =>
      setOrientation((prev) =>
        prev === "wide"
          ? width < THRESHOLD - HYSTERESIS
            ? "narrow"
            : prev
          : width > THRESHOLD + HYSTERESIS
            ? "wide"
            : prev,
      );

    apply(el.getBoundingClientRect().width);

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // A hidden dock tab measures 0; that's not a request to go narrow.
      if (width > 0) apply(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return orientation;
}
