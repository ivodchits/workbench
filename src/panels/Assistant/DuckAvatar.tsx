// The ASCII duck at the top of Duck's drawer (`duckCanvas.ts` draws it, the phone's
// Duck view too). While a reply is spoken (V2), `level` gives the loudness of
// what's playing, so the beak opens on the syllables actually heard; otherwise it
// follows a stand-in rhythm.
//
// The loop runs only while the duck is on screen; the look (ink, characters,
// columns, frame rate) comes from the drawer's prefs.

import { useEffect, useRef } from "react";
import type { DuckAvatarPrefs } from "../../ipc/prefs";
import { startDuckCanvas } from "./duckCanvas";
import type { DuckMode } from "./duck3d";

export default function DuckAvatar({
  mode,
  level,
  prefs,
  running,
}: {
  mode: DuckMode;
  /** The speech loudness now (0..1), read each frame; absent: the stand-in rhythm. */
  level?: () => number;
  prefs: DuckAvatarPrefs;
  running: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ mode, look: prefs, level });
  live.current = { mode, look: prefs, level };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !running) return;
    return startDuckCanvas(canvas, () => live.current);
  }, [running]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ display: "block", width: "100%", height: "100%", fontFamily: "var(--wb-mono)", color: "var(--wb-text)" }}
    />
  );
}
