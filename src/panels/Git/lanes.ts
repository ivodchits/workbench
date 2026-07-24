// The history graph's lane assignment (G7) — the value half of `Graph.tsx`, split
// for the same fast-refresh reason `format.ts` is split from `rows.tsx`. Named
// `lanes` rather than `graph` because a case-insensitive filesystem can't tell
// `graph.ts` from `Graph.tsx`, and TypeScript refuses to import both.
//
// `Commit.parents` has been fetched since step 3.11 *specifically* so a graph
// gutter could be drawn, and then never used. This is that gutter: a lane walk
// over the log, newest first, producing one small record per row saying which
// lanes pass through it, which end at it, and which its parents continue in.
//
// Deliberately minimal (§5: "graph view of branches/merges *where it helps*").
// There's no lane compaction pass, no crossing minimisation, no octopus special
// case — the useful signal at this size is "this row is a merge, and these two
// lines are the branches it joined", and a fuller railway diagram would cost
// horizontal space the panel is already short of in a narrow column.

import type { Commit } from "../../ipc/git";

/** Horizontal pitch of one lane, in px. */
export const LANE_W = 11;

/** Height of one log row, in px. The gutter draws a cell per row and joins its
 *  neighbours edge to edge, so the row and the drawing have to agree exactly —
 *  which is also why a log row's ref chips sit inline rather than wrapping. */
export const ROW_H = 42;

/**
 * Past this many lanes the gutter is wider than it is useful, so extra lanes
 * pile onto the last column: the lines overlap, which reads as "it's busy over
 * here" rather than pushing the subject column off a 560px panel.
 */
const MAX_LANES = 7;

/** One lane's colour, by lane index. Distinct hues rather than a gradient — the
 *  question a lane colour answers is "is this the same line as that one". */
export const LANE_COLORS = [
  "var(--wb-accent)",
  "var(--wb-fn)",
  "var(--wb-done)",
  "var(--wb-working)",
  "var(--wb-kw)",
  "var(--wb-ansiCyan)",
];

/** What to draw in one row's gutter. */
export interface GraphRow {
  /** Lane holding this commit's node. */
  node: number;
  /** Lanes drawn straight down through the row, node excluded. */
  through: number[];
  /** Lanes arriving from above that end at this node — the far sides of a merge. */
  merges: number[];
  /** Lanes this commit's parents continue in, below the node. */
  parents: number[];
  /** True when this commit has more than one parent. */
  isMerge: boolean;
}

/** Lane assignment for a whole log, plus how wide the gutter has to be for it. */
export interface Graph {
  rows: GraphRow[];
  /** Lanes in use at the busiest row — the gutter's column count. */
  width: number;
}

const clamp = (lane: number): number => Math.min(lane, MAX_LANES - 1);

/**
 * Walk the log assigning lanes.
 *
 * `open[i]` is the SHA lane `i` is currently waiting to reach. A commit takes the
 * lane(s) waiting for it — the first becomes its node, the rest are merges that
 * end here — or a free lane if nothing was waiting (a branch tip). Its parents
 * then take lanes: the first re-uses the node's, the others open new ones, and
 * any parent something else is already waiting for joins that lane instead.
 *
 * A parent outside the fetched window never arrives, so its lane stays open to the
 * bottom of the list. That's the honest picture — the history continues past the
 * page — and it's what `git log --graph` shows at the same boundary.
 */
export function buildGraph(commits: Commit[]): Graph {
  const open: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;

  const free = (): number => {
    const i = open.indexOf(null);
    if (i >= 0) return i;
    open.push(null);
    return open.length - 1;
  };

  for (const c of commits) {
    const waiting: number[] = [];
    for (let i = 0; i < open.length; i++) if (open[i] === c.sha) waiting.push(i);

    let node: number;
    if (waiting.length > 0) {
      node = waiting[0];
    } else {
      node = free();
      open[node] = c.sha;
    }
    // Everything else that was waiting for this commit merges into the node lane
    // and closes there.
    const merges = waiting.slice(1);
    for (const i of merges) open[i] = null;

    // Lanes still live *beside* the node pass through untouched. Read before the
    // node's own lane is released, so a lane that gets recycled below doesn't
    // also get drawn as passing through.
    const through: number[] = [];
    for (let i = 0; i < open.length; i++) if (open[i] !== null && i !== node) through.push(i);

    open[node] = null;
    const parents: number[] = [];
    c.parents.forEach((p, k) => {
      let lane = open.indexOf(p);
      if (lane < 0) {
        lane = k === 0 ? node : free();
        open[lane] = p;
      }
      parents.push(lane);
    });

    width = Math.max(width, open.length);
    rows.push({
      node: clamp(node),
      through: through.map(clamp),
      merges: merges.map(clamp),
      parents: parents.map(clamp),
      isMerge: c.parents.length > 1,
    });
  }

  return { rows, width: Math.min(Math.max(width, 1), MAX_LANES) };
}
