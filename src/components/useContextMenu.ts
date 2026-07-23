// The state half of `ContextMenu` (G3): where a menu was summoned and what's in
// it. Split from the component for the same reason `format.ts` is split from
// `rows.tsx` — a module exporting both a component and a hook breaks React fast
// refresh (`react-refresh/only-export-components`).
//
// One of these per surface that has right-clickable rows, not one per row: the
// hook holds a *single* open menu, so opening one from another row replaces it
// rather than stacking two menus on screen.

import { useCallback, useState, type MouseEvent } from "react";

import type { MenuEntry } from "./ContextMenu";

/** An open menu: the pointer position it was summoned at, and its rows. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
  items: MenuEntry[];
}

export function useContextMenu(): {
  /** The open menu, or null. Spread into `<ContextMenu>` with an `onClose`. */
  anchor: ContextMenuAnchor | null;
  /** `onContextMenu` handler: suppresses the browser menu and opens ours. An
   *  empty item list opens nothing — the row simply has no menu. */
  openMenu: (e: MouseEvent, items: MenuEntry[]) => void;
  closeMenu: () => void;
} {
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);

  const openMenu = useCallback((e: MouseEvent, items: MenuEntry[]) => {
    e.preventDefault();
    // Stop the event reaching an outer row's handler, which would replace these
    // items with the parent's a moment later.
    e.stopPropagation();
    if (items.length === 0) return;
    setAnchor({ x: e.clientX, y: e.clientY, items });
  }, []);

  const closeMenu = useCallback(() => setAnchor(null), []);

  return { anchor, openMenu, closeMenu };
}
