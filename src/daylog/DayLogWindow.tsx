// The daily log's window (improvement plan J2): any day's log, for every project or
// one, from this machine's copy of Duck's repo (so it works with the main away, as
// of the last sync). Refresh, edits and the backfill go to Duck's main through the
// main window (`assistant/daylogBridge.ts`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import type { DayEntries, Entry, Step } from "../assistant/daylog";
import type { DayLogEvent, DayLogRequest, Where } from "../assistant/daylogBridge";
import { daylogDay, daylogDays, onDaylogChanged, type LogCopy } from "../ipc/daylog";
import { initAppearance } from "../state/appearance";
import { byProject, copyText, dayOf, dayTitle, hhmm, monthGrid, readDay, shiftDay, statusWord } from "./model";

/** The copy is looked at again this often (another machine's mirror syncs on its own). */
const POLL_MS = 15_000;

type Change = { title?: string; detail?: string | null; hidden?: boolean };

/** Ask the main window; the answer comes back as `daylog-event`s with this id. */
function ask(r: DayLogRequest): void {
  void emit("daylog-request", r).catch(() => {});
}

function stepWords(s: Step, dayName: (d: string) => string): string {
  switch (s.step) {
    case "reading":
      return `reading ${s.machine}'s sessions`;
    case "writing":
      return "writing up";
    case "tidying":
      return `tidying ${dayName(s.day)}`;
    case "saving":
      return "saving";
    case "done":
      return "done";
  }
}

const button: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "11px var(--wb-mono)",
  padding: "3px 9px",
  cursor: "pointer",
};

export default function DayLogWindow() {
  const [now, setNow] = useState(() => Date.now());
  const today = dayOf(now);
  const [day, setDay] = useState(today);
  const [copy, setCopy] = useState<LogCopy | null>(null);
  const [log, setLog] = useState<DayEntries | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [where, setWhere] = useState<Where | null>(null);
  const [run, setRun] = useState<{ id: string; what: string; step: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  const load = useCallback(async (d: string) => {
    const [c, raw] = await Promise.all([daylogDays(), daylogDay(d)]);
    setCopy(c);
    setLog(readDay(d, raw));
  }, []);

  useEffect(() => {
    void initAppearance();
    document.title = "Daily log — Workbench";
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  useEffect(() => {
    void load(day).catch((e: unknown) => setError(String(e)));
    setEditing(null);
    setMenu(null);
  }, [day, load]);

  // Live: a save here, and a look now and then for a mirror's sync.
  useEffect(() => {
    const again = () => {
      setNow(Date.now());
      void load(day).catch(() => {});
    };
    const timer = setInterval(again, POLL_MS);
    const off = onDaylogChanged(again);
    return () => {
      clearInterval(timer);
      void off.then((f) => f());
    };
  }, [day, load]);

  // The main window's answers.
  useEffect(() => {
    const off = listen<DayLogEvent>("daylog-event", ({ payload: ev }) => {
      if (ev.type === "where") {
        setWhere({ available: ev.available, main: ev.main, why: ev.why });
        return;
      }
      const cur = runRef.current;
      if (!cur || ev.requestId !== cur.id) return;
      if (ev.type === "daylog.step") {
        setRun({ ...cur, step: stepWords(ev.step, (d) => (d === dayOf(Date.now()) ? "today" : dayTitle(d))) });
        return;
      }
      setRun(null);
      if (ev.error) setError(ev.error);
      else if (ev.report?.away.length) setError(`Couldn't read ${ev.report.away.join(", ")} now; its work is read when it's back.`);
      else if (ev.report?.capped) setError("Duck's budget cap was reached; the rest is read once there's room.");
      void load(day).catch(() => {});
    });
    const whereNow = () => ask({ requestId: "where", kind: "where" });
    whereNow();
    const timer = setInterval(whereNow, POLL_MS);
    return () => {
      clearInterval(timer);
      void off.then((f) => f());
    };
  }, [day, load]);

  const send = (what: string, msg: Extract<DayLogRequest, { kind: "send" }>["msg"]) => {
    setError(null);
    setRun({ id: msg.requestId, what, step: "starting" });
    ask({ requestId: msg.requestId, kind: "send", msg });
  };
  const refresh = () => send("refresh", { type: "daylog.run", requestId: crypto.randomUUID(), what: "refresh" });
  const edit = (id: string, change: Change) =>
    send("edit", { type: "daylog.edit", requestId: crypto.randomUUID(), day, id, change });

  const entries = useMemo(() => log?.entries ?? [], [log]);
  const groups = useMemo(() => byProject(entries, showHidden), [entries, showHidden]);
  const hiddenCount = entries.filter((e) => e.hidden).length;
  const shown = project ? groups.filter((g) => g.project === project) : groups;
  const marked = useMemo(() => new Set((copy?.days ?? []).filter((d) => d.entries > 0).map((d) => d.day)), [copy]);

  // ← and → move by day; Esc closes the calendar or a menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") setDay((d) => shiftDay(d, -1));
      else if (e.key === "ArrowRight") setDay((d) => (d < today ? shiftDay(d, 1) : d));
      else if (e.key === "Escape") {
        setCalendar(false);
        setMenu(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [today]);

  const doCopy = async () => {
    await navigator.clipboard.writeText(copyText(day, shown));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const status: string[] = [];
  if (log?.tidiedAt) status.push(`updated ${hhmm(log.tidiedAt)}`);
  if (copy?.mirrored) status.push(`the main's log as of ${copy.syncedAt ? hhmm(copy.syncedAt * 1000) : "no sync yet"}`);
  const refreshOff = run !== null || !where?.available;
  const refreshWhy = !where ? "" : where.available ? (where.main ? `runs on ${where.main}` : "") : (where.why ?? "");

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        font: "12.5px var(--wb-mono)",
        overflow: "hidden",
      }}
    >
      {/* The day bar. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "var(--wb-titlebar)",
          borderBottom: "1px solid var(--wb-border)",
          position: "relative",
        }}
      >
        <button type="button" style={button} onClick={() => setDay(shiftDay(day, -1))} aria-label="the day before" title="the day before (←)">
          ‹
        </button>
        <span style={{ minWidth: 190, textAlign: "center", color: "var(--wb-text)" }}>{dayTitle(day, now)}</span>
        <button
          type="button"
          style={{ ...button, opacity: day >= today ? 0.35 : 1, cursor: day >= today ? "default" : "pointer" }}
          disabled={day >= today}
          onClick={() => setDay(shiftDay(day, 1))}
          aria-label="the day after"
          title="the day after (→)"
        >
          ›
        </button>
        <button type="button" style={button} onClick={() => setCalendar((c) => !c)} aria-label="calendar" title="pick a day">
          ▦
        </button>
        {day !== today && (
          <button type="button" style={button} onClick={() => setDay(today)}>
            today
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" style={button} onClick={() => void doCopy()} title={project ? "copy this project's day" : "copy the day"}>
          {copied ? "copied" : "copy"}
        </button>
        <button
          type="button"
          style={{ ...button, color: refreshOff ? "var(--wb-textFaint)" : "var(--wb-accent)", cursor: refreshOff ? "default" : "pointer" }}
          disabled={refreshOff}
          onClick={refresh}
          title={refreshWhy || "capture and tidy now"}
        >
          {run?.what === "refresh" ? "refreshing…" : "refresh"}
        </button>
        {calendar && (
          <Calendar
            day={day}
            today={today}
            marked={marked}
            pick={(d) => {
              setDay(d);
              setCalendar(false);
            }}
          />
        )}
      </div>

      {/* What the log is, and what's running. */}
      <div style={{ padding: "4px 12px", color: "var(--wb-textFaint)", fontSize: 11, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {status.map((s) => (
          <span key={s}>{s}</span>
        ))}
        {run && <span style={{ color: "var(--wb-working)" }}>{run.step}…</span>}
        {!run && where && !where.available && <span>{where.why}</span>}
        {error && <span style={{ color: "var(--wb-needs)" }}>{error}</span>}
      </div>

      {copy?.started && copy.backfill === null && (
        <div style={{ margin: "4px 12px 8px", padding: "8px 10px", border: "1px solid var(--wb-borderActive)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 240 }}>
            Build the log for the past 30 days, from the transcripts and git history on every machine? It runs in the background, on Duck's
            budget.
          </span>
          <button
            type="button"
            style={{ ...button, color: "var(--wb-accent)" }}
            disabled={refreshOff}
            onClick={() => send("backfill", { type: "daylog.run", requestId: crypto.randomUUID(), what: "backfill" })}
          >
            build
          </button>
          <button
            type="button"
            style={button}
            disabled={refreshOff}
            onClick={() => send("decline", { type: "daylog.run", requestId: crypto.randomUUID(), what: "declineBackfill" })}
          >
            no thanks
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* The day's projects. */}
        <div style={{ width: 190, flex: "0 0 190px", borderRight: "1px solid var(--wb-border)", overflowY: "auto", padding: "6px 0" }}>
          <ProjectRow label="All projects" count={groups.reduce((n, g) => n + g.entries.length, 0)} on={project === null} pick={() => setProject(null)} />
          {groups.map((g) => (
            <ProjectRow key={g.project} label={g.name} count={g.entries.length} on={project === g.project} pick={() => setProject(g.project)} />
          ))}
          {hiddenCount > 0 && (
            <button type="button" style={{ ...button, border: "none", margin: "8px 10px", padding: 0, fontSize: 10.5 }} onClick={() => setShowHidden((h) => !h)}>
              {showHidden ? "leave out hidden" : `${hiddenCount} hidden: show`}
            </button>
          )}
        </div>

        {/* The entries. */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "8px 14px 20px" }} onClick={() => setMenu(null)}>
          {!shown.length && (
            <div style={{ color: "var(--wb-textFaint)", marginTop: 20 }}>
              {copy && !copy.started
                ? "Nothing yet. The log is written while you work, every 30 minutes."
                : project && groups.length
                  ? "Nothing for this project."
                  : "Nothing logged this day."}
            </div>
          )}
          {shown.map((g) => (
            <div key={g.project} style={{ marginBottom: 16 }}>
              {project === null && (
                <div style={{ color: "var(--wb-accent)", fontSize: 11.5, letterSpacing: "0.06em", margin: "6px 0 4px", textTransform: "uppercase" }}>
                  {g.name}
                </div>
              )}
              {g.entries.map((e) => (
                <EntryRow
                  key={e.id}
                  e={e}
                  editing={editing === e.id}
                  menuOpen={menu === e.id}
                  busy={run !== null}
                  canChange={!!where?.available}
                  openMenu={() => setMenu(menu === e.id ? null : e.id)}
                  startEdit={() => {
                    setMenu(null);
                    setEditing(e.id);
                  }}
                  cancel={() => setEditing(null)}
                  save={(change) => {
                    setEditing(null);
                    edit(e.id, change);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ label, count, on, pick }: { label: string; count: number; on: boolean; pick: () => void }) {
  return (
    <button
      type="button"
      onClick={pick}
      style={{
        display: "flex",
        width: "100%",
        gap: 8,
        padding: "4px 10px",
        background: on ? "var(--wb-sel)" : "transparent",
        border: "none",
        borderLeft: `2px solid ${on ? "var(--wb-accent)" : "transparent"}`,
        color: on ? "var(--wb-text)" : "var(--wb-textDim2)",
        font: "11.5px var(--wb-mono)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ color: "var(--wb-textFaint)" }}>{count}</span>
    </button>
  );
}

function EntryRow(props: {
  e: Entry;
  editing: boolean;
  menuOpen: boolean;
  busy: boolean;
  canChange: boolean;
  openMenu: () => void;
  startEdit: () => void;
  cancel: () => void;
  save: (c: Change) => void;
}) {
  const { e } = props;
  const [title, setTitle] = useState(e.title);
  const [detail, setDetail] = useState(e.detail ?? "");
  useEffect(() => {
    setTitle(e.title);
    setDetail(e.detail ?? "");
  }, [e.title, e.detail, props.editing]);
  const mark = statusWord(e);
  const dim = e.status === "reverted" || e.hidden;
  if (props.editing) {
    return (
      <div style={{ padding: "6px 0", display: "flex", flexDirection: "column", gap: 6 }}>
        <input
          autoFocus
          value={title}
          onChange={(x) => setTitle(x.target.value)}
          style={{ font: "12.5px var(--wb-mono)", background: "var(--wb-bgInset, var(--wb-bg))", color: "var(--wb-text)", border: "1px solid var(--wb-borderActive)", padding: "4px 6px" }}
        />
        <textarea
          value={detail}
          placeholder="a detail line (optional)"
          onChange={(x) => setDetail(x.target.value)}
          rows={2}
          style={{ font: "12px var(--wb-mono)", background: "var(--wb-bgInset, var(--wb-bg))", color: "var(--wb-text)", border: "1px solid var(--wb-border)", padding: "4px 6px", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={{ ...button, color: "var(--wb-accent)" }} disabled={!title.trim()} onClick={() => props.save({ title, detail: detail.trim() || null })}>
            save
          </button>
          <button type="button" style={button} onClick={props.cancel}>
            cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, padding: "5px 0", opacity: dim ? 0.55 : 1, position: "relative" }}>
      <span style={{ color: "var(--wb-textFaint)", fontSize: 11, flex: "0 0 40px", paddingTop: 1 }}>{hhmm(e.from)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          {e.title}
          {mark && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                padding: "0 5px",
                border: `1px solid ${e.status === "in_progress" ? "var(--wb-working)" : "var(--wb-border)"}`,
                color: e.status === "in_progress" ? "var(--wb-working)" : "var(--wb-textFaint)",
                display: "inline-block",
              }}
            >
              {mark}
            </span>
          )}
          {e.edited && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--wb-textFaint)" }}>edited</span>}
        </div>
        {e.detail && <div style={{ color: "var(--wb-textDim2)", fontSize: 11.5, marginTop: 2 }}>{e.detail}</div>}
      </div>
      <span style={{ color: "var(--wb-textFaint)", fontSize: 10, whiteSpace: "nowrap", paddingTop: 2 }} title="the machines it was done on">
        {e.machines.join(" · ")}
      </span>
      <button
        type="button"
        aria-label="entry menu"
        style={{ ...button, border: "none", padding: "0 4px", color: "var(--wb-textFaint)" }}
        disabled={props.busy || !props.canChange}
        title={props.canChange ? "edit or hide" : "Duck's main isn't reachable"}
        onClick={(x) => {
          x.stopPropagation();
          props.openMenu();
        }}
      >
        ⋯
      </button>
      {props.menuOpen && (
        <div
          onClick={(x) => x.stopPropagation()}
          style={{ position: "absolute", right: 0, top: 22, zIndex: 5, background: "var(--wb-panel)", border: "1px solid var(--wb-borderActive)", display: "flex", flexDirection: "column", minWidth: 110 }}
        >
          <button type="button" style={{ ...button, border: "none", textAlign: "left" }} onClick={props.startEdit}>
            edit
          </button>
          <button type="button" style={{ ...button, border: "none", textAlign: "left" }} onClick={() => props.save({ hidden: !e.hidden })}>
            {e.hidden ? "show" : "hide"}
          </button>
        </div>
      )}
    </div>
  );
}

function Calendar({ day, today, marked, pick }: { day: string; today: string; marked: ReadonlySet<string>; pick: (d: string) => void }) {
  const [ym, setYm] = useState(() => {
    const [y, m] = day.split("-").map(Number);
    return { y, m };
  });
  const weeks = monthGrid(ym.y, ym.m, marked, today);
  const move = (n: number) => setYm(({ y, m }) => ({ y: m + n > 12 ? y + 1 : m + n < 1 ? y - 1 : y, m: ((m + n + 11) % 12) + 1 }));
  const title = new Date(ym.y, ym.m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const atLatest = ym.y > ty || (ym.y === ty && ym.m >= tm);
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 12,
        zIndex: 10,
        background: "var(--wb-panel)",
        border: "1px solid var(--wb-borderActive)",
        padding: 10,
        font: "11.5px var(--wb-mono)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <button type="button" style={button} onClick={() => move(-1)} aria-label="the month before">
          ‹
        </button>
        <span style={{ flex: 1, textAlign: "center" }}>{title}</span>
        <button type="button" style={{ ...button, opacity: atLatest ? 0.35 : 1 }} disabled={atLatest} onClick={() => move(1)} aria-label="the month after">
          ›
        </button>
      </div>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
              <th key={d} style={{ color: "var(--wb-textFaint)", fontWeight: "normal", padding: "2px 6px" }}>
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w[0].day}>
              {w.map((c) => (
                <td key={c.day} style={{ padding: 1 }}>
                  <button
                    type="button"
                    disabled={c.future}
                    onClick={() => pick(c.day)}
                    style={{
                      width: 28,
                      height: 24,
                      background: c.day === day ? "var(--wb-sel)" : "transparent",
                      border: c.today ? "1px solid var(--wb-accent)" : "1px solid transparent",
                      color: c.future ? "var(--wb-textFaint)" : c.inMonth ? "var(--wb-text)" : "var(--wb-textFaint)",
                      opacity: c.future ? 0.4 : 1,
                      font: "11px var(--wb-mono)",
                      cursor: c.future ? "default" : "pointer",
                      position: "relative",
                    }}
                  >
                    {c.n}
                    {c.marked && (
                      <span style={{ position: "absolute", bottom: 2, left: "50%", width: 4, height: 4, marginLeft: -2, background: "var(--wb-accent)", borderRadius: 2 }} />
                    )}
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" style={{ ...button, marginTop: 6, width: "100%" }} onClick={() => pick(today)}>
        Today
      </button>
    </div>
  );
}
