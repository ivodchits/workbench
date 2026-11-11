// The reminders widget (step H8): a red dot with the count of open reminders, in
// the upper-left corner of the duck (or of the chat with the duck hidden). A click
// lists their titles only: those with a time first, then the shown project's, then
// general ones. The full text stays with Duck (`list_reminders`). In the drawer each
// row has Done and Dismiss, the same change Duck's tools make, with its chip in the
// thread (undo from there); elsewhere, done and dismiss go through Duck. It pulses
// when one comes up (due, or a project's on a new session), and shows nothing when
// there are none.
//
// The same dot (`ReminderDot`) sits in the title bar after the Duck button, the duck
// and the speaker, for the general ones; a project's show as a crumb on its tile in
// the rail (`ProjectReminders`). Neither has the buttons.

import { useEffect, useMemo, useRef, useState } from "react";
import { closeReminder } from "../../assistant";
import { widgetOrder, type ReminderView } from "../../assistant/reminders";
import { useActiveProject } from "../../state/activeProject";
import { useDuckState } from "./duckState";

/** The drawer's dot, with Done and Dismiss on each row. */
export default function RemindersBadge(props: { reminders: ReminderView[]; problem: string | null; pulse: number }) {
  if (!props.reminders.length && !props.problem) return null;
  return (
    <div style={{ position: "absolute", top: 6, left: 8, zIndex: 3 }}>
      <ReminderDot {...props} actions />
    </div>
  );
}

/** The general reminders (no project) as a dot, for the title bar. */
export function GeneralReminders() {
  const duck = useDuckState();
  const general = useMemo(() => duck.reminders.filter((r) => !r.project), [duck.reminders]);
  return <ReminderDot reminders={general} problem={duck.remindersProblem} pulse={duck.remindersPulse} size={15} />;
}

/** A project's open reminders as a crumb on its rail tile; nothing without any. */
export function ProjectReminders({ projectId }: { projectId: string }) {
  const reminders = useDuckState().reminders;
  const mine = reminders.filter((r) => r.project?.id === projectId);
  if (!mine.length) return null;
  const overdue = mine.some((r) => r.overdue);
  return (
    <span
      title={mine.map((r) => `• ${r.title}${r.due ? ` (${r.due})` : ""}`).join("\n")}
      style={{ color: overdue ? "var(--wb-needs)" : "var(--wb-working)" }}
    >
      ● {mine.length} reminder{mine.length === 1 ? "" : "s"}
    </span>
  );
}

/** The dot with the count, and the list of titles on a click. */
export function ReminderDot({
  reminders,
  problem,
  pulse,
  size = 18,
  actions = false,
}: {
  reminders: ReminderView[];
  problem: string | null;
  /** Goes up each time one comes up. */
  pulse: number;
  size?: number;
  /** Done and Dismiss on each row (the drawer's only). */
  actions?: boolean;
}) {
  const project = useActiveProject();
  const [open, setOpen] = useState(false);
  /** The rows being closed, and why the last one couldn't be. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const dot = useRef<HTMLButtonElement>(null);

  const close = (id: string, state: "done" | "dismissed") => {
    setFailed(null);
    setBusy((b) => new Set(b).add(id));
    closeReminder(id, state)
      .catch((e: unknown) => setFailed(`Couldn't close it: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() =>
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        }),
      );
  };

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
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={dot}
        type="button"
        onClick={() => setOpen(!open)}
        title={problem ?? `${reminders.length} open reminder${reminders.length === 1 ? "" : "s"}`}
        aria-expanded={open}
        style={{
          minWidth: size,
          height: size,
          padding: `0 ${size > 16 ? 5 : 4}px`,
          borderRadius: size / 2,
          border: "none",
          background: "var(--wb-needs)",
          color: "var(--wb-bg)",
          font: `600 ${size > 16 ? 11 : 9.5}px var(--wb-mono)`,
          lineHeight: `${size}px`,
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
            top: size + 4,
            left: 0,
            zIndex: 202,
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
          {failed && <div style={{ padding: "3px 10px", color: "var(--wb-needs)" }}>{failed}</div>}
          {list.map((r) => (
            <div
              key={r.id}
              role="listitem"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 10px", color: "var(--wb-text)", opacity: busy.has(r.id) ? 0.5 : 1 }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              <span style={{ color: r.overdue ? "var(--wb-needs)" : "var(--wb-textFaint)", whiteSpace: "nowrap" }}>
                {r.due ?? (r.project && r.project.id !== project ? r.project.name : "")}
              </span>
              {actions && (
                <span style={{ display: "inline-flex", gap: 2 }}>
                  <RowButton label="✓" title="Done" disabled={busy.has(r.id)} onClick={() => close(r.id, "done")} />
                  <RowButton label="✕" title="Dismiss" disabled={busy.has(r.id)} onClick={() => close(r.id, "dismissed")} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RowButton(props: { label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        width: 18,
        height: 18,
        padding: 0,
        border: "1px solid var(--wb-border)",
        borderRadius: 3,
        background: "transparent",
        color: "var(--wb-textFaint)",
        font: "11px var(--wb-mono)",
        lineHeight: "16px",
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      {props.label}
    </button>
  );
}
