// Shared Git-panel components — the small row / section / button pieces every tab
// (and the commit box) draws with. Extracted from `index.tsx` in G1, the first
// step to need them from a second file; the remaining tabs move out beside them as
// later steps touch them. The glyph/colour maps and shared style objects live in
// `format.ts` — a module that exports both components and non-literal constants
// breaks React fast refresh, so the value half is kept separate.

import { useState } from "react";

/**
 * A section label. Pass `open` + `onToggle` to make it a collapsible section's
 * header — it grows a twisty and the whole strip becomes the hit target, except
 * for any real `<button>` inside it (the "stage all" / "stash" mini-actions),
 * which keep their own click.
 */
export function SectionHead({
  children,
  open,
  onToggle,
}: {
  children: React.ReactNode;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      onClick={
        onToggle &&
        ((e: React.MouseEvent) => {
          if ((e.target as HTMLElement).closest("button")) return;
          onToggle();
        })
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 14px 4px",
        font: "600 10px var(--wb-mono)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--wb-accent)",
        cursor: onToggle ? "pointer" : undefined,
        userSelect: onToggle ? "none" : undefined,
      }}
    >
      {/* A span, not a button: the container's own handler covers it, and a real
          button here would be excluded by the `closest("button")` guard above. */}
      {onToggle && (
        <span aria-hidden style={{ width: 7, color: "var(--wb-textDim2)", font: "8px var(--wb-mono)" }}>
          {open ? "▾" : "▸"}
        </span>
      )}
      {children}
    </div>
  );
}

/** A hover-revealed glyph action on a row. */
export function RowAction({
  children,
  onClick,
  label,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        if (disabled) return;
        onClick(e);
      }}
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        lineHeight: 1,
        font: "12px var(--wb-mono)",
        color: disabled ? "var(--wb-textFaint)" : danger ? "var(--wb-needs)" : "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

/**
 * A flat text button for the header / action bars. `title` carries the *reason* a
 * button is disabled — a greyed control with no explanation is the thing the panel
 * is trying to stop doing.
 */
export function HeaderButton({
  children,
  onClick,
  accent,
  danger,
  disabled,
  title,
}: {
  children: React.ReactNode;
  /** The event is passed through for the buttons that open a menu at the pointer
   *  (G5's select-by-status); callers that don't care can ignore it. */
  onClick: (e: React.MouseEvent) => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const color = disabled
    ? "var(--wb-textFaint)"
    : danger
      ? "var(--wb-needs)"
      : accent
        ? "var(--wb-accent)"
        : "var(--wb-textDim2)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color,
        font: "11px var(--wb-mono)",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

/** A centred placeholder for an empty pane. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--wb-textFaint)",
        font: "12px var(--wb-mono)",
        padding: 24,
        textAlign: "center",
        background: "var(--wb-bg)",
      }}
    >
      {children}
    </div>
  );
}

/** A checkbox + label pair, used for the commit box's amend toggle. */
export function CheckLabel({
  checked,
  onChange,
  disabled,
  title,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <label
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        font: "10.5px var(--wb-mono)",
        color: disabled
          ? "var(--wb-textFaint)"
          : checked || hover
            ? "var(--wb-text)"
            : "var(--wb-textDim2)",
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, cursor: disabled ? "default" : "pointer" }}
      />
      {children}
    </label>
  );
}
