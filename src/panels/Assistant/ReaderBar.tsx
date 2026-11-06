// The reader bar (V3): what's being read aloud, where, and its buttons. In Duck's
// drawer it shows every read; a session's transcript view shows it for reads of
// that session's messages (its listen buttons, `assistant/listen.ts`).

import { useEffect, useState } from "react";
import { listenStateOf, type ListenRequest } from "../../assistant/listen";
import "../../theme/transcript.css";
import { controlReader, listenToMessage, useDuckState } from "./duckState";

/** How long a listen button's "can't" stays up. */
const NOTE_MS = 6000;

const small: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "1px 7px",
  cursor: "pointer",
};

/** `only`: shown only for reads whose key starts with this. */
export default function ReaderBar({ only, style }: { only?: string; style?: React.CSSProperties }) {
  const r = useDuckState().reader;
  if (!r || (only !== undefined && !r.key.startsWith(only))) return null;
  return (
    <div
      role="status"
      style={{ display: "flex", alignItems: "center", gap: 6, font: "11px var(--wb-mono)", color: "var(--wb-textDim2)", ...style }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {r.state === "reading" ? "♪ reading" : "❚❚ paused"} {r.title} · {r.section + 1}/{r.sections}
        {r.where === "phone" ? " · on the phone" : ""}
      </span>
      <button type="button" title="Previous section" style={small} disabled={r.section === 0} onClick={() => controlReader("prev")}>
        ⏮
      </button>
      <button
        type="button"
        title={r.state === "reading" ? "Pause (Esc)" : "Go on"}
        style={small}
        onClick={() => controlReader(r.state === "reading" ? "pause" : "resume")}
      >
        {r.state === "reading" ? "❚❚" : "▶"}
      </button>
      <button
        type="button"
        title="Next section"
        style={small}
        disabled={r.section + 1 >= r.sections}
        onClick={() => controlReader("next")}
      >
        ⏭
      </button>
      <button type="button" title="Stop reading (the place is kept)" style={small} onClick={() => controlReader("stop")}>
        ■
      </button>
    </div>
  );
}

/** A message's listen button (`assistant/listen.ts`), for React views (Duck's
 *  replies in the drawer): read it, stop it, go on with it. Drawn as the
 *  transcript's (`.wb-tx-listen`, its label by CSS); its parent should be
 *  `position: relative` and show it on hover. Why it can't read shows under it. */
export function ListenButton({ req }: { req: ListenRequest }) {
  const state = listenStateOf(useDuckState().reader, req.key);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  const label = state === "reading" ? "stop reading" : state === "paused" ? "go on reading" : "listen";
  return (
    <>
      <button
        type="button"
        className={`wb-tx-listen${state === "reading" ? " wb-tx-listening" : state === "paused" ? " wb-tx-listen-paused" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={state !== null}
        onClick={(e) => {
          e.stopPropagation();
          setNote(null);
          void listenToMessage(req)
            .then(setNote)
            .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)));
        }}
      />
      {note && (
        <div role="status" className="wb-duck-listen-note">
          {note}
        </div>
      )}
    </>
  );
}
