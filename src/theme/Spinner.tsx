// Braille working-spinner — the CLI-style frame cycle (§5.x). Used wherever a
// card/console is actively working. Pure presentational; color comes from the
// caller (defaults to the `working` status token).

import { useEffect, useState } from "react";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./glyphs";

interface SpinnerProps {
  /** Color (any CSS color or `var(--wb-…)`). Defaults to the working token. */
  color?: string;
  /** Font size in px; inherits if omitted. */
  size?: number;
}

function Spinner({ color = "var(--wb-working)", size }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      aria-hidden
      style={{ color, fontSize: size, display: "inline-block", lineHeight: 1 }}
    >
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

export default Spinner;
