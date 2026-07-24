// The history graph gutter (G7) — one cell per log row, drawn beside the subject.
//
// SVG rather than box-drawing glyphs: the lines are diagonal wherever a branch
// opens or a merge closes, and a monospace cell can't draw a diagonal without
// looking like a typo. The palette and stroke weights keep it in the console
// aesthetic (§5.x) — thin lines, the panel's own accent hues, a filled node for a
// commit and a ringed one for a merge.
//
// Lane assignment is in `lanes.ts`; this file only draws what that decided.

import { LANE_COLORS, LANE_W, ROW_H, type GraphRow } from "./lanes";

const color = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length];

/** Horizontal centre of a lane. */
const x = (lane: number): number => lane * LANE_W + LANE_W / 2;

/**
 * One row's gutter. Every line is drawn from the row's top edge to its bottom
 * edge, so consecutive rows join seamlessly without any row knowing about its
 * neighbours: a lane passing through is a straight line top-to-bottom, a parent
 * is a line from the node down to its lane at the bottom edge, and a merge
 * arriving is a line from its lane at the top edge into the node.
 */
export default function Graph({ row, width }: { row: GraphRow; width: number }) {
  const w = width * LANE_W;
  const cx = x(row.node);
  const cy = ROW_H / 2;
  return (
    <svg
      width={w}
      height={ROW_H}
      viewBox={`0 0 ${w} ${ROW_H}`}
      aria-hidden
      style={{ flex: "0 0 auto", display: "block" }}
    >
      {row.through.map((lane) => (
        <line
          key={`t${lane}`}
          x1={x(lane)}
          y1={0}
          x2={x(lane)}
          y2={ROW_H}
          stroke={color(lane)}
          strokeWidth={1}
          opacity={0.55}
        />
      ))}
      {/* Above the node: the lane it continues upward in. Drawn for every commit
          — a branch tip's line just stops at its own node, which is what a tip
          looks like. */}
      <line x1={cx} y1={0} x2={cx} y2={cy} stroke={color(row.node)} strokeWidth={1.4} opacity={0.75} />
      {row.merges.map((lane) => (
        <path
          key={`m${lane}`}
          d={`M ${x(lane)} 0 L ${x(lane)} ${cy * 0.45} Q ${x(lane)} ${cy} ${cx} ${cy}`}
          fill="none"
          stroke={color(lane)}
          strokeWidth={1.4}
          opacity={0.75}
        />
      ))}
      {row.parents.map((lane) => (
        <path
          key={`p${lane}`}
          d={
            lane === row.node
              ? `M ${cx} ${cy} L ${cx} ${ROW_H}`
              : `M ${cx} ${cy} Q ${x(lane)} ${cy} ${x(lane)} ${cy + cy * 0.55} L ${x(lane)} ${ROW_H}`
          }
          fill="none"
          stroke={color(lane)}
          strokeWidth={1.4}
          opacity={0.75}
        />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={row.isMerge ? 3.4 : 2.6}
        fill={row.isMerge ? "var(--wb-bg)" : color(row.node)}
        stroke={color(row.node)}
        strokeWidth={row.isMerge ? 1.6 : 1}
      />
    </svg>
  );
}
