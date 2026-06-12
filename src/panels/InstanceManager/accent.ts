// Per-instance accent overlay (step 3.9). An instance's optional accent color
// overrides the theme's structural accent on just that instance's surfaces — its
// rail card and its console panel. Both spread these CSS custom properties onto
// their root element, so every `var(--wb-accent)` (corner glyphs, branch, worktree
// marker, focus bar) inside re-tints, while the rest of the app keeps the theme
// accent. A null accent returns an empty object → pure theme inheritance.

import type { CSSProperties } from "react";

/** CSS-var overrides for an instance accent, or `{}` when it inherits the theme.
 *  Typed loosely (custom props aren't in `CSSProperties`) but safe to spread. */
export function accentVars(accent: string | null): CSSProperties {
  if (!accent) return {};
  return {
    "--wb-accent": accent,
    "--wb-selBar": accent,
    "--wb-borderActive": accent,
  } as CSSProperties;
}
