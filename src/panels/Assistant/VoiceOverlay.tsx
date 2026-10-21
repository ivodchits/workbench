// The listening sign (2026-10-21), the page of the `voice-overlay` window
// (`src-tauri/src/voice/overlay.rs`, loaded with `?overlay=voice`): Duck's icon
// with three sound waves on each side, shaped like parentheses and bigger the
// further out they are, appearing and fading outwards in a loop. In the theme's
// accent; the theme is read again each time listening starts, so a switch made
// since shows. The window is shown only while voice input is on.

import { useEffect } from "react";
import { getPref } from "../../ipc/prefs";
import { onVoiceState } from "../../ipc/voice";
import { applyTheme, DEFAULT_THEME_ID, themeById } from "../../theme/tokens";
import DuckIcon from "./DuckIcon";

async function loadTheme(): Promise<void> {
  applyTheme(themeById(await getPref("themeId", DEFAULT_THEME_ID).catch(() => DEFAULT_THEME_ID)).tokens);
}

/** One side's waves: `dir` 1 opens to the right, -1 to the left. */
function Waves({ dir }: { dir: 1 | -1 }) {
  return (
    <svg width="58" height="56" viewBox="-29 -28 58 56" aria-hidden style={{ overflow: "visible" }}>
      {[0, 1, 2].map((i) => {
        // Further out: further from the duck, taller and a little bolder.
        const x = dir * (-16 + i * 13);
        const h = 9 + i * 6;
        const bulge = dir * (4 + i * 2);
        return (
          <path
            key={i}
            d={`M ${x} ${-h} Q ${x + bulge * 2} 0 ${x} ${h}`}
            fill="none"
            stroke="var(--wb-accent)"
            strokeWidth={2.6 + i * 0.4}
            strokeLinecap="round"
            style={{ animation: `wb-wave 1.4s ease-in-out ${i * 0.22}s infinite`, opacity: 0 }}
          />
        );
      })}
    </svg>
  );
}

export default function VoiceOverlay() {
  useEffect(() => {
    // A window of its own: no page background, nothing to select.
    for (const el of [document.documentElement, document.body]) el.style.background = "transparent";
    document.body.style.userSelect = "none";
    void loadTheme();
    const off = onVoiceState(({ state }) => {
      if (state === "listening") void loadTheme();
    });
    return () => void off.then((f) => f());
  }, []);
  return (
    <div
      role="status"
      aria-label="Duck is listening"
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        // Readable over light and dark windows alike.
        filter: "drop-shadow(0 0 2px rgba(0,0,0,0.85)) drop-shadow(0 0 6px rgba(0,0,0,0.5))",
      }}
    >
      <style>{`@keyframes wb-wave { 0% { opacity: 0 } 30% { opacity: 1 } 70% { opacity: 1 } 100% { opacity: 0 } }`}</style>
      <Waves dir={-1} />
      <DuckIcon size={38} />
      <Waves dir={1} />
    </div>
  );
}
