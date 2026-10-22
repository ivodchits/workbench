// Where a newly opened panel goes in the dock grid. Up to MAX_COLUMNS panels open
// side by side as columns (each new one splits to the right); beyond that, further
// panels stack vertically inside the existing columns, filling the emptiest column
// first (4 -> 3 columns, one holding two; 6 -> 3 columns x 2 rows).
//
// Pure over the serialized grid so it is synchronous (live DOM rects lag behind a
// just-added panel, which matters when the reconciler adds several in one pass) and
// unit-testable without dockview.

import type { DockviewApi } from "dockview";

export const MAX_COLUMNS = 3;

export type PanelPosition =
  | { direction: "right" }
  | { referenceGroup: string; direction: "below" };

interface GridNode {
  type: "leaf" | "branch";
  data: unknown;
}

/** The dockview grid slice we read (a subset of `SerializedDockview["grid"]`). */
export interface GridShape {
  root: GridNode;
  orientation: string;
}

/** Group ids of one root-level column, top to bottom. */
function columnGroups(node: GridNode): string[] {
  if (node.type === "leaf") {
    const id = (node.data as { id?: string }).id;
    return id ? [id] : [];
  }
  const out: string[] = [];
  for (const child of node.data as GridNode[]) out.push(...columnGroups(child));
  return out;
}

/**
 * Position for the next panel. With fewer than MAX_COLUMNS columns (or a grid whose
 * root isn't a horizontal row of columns) this is the long-standing "new column to
 * the right"; otherwise it stacks below the last group of the least-filled column
 * (leftmost on ties).
 */
export function nextPanelPosition(grid: GridShape | null | undefined): PanelPosition {
  const right = { direction: "right" } as const;
  if (!grid || grid.orientation !== "HORIZONTAL" || grid.root.type !== "branch") return right;
  const columns = (grid.root.data as GridNode[]).map(columnGroups).filter((c) => c.length > 0);
  if (columns.length < MAX_COLUMNS) return right;
  let best = columns[0];
  for (const c of columns) if (c.length < best.length) best = c;
  return { referenceGroup: best[best.length - 1], direction: "below" };
}

/** Position for a new panel in `api`'s dock, or undefined when the dock is empty. */
export function positionForNewPanel(api: DockviewApi): PanelPosition | undefined {
  if (api.panels.length === 0) return undefined;
  return nextPanelPosition(api.toJSON().grid as unknown as GridShape);
}
