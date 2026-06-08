// A click-to-edit text field used for the instance task note and inline rename
// (step 1.4). Renders as plain text until activated, then becomes a borderless
// input that blends into the rail. Enter / blur commits; Escape cancels. Empty
// commits are rejected when `required`, so a rename can't blank the title.

import { useEffect, useRef, useState, type CSSProperties } from "react";

interface InlineEditProps {
  value: string;
  /** Persist the trimmed value. Not called when unchanged or (if required) empty. */
  onCommit: (next: string) => void;
  /** Externally controlled editing state. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  placeholder?: string;
  /** Reject empty commits (used for the title). */
  required?: boolean;
  /** Style for both the static text and the input, so they line up exactly. */
  style?: CSSProperties;
  /** Static-text-only style (e.g. ellipsis); dropped while editing. */
  textStyle?: CSSProperties;
  ariaLabel?: string;
}

function InlineEdit({
  value,
  onCommit,
  editing,
  onEditingChange,
  placeholder,
  required,
  style,
  textStyle,
  ariaLabel,
}: InlineEditProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft whenever we (re)enter edit mode or the source value changes.
  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Focus + select on the next tick so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, value]);

  const commit = () => {
    const next = draft.trim();
    if (required && !next) {
      onEditingChange(false);
      return;
    }
    if (next !== value) onCommit(next);
    onEditingChange(false);
  };

  if (!editing) {
    return (
      <span
        onDoubleClick={() => onEditingChange(true)}
        title={value || placeholder}
        style={{ ...style, ...textStyle }}
      >
        {value || <span style={{ color: "var(--wb-textFaint)" }}>{placeholder}</span>}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onEditingChange(false);
        }
        e.stopPropagation();
      }}
      style={{
        ...style,
        background: "var(--wb-bg)",
        border: "1px solid var(--wb-borderActive)",
        borderRadius: 2,
        padding: "1px 4px",
        margin: "-2px 0",
        outline: "none",
        width: "100%",
      }}
    />
  );
}

export default InlineEdit;
