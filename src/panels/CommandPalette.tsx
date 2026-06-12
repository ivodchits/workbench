// Command palette (step 3.10) — the universal keyboard-first fallback (design §5.y):
// fuzzy-search every global action, see its binding, run it with Enter. Opened with
// Ctrl+Shift+A (or the title-bar button), it lists the runnable global-scope commands
// from the live keymap, so a remap shows up here immediately. Rail single-keys are
// context keys (they act on the focused rail row) and live in the keymap editor, which
// this palette can open like any other action ("Edit keyboard shortcuts").
//
// Keyboard: type to filter · ↑/↓ select · Enter run · Esc close. The search field
// keeps focus the whole time; ↑/↓/Enter are handled on it so the list never needs
// focus. Running a command closes the palette first, then dispatches, so an action
// that opens another modal (templates, keymap editor) lands cleanly.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import Modal from "./InstanceManager/Modal";
import { registerCommand } from "../keyboard/bus";
import { runAction } from "../keyboard/commands";
import { useBindings, type Binding } from "../keyboard/keymap";
import { prettyChord } from "./keymapFormat";

/** Always-mounted host: opens the palette on the `openCommandPalette` command. */
export default function CommandPaletteHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => registerCommand("openCommandPalette", () => setOpen(true)), []);
  if (!open) return null;
  return <CommandPalette onClose={() => setOpen(false)} />;
}

interface Action {
  binding: Binding;
  /** Lower-cased haystack for matching: title + chord. */
  hay: string;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const bindings = useBindings();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // The runnable set: every global-scope action. A command can have alternate
  // chords (none do in global scope today), so dedupe by command+arg, preferring
  // the bound chord for display.
  const actions = useMemo<Action[]>(() => {
    const byCmd = new Map<string, Binding>();
    for (const b of bindings) {
      if (b.scope !== "global") continue;
      const key = b.arg != null ? `${b.command}:${b.arg}` : b.command;
      const prev = byCmd.get(key);
      if (!prev || (prev.chord === "" && b.chord !== "")) byCmd.set(key, b);
    }
    return Array.from(byCmd.values()).map((binding) => ({
      binding,
      hay: `${binding.title} ${binding.chord}`.toLowerCase(),
    }));
  }, [bindings]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions
      .map((a) => ({ a, score: fuzzyScore(a.hay, q) }))
      .filter((r) => r.score >= 0)
      .sort((x, y) => x.score - y.score || x.a.binding.title.localeCompare(y.a.binding.title))
      .map((r) => r.a);
  }, [actions, query]);

  // Keep the selection in range as the result set shrinks/grows.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  const run = (a: Action | undefined) => {
    if (!a) return;
    onClose();
    runAction(a.binding.command, a.binding.arg);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((s) => Math.min(results.length - 1, s + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
        break;
      case "Enter":
        e.preventDefault();
        run(results[selected]);
        break;
      // Esc bubbles to the Modal, which closes — nothing to do here.
    }
  };

  return (
    <Modal title="command palette" onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="search commands…"
          spellCheck={false}
          autoFocus
          style={searchStyle}
        />

        <div style={{ display: "flex", flexDirection: "column", maxHeight: "52vh", overflowY: "auto" }}>
          {results.length === 0 ? (
            <div style={{ font: "11.5px var(--wb-mono)", color: "var(--wb-textFaint)", padding: "10px 4px" }}>
              no matching command
            </div>
          ) : (
            results.map((a, i) => (
              <ActionRow
                key={a.binding.id}
                action={a}
                selected={i === selected}
                onHover={() => setSelected(i)}
                onRun={() => run(a)}
              />
            ))
          )}
        </div>

        <div style={hintRowStyle}>
          <Hint k="↑↓" v="select" />
          <Hint k="↵" v="run" />
          <Hint k="esc" v="close" />
          <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
            {results.length} {results.length === 1 ? "command" : "commands"}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function ActionRow({
  action,
  selected,
  onHover,
  onRun,
}: {
  action: Action;
  selected: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const { chord } = action.binding;
  return (
    <div
      ref={rowRef}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault(); // keep focus in the search field
        onRun();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 9px",
        cursor: "pointer",
        borderLeft: `2px solid ${selected ? "var(--wb-selBar)" : "transparent"}`,
        background: selected ? "var(--wb-sel)" : "transparent",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, font: "12.5px var(--wb-mono)", color: "var(--wb-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {action.binding.title}
      </span>
      {chord ? (
        <KeyCap chord={chord} />
      ) : (
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", fontStyle: "italic" }}>
          unbound
        </span>
      )}
    </div>
  );
}

/** A binding rendered as small keycaps, e.g. `Ctrl Shift A`. */
export function KeyCap({ chord }: { chord: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {prettyChord(chord).map((part, i) => (
        <span
          key={i}
          style={{
            font: "10.5px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            border: "1px solid var(--wb-border)",
            background: "var(--wb-bg)",
            padding: "1px 5px",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          {part}
        </span>
      ))}
    </span>
  );
}

/**
 * Subsequence fuzzy score: lower is better, -1 = no match. Rewards contiguous runs
 * and an early first match, so "newins" ranks "New instance…" above incidental hits.
 */
function fuzzyScore(hay: string, q: string): number {
  let hi = 0;
  let firstAt = -1;
  let gaps = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = hi; i < hay.length; i++) {
      if (hay[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return -1;
    if (firstAt === -1) firstAt = found;
    if (lastMatch !== -1 && found > lastMatch + 1) gaps += found - lastMatch - 1;
    lastMatch = found;
    hi = found + 1;
  }
  return firstAt + gaps;
}

function Hint({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <span style={{ color: "var(--wb-accent)" }}>{k}</span> {v}
    </span>
  );
}

const searchStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-borderActive)",
  padding: "8px 10px",
  fontFamily: "var(--wb-mono)",
  fontSize: 13,
  outline: "none",
};

const hintRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  borderTop: "1px solid var(--wb-border)",
  paddingTop: 9,
  font: "10px var(--wb-mono)",
  color: "var(--wb-textFaint)",
};
