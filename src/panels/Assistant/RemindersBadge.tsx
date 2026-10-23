// The reminders widget (step H8): a red dot with the count of open reminders, in
// the upper-left corner of the duck (or of the chat with the duck hidden). A click
// lists their titles only: those with a time first, then the shown project's, then
// general ones. The full text stays with Duck (`list_reminders`); done and dismiss
// go through Duck. It pulses when one comes up (due, or a project's on a new
// session), and shows nothing when there are none.

import { useEffect, useRef, useState } from "react";
import { widgetOrder, type ReminderView } from "../../assistant/reminders";
import { useActiveProject } from "../../state/activeProject";

export default function RemindersBadge({
  reminders,
  problem,
  pulse,
}: {
  reminders: ReminderView[];
  problem: string | null;
  /** Goes up each time one comes up. */
  pulse: number;
}) {
  const project = useActiveProject();
  const [open, setOpen] = useState(false);
  const dot = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pulse) dot.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.6)" }, { transform: "scale(1)" }], { duration: 600, iterations: 3 });
  }, [pulse]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!reminders.length && !problem) return null;
  const list = widgetOrder(reminders, project);
  return (
    <div style={{ position: "absolute", top: 6, left: 8, zIndex: 3 }}>
      <button
        ref={dot}
        type="button"
        onClick={() => setOpen(!open)}
        title={problem ?? `${reminders.length} open reminder${reminders.length === 1 ? "" : "s"}`}
        aria-expanded={open}
        style={{
          minWidth: 18,
          height: 18,
          padding: "0 5px",
          borderRadius: 9,
          border: "none",
          background: "var(--wb-needs)",
          color: "var(--wb-bg)",
          font: "600 11px var(--wb-mono)",
          lineHeight: "18px",
          cursor: "pointer",
        }}
      >
        {problem ? "!" : reminders.length}
      </button>
      {open && (
        <div
          role="list"
          style={{
            position: "absolute",
            top: 22,
            left: 0,
            width: 260,
            maxHeight: 240,
            overflowY: "auto",
            padding: "4px 0",
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            borderRadius: 4,
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
          }}
        >
          {problem && <div style={{ padding: "3px 10px", color: "var(--wb-needs)" }}>{problem}</div>}
          {list.map((r) => (
            <div
              key={r.id}
              role="listitem"
              style={{ display: "flex", gap: 8, padding: "3px 10px", color: "var(--wb-text)" }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              <span style={{ color: r.overdue ? "var(--wb-needs)" : "var(--wb-textFaint)", whiteSpace: "nowrap" }}>
                {r.due ?? (r.project && r.project.id !== project ? r.project.name : "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
