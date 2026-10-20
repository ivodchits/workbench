// The Duck button (step A3), at the far left of the title bar ("D.U.C.K.", with the
// duck icon beside it): opens and closes the drawer, spells out the acronym on
// hover, and doubles as Duck's status light. A badge counts the tool calls waiting for your confirmation (in any thread), and
// the label turns amber past the budget's soft limit and red at the cap. A pause
// mark shows while trust is paused (T1). The voice state (V1/V4) joins it later.

import { useEffect, useRef, useState } from "react";
import { runCommand, useBindings } from "../../keyboard";
import { chordText } from "../keymapFormat";
import DuckIcon from "./DuckIcon";
import { useDuckState } from "./duckState";

const ACRONYM = [
  ["D", "ispatch"],
  ["U", "nderstand"],
  ["C", "oordinate"],
  ["K", "eep watch"],
] as const;

export default function DuckButton() {
  const duck = useDuckState();
  const bindings = useBindings();
  const [hover, setHover] = useState(false);
  const [tip, setTip] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const chord =
    bindings.find((b) => b.command === "toggleAssistant")?.chord ?? "";
  const shortcut = chord ? chordText(chord) : "no shortcut set";
  const asks = duck.asks.length;
  const tone = duck.spend?.capReached
    ? "var(--wb-needs)"
    : duck.spend?.softReached
      ? "var(--wb-working)"
      : null;
  const budgetNote = duck.spend?.capReached
    ? "Budget cap reached: only small background jobs run."
    : duck.spend?.softReached
      ? "Past the budget's soft limit."
      : null;
  const paused = !!duck.trust?.paused;
  const label =
    `Duck: ${ACRONYM.map(([l, r]) => l + r).join(", ")}. ${shortcut}` +
    (asks ? `. ${asks} waiting for your confirmation` : "") +
    (paused ? ". Trust paused" : "");

  return (
    <div
      style={{
        position: "relative",
        marginLeft: 8,
        display: "flex",
        alignItems: "center",
        gap: 7,
      }}
    >
      <button
        type="button"
        onClick={() => runCommand("toggleAssistant")}
        onMouseEnter={() => {
          setHover(true);
          timer.current = window.setTimeout(() => setTip(true), 350);
        }}
        onMouseLeave={() => {
          setHover(false);
          setTip(false);
          window.clearTimeout(timer.current);
        }}
        aria-label={label}
        aria-pressed={duck.open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: hover || duck.open ? "var(--wb-sel)" : "transparent",
          border: `1px solid ${duck.open ? "var(--wb-accent)" : "var(--wb-border)"}`,
          color:
            tone ??
            (hover || duck.open ? "var(--wb-accent)" : "var(--wb-textDim2)"),
          font: "11px var(--wb-mono)",
          cursor: "pointer",
          padding: "2px 8px",
          letterSpacing: "-0.02em",
          textTransform: "uppercase",
        }}
      >
        D.U.C.K.
        {paused && <span title="trust paused">⏸</span>}
        {asks > 0 && (
          <span
            style={{
              minWidth: 15,
              height: 15,
              borderRadius: 8,
              background: "var(--wb-needs)",
              color: "var(--wb-bg)",
              font: "bold 9.5px var(--wb-mono)",
              letterSpacing: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            {asks}
          </span>
        )}
      </button>
      <DuckIcon size={13.5} color={tone ?? "var(--wb-accent)"} />

      {tip && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: 28,
            left: 0,
            zIndex: 200,
            whiteSpace: "nowrap",
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: "7px 10px",
            font: "11px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            pointerEvents: "none",
          }}
        >
          <span>
            {ACRONYM.map(([l, r], i) => (
              <span key={l}>
                {i > 0 && (
                  <span style={{ color: "var(--wb-textFaint)" }}> · </span>
                )}
                <b style={{ color: "var(--wb-accent)" }}>{l}</b>
                {r}
              </span>
            ))}
          </span>
          <span style={{ color: "var(--wb-textFaint)" }}>{shortcut}</span>
          {asks > 0 && (
            <span style={{ color: "var(--wb-needs)" }}>
              {asks} waiting for your confirmation
            </span>
          )}
          {budgetNote && (
            <span style={{ color: tone ?? undefined }}>{budgetNote}</span>
          )}
          {paused && (
            <span style={{ color: "var(--wb-needs)" }}>
              Trust paused: every consequential action asks.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
