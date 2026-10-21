// Duck's icon (step A3): a white silhouette used as a mask, so it takes any colour
// (the theme's accent by default) and follows a theme switch. The eyeless
// version is used at every size.

import duckNoEyePng from "../../assets/duck/duck-no-eye.png";

export default function DuckIcon({
  size = 14,
  color = "var(--wb-accent)",
}: {
  size?: number;
  color?: string;
}) {
  const mask = `url(${duckNoEyePng}) center / contain no-repeat`;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        flex: "0 0 auto",
        width: size,
        height: size,
        background: color,
        mask,
        WebkitMask: mask,
      }}
    />
  );
}
