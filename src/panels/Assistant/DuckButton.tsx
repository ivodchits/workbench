// The Duck button (step A3), at the far left of the title bar ("D.U.C.K.", with the
// duck icon beside it): opens and closes the drawer, spells out the acronym on
// hover, and doubles as Duck's status light. A badge counts the tool calls waiting for your confirmation (in any thread), and
// the label turns amber past the budget's soft limit and red at the cap. A pause
// mark shows while trust is paused (T1). The voice state (V1/V4) joins it later.
//
// Beside it (V5): the speaker, Speak on or off (Duck's voice on this PC), and a
// moon while Do Not Disturb is on. Right-click the button for Do Not Disturb.
//
// An ear on the button (V6) while the wake word listens for "Hey Duck".

import { useEffect, useRef, useState } from "react";
import { runCommand, useBindings } from "../../keyboard";
import { chordText } from "../keymapFormat";
import DuckIcon from "./DuckIcon";
import { nextMorning } from "../../assistant/announce";
import { DND_FOREVER } from "../../assistant/settings";
import { setDnd, useDuckState } from "./duckState";
import { setSpeakOn, useSpeechState } from "./replySpeech";
import { useVoiceState } from "./voiceState";

function untilText(until: number): string {
  if (until >= DND_FOREVER) return "until you turn it off";
  const d = new Date(until);
  return `until ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${d.toDateString() !== new Date().toDateString() ? " tomorrow" : ""}`;
}

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
  const [menu, setMenu] = useState(false);
  const speech = useSpeechState();
  const listening = useVoiceState().wake.listening;
  const [, tick] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const dndUntil = duck.settings?.dndUntil ?? null;
  const dnd = dndUntil !== null && dndUntil > Date.now();
  // Repaint when a timed Do Not Disturb runs out.
  useEffect(() => {
    if (!dnd || dndUntil >= DND_FOREVER) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.min(dndUntil - Date.now() + 500, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [dnd, dndUntil]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const chord =
    bindings.find((b) => b.command === "toggleAssistant")?.chord ?? "";
  const shortcut = chord ? chordText(chord) : "no shortcut set";
  const asks = duck.asks.length;
  const unread = Object.values(duck.unread).reduce((n, x) => n + x, 0);
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
    (unread ? `. ${unread} unread in other threads` : "") +
    (paused ? ". Trust paused" : "") +
    (listening ? '. Listening for "Hey Duck"' : "");

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
        onContextMenu={(e) => {
          e.preventDefault();
          setTip(false);
          setMenu(true);
        }}
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
        {listening && (
          <span title='Listening for "Hey Duck"' style={{ letterSpacing: 0, filter: "grayscale(0.6)", fontSize: 10.5 }}>
            👂
          </span>
        )}
        {unread > 0 && asks === 0 && (
          <span title={`${unread} unread`} style={{ color: "var(--wb-accent)", letterSpacing: 0 }}>
            ● {unread}
          </span>
        )}
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
      <button
        type="button"
        aria-pressed={speech.prefs.on}
        aria-label={speech.prefs.on ? "Speak is on: Duck uses its voice. Click to turn it off" : "Speak is off: Duck stays silent. Click to turn it on"}
        title={speech.prefs.on ? "Speak on (click: off)" : "Speak off (click: on)"}
        onClick={() => setSpeakOn(!speech.prefs.on)}
        style={{
          background: "transparent",
          border: "none",
          padding: "0 2px",
          cursor: "pointer",
          font: "12px var(--wb-mono)",
          color: speech.prefs.on ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
        }}
      >
        {speech.prefs.on ? "🔊" : "🔇"}
      </button>
      {dnd && (
        <button
          type="button"
          title={`Do Not Disturb ${untilText(dndUntil)} (click: off)`}
          aria-label={`Do Not Disturb ${untilText(dndUntil)}. Click to turn it off`}
          onClick={() => setDnd(null)}
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--wb-working)", font: "12px var(--wb-mono)" }}
        >
          ☾
        </button>
      )}
      {menu && (
        <div
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 28,
            left: 0,
            zIndex: 201,
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: 4,
            font: "11px var(--wb-mono)",
            display: "flex",
            flexDirection: "column",
            minWidth: 200,
          }}
        >
          <span style={{ padding: "3px 8px", color: "var(--wb-textFaint)" }}>
            Do Not Disturb{dnd ? `: on ${untilText(dndUntil)}` : ""}
          </span>
          {(
            [
              ["for 1 hour", () => Date.now() + 3_600_000],
              ["until morning", () => nextMorning(Date.now())],
              ["until I turn it off", () => DND_FOREVER],
            ] as const
          ).map(([label, until]) => (
            <button key={label} type="button" role="menuitem" style={menuItem} onClick={() => (setDnd(until()), setMenu(false))}>
              {label}
            </button>
          ))}
          {dnd && (
            <button type="button" role="menuitem" style={menuItem} onClick={() => (setDnd(null), setMenu(false))}>
              off
            </button>
          )}
        </div>
      )}

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
          <span style={{ color: "var(--wb-textFaint)" }}>Right-click: Do Not Disturb</span>
        </div>
      )}
    </div>
  );
}

const menuItem: React.CSSProperties = {
  background: "transparent",
  border: "none",
  textAlign: "left",
  padding: "4px 8px",
  cursor: "pointer",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
};
