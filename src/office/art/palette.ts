// The office palette (office plan OD.1). Every colour the art uses comes from here,
// so the whole office can be retuned in one place. Swatches come in pairs: a base
// and a shade, which the templates write as a lowercase and an uppercase key.

/** Keys every sprite shares. */
export const INK = {
  o: "#2b1e2f", // outline
  e: "#1d1622", // eye
  w: "#ffffff", // eye highlight
  r: "#ec9a92", // blush
  m: "#8a3f3f", // mouth
  c: "#f4f1ea", // collar / white trim
  g: "#9fd4f0", // lens glint
} as const;

/** Text colour that reads on `hex`: the outline ink on light colours, white on dark. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 160 ? INK.o : "#ffffff";
}

/** A base colour and its shade. */
export interface Swatch {
  base: string;
  shade: string;
}

const sw = (base: string, shade: string): Swatch => ({ base, shade });

export const SKIN = {
  pale: sw("#fde3cd", "#efc2a3"),
  light: sw("#f5cfa8", "#dea67f"),
  medium: sw("#dba57a", "#bb8259"),
  tan: sw("#c08356", "#9c6440"),
  brown: sw("#8f5a3a", "#70432a"),
  deep: sw("#6a432d", "#4e301f"),
} as const;

/** Hair shades are the strand colour: darker on light hair, lighter on black. */
export const HAIR = {
  black: sw("#2a2433", "#4a4058"),
  brown: sw("#6b4329", "#4e2f1c"),
  blonde: sw("#ecc860", "#c99b3b"),
  ginger: sw("#dc6b2f", "#b04f1f"),
  auburn: sw("#913c2b", "#6d2b1d"),
  pink: sw("#f28bb6", "#cc6592"),
  blue: sw("#4f72d8", "#3753ad"),
  gray: sw("#b9b9c6", "#8e8e9e"),
  platinum: sw("#f1e8d2", "#cfc3a6"),
} as const;

export const CLOTH = {
  red: sw("#d94a4a", "#a83434"),
  orange: sw("#f08a3c", "#c4662a"),
  mustard: sw("#d6aa2c", "#a8831c"),
  yellow: sw("#f4c842", "#cc9e2c"),
  green: sw("#4caf6a", "#357d4b"),
  teal: sw("#2fb5b0", "#228480"),
  blue: sw("#4a78d9", "#3456a8"),
  navy: sw("#34437f", "#232e5a"),
  purple: sw("#8e5bd6", "#6a40a8"),
  pink: sw("#ec6fa4", "#c04f83"),
  white: sw("#e9e7e2", "#bdbab3"),
  black: sw("#3a3843", "#26242d"),
} as const;

export const PANTS = {
  denim: sw("#3f5a8f", "#2e4370"),
  charcoal: sw("#3e3e4a", "#2b2b34"),
  khaki: sw("#b89a6a", "#937a50"),
  black: sw("#2b2a33", "#1d1c23"),
  brown: sw("#6e4a33", "#523625"),
} as const;

export const SHOES = {
  dark: "#3a2b26",
  white: "#efece4",
  black: "#1e1c24",
  tan: "#9a5a32",
} as const;

export const GEAR = {
  slate: sw("#4a5070", "#33384f"),
  red: sw("#c94444", "#933030"),
  white: sw("#e6e3dc", "#b8b4ac"),
} as const;
