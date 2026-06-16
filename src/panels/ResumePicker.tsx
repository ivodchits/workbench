// Resume picker (step 4.x) — the Ctrl+Shift+R session chooser.
//
// Replaces the old "resume the instance's last session, only if idle" shortcut with
// a two-pane popup: pick a target *instance* (left) and one of its Claude *sessions*
// (right) — the original session plus every `/clear` rotation child, listed by the
// backend `list_project_sessions`. Resuming routes through `resumeConsole`, which
// spawns `claude --resume <id>` and (crucially) registers the id with the hook
// server, so the resumed session's status correlates instead of being dropped.
//
// Keyboard: type to filter sessions · ↑/↓ select · ⇥ switch instance · ↵ resume ·
// esc close. Mouse: click an instance to target it, click a session to resume, hover
// to highlight. Resuming into an instance that's *working* or *needs you* first asks
// for confirmation rather than tearing its live session down silently.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import Modal from "./InstanceManager/Modal";
import { registerCommand } from "../keyboard/bus";
import { getRegistry, useRegistry } from "../state/registry";
import { useResumePicker, closeResumePicker, openResumePicker } from "../state/resumePicker";
import { getLiveStatuses, useLiveStatuses, type StatusPhase } from "../state/status";
import { getActiveConsoleId, resumeConsole, useConsoles } from "../state/consoles";
import { setActiveProject, getActiveProject } from "../state/activeProject";
import { activatePanel } from "../state/dock";
import { listProjectSessions, type SessionSummary } from "../ipc/sessions";
import type { Instance } from "../ipc/registry";

/** Always-mounted host: opens the picker on the `resumeLastSession` command, scoped
 *  to the focused/active instance's project (so the shortcut keeps its target). */
export default function ResumePickerHost() {
  const { open } = useResumePicker();
  useEffect(
    () =>
      registerCommand("resumeLastSession", () => {
        // Resolve the invoking instance the same way the old handler did: the rail
        // card with keyboard focus, else the active console's instance.
        const { instances } = getRegistry();
        const focusedId = (document.activeElement as HTMLElement | null)?.dataset.wbInstanceId;
        const inst = instances.find((i) => i.id === (focusedId ?? getActiveConsoleId() ?? ""));
        const projectId = inst?.projectId ?? getActiveProject();
        if (!projectId) return; // nothing to scope to
        openResumePicker(projectId, inst?.id ?? null);
      }),
    [],
  );
  if (!open) return null;
  return <ResumePicker />;
}

/** Phase → status glyph + color for the instance list (mirrors the rail palette). */
function phaseDot(phase: StatusPhase | undefined): { glyph: string; color: string } | null {
  switch (phase) {
    case "working":
      return { glyph: "◐", color: "var(--wb-working)" };
    case "needs_you":
      return { glyph: "●", color: "var(--wb-needs)" };
    case "done":
      return { glyph: "○", color: "var(--wb-done)" };
    default:
      return null;
  }
}

function ago(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ResumePicker() {
  const { projectId, preselectInstanceId } = useResumePicker();
  const reg = useRegistry();
  const statuses = useLiveStatuses();

  // The project's instances, in rail order — the left-pane choices.
  const instances = useMemo(
    () =>
      reg.instances
        .filter((i) => i.projectId === projectId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [reg.instances, projectId],
  );

  const [targetIdx, setTargetIdx] = useState(() => {
    const i = instances.findIndex((x) => x.id === preselectInstanceId);
    return i >= 0 ? i : 0;
  });
  // Keep the target index valid if the instance set changes under us.
  useEffect(() => {
    setTargetIdx((i) => Math.min(i, Math.max(0, instances.length - 1)));
  }, [instances.length]);

  const target: Instance | undefined = instances[targetIdx];

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState<SessionSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the target instance's sessions whenever the target changes.
  const targetDir = target?.workingDir ?? "";
  useEffect(() => {
    if (!targetDir) {
      setSessions([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setSessions([]);
    setSelected(0);
    setConfirm(null);
    listProjectSessions(targetDir)
      .then((rows) => {
        if (alive) {
          setSessions(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setSessions([]);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [targetDir]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.firstPrompt.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Session ids currently running in a live console (so we can flag them "live").
  const consolesState = useConsoles();
  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of consolesState.open) {
      if (c.status === "running" && c.sessionId) set.add(c.sessionId);
    }
    return set;
  }, [consolesState.open]);

  const targetPhase = target ? statuses.get(target.id)?.phase : undefined;
  const targetBusy = targetPhase === "working" || targetPhase === "needs_you";

  const doResume = (session: SessionSummary) => {
    if (!target) return;
    setActiveProject(target.projectId);
    closeResumePicker();
    resumeConsole(target, session.sessionId);
    // Win the focus race against the project swap-in reconcile (see dock.ts).
    activatePanel(target.id);
  };

  const attemptResume = (session: SessionSummary | undefined) => {
    if (!session || !target) return;
    // Read phase fresh, not the render-time snapshot.
    const phase = getLiveStatuses().get(target.id)?.phase;
    if (phase === "working" || phase === "needs_you") {
      setConfirm(session);
      return;
    }
    doResume(session);
  };

  const cycleInstance = (dir: 1 | -1) => {
    if (instances.length < 2) return;
    setTargetIdx((i) => (i + dir + instances.length) % instances.length);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (confirm) {
      if (e.key === "Enter") {
        e.preventDefault();
        doResume(confirm);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // keep the dialog open; just cancel the confirm
        setConfirm(null);
      }
      return;
    }
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
        attemptResume(results[selected]);
        break;
      case "Tab":
        e.preventDefault();
        e.stopPropagation(); // override the Modal's focus trap — Tab switches instance
        cycleInstance(e.shiftKey ? -1 : 1);
        break;
      // Esc bubbles to the Modal, which closes.
    }
  };

  return (
    <Modal title="resume a session" onClose={closeResumePicker} width={760}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="filter sessions…"
          spellCheck={false}
          autoFocus
          style={searchStyle}
        />

        <div style={{ display: "flex", gap: 10, minHeight: 0 }}>
          {/* Left: target instance */}
          <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <PaneLabel>instance</PaneLabel>
            <div style={{ display: "flex", flexDirection: "column", maxHeight: "52vh", overflowY: "auto" }}>
              {instances.length === 0 ? (
                <Empty>no instances in this project</Empty>
              ) : (
                instances.map((inst, i) => (
                  <InstanceRow
                    key={inst.id}
                    inst={inst}
                    dot={phaseDot(statuses.get(inst.id)?.phase)}
                    selected={i === targetIdx}
                    onSelect={() => {
                      setTargetIdx(i);
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                  />
                ))
              )}
            </div>
          </div>

          {/* Right: sessions for the target instance's working dir */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <PaneLabel>
              sessions
              {target ? <span style={{ color: "var(--wb-textFaint)" }}> · {target.workingDir}</span> : null}
            </PaneLabel>
            <div style={{ display: "flex", flexDirection: "column", maxHeight: "52vh", overflowY: "auto" }}>
              {!target ? (
                <Empty>pick an instance</Empty>
              ) : loading ? (
                <Empty>reading sessions…</Empty>
              ) : results.length === 0 ? (
                <Empty>{sessions.length === 0 ? "no sessions for this directory" : "no match"}</Empty>
              ) : (
                results.map((s, i) => (
                  <SessionRow
                    key={s.sessionId}
                    session={s}
                    selected={i === selected}
                    current={s.sessionId === target.lastSessionId}
                    live={liveSessionIds.has(s.sessionId)}
                    onHover={() => setSelected(i)}
                    onRun={() => attemptResume(s)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {confirm && target ? (
          <div style={warnRowStyle}>
            <span style={{ color: "var(--wb-needs)" }}>⚠</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{target.title}</b> is {targetPhase === "needs_you" ? "waiting on you" : "working"} — resume
              anyway? This ends its current session.
            </span>
            <button style={confirmBtnStyle} onMouseDown={(e) => { e.preventDefault(); doResume(confirm); }}>
              resume anyway
            </button>
            <button style={cancelBtnStyle} onMouseDown={(e) => { e.preventDefault(); setConfirm(null); }}>
              cancel
            </button>
          </div>
        ) : (
          <div style={hintRowStyle}>
            <Hint k="↑↓" v="select" />
            <Hint k="⇥" v="instance" />
            <Hint k="↵" v="resume" />
            <Hint k="esc" v="close" />
            <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)" }}>
              {results.length} {results.length === 1 ? "session" : "sessions"}
              {targetBusy ? " · ⚠ instance busy" : ""}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function InstanceRow({
  inst,
  dot,
  selected,
  onSelect,
}: {
  inst: Instance;
  dot: { glyph: string; color: string } | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 9px",
        cursor: "pointer",
        borderLeft: `2px solid ${selected ? "var(--wb-selBar)" : "transparent"}`,
        background: selected ? "var(--wb-sel)" : "transparent",
      }}
    >
      <span style={{ width: 9, color: dot?.color ?? "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>
        {dot?.glyph ?? "·"}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: "12px var(--wb-mono)",
          color: "var(--wb-text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {inst.title}
      </span>
    </div>
  );
}

function SessionRow({
  session,
  selected,
  current,
  live,
  onHover,
  onRun,
}: {
  session: SessionSummary;
  selected: boolean;
  current: boolean;
  live: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const label = session.firstPrompt || `session ${session.sessionId.slice(0, 8)}`;
  return (
    <div
      ref={rowRef}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
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
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: "12px var(--wb-mono)",
          color: "var(--wb-text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {live ? <Tag color="var(--wb-working)">live</Tag> : current ? <Tag color="var(--wb-done)">current</Tag> : null}
      <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)", whiteSpace: "nowrap" }}>
        {ago(session.modifiedAt)}
      </span>
    </div>
  );
}

function Tag({ children, color }: { children: string; color: string }) {
  return (
    <span
      style={{
        font: "9.5px var(--wb-mono)",
        color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: "0 4px",
        opacity: 0.85,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function PaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: "10px var(--wb-mono)",
        color: "var(--wb-textFaint)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "0 4px 6px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ font: "11.5px var(--wb-mono)", color: "var(--wb-textFaint)", padding: "10px 4px" }}>
      {children}
    </div>
  );
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

const warnRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  borderTop: "1px solid var(--wb-border)",
  paddingTop: 9,
  font: "11px var(--wb-mono)",
  color: "var(--wb-text)",
};

const confirmBtnStyle: CSSProperties = {
  font: "11px var(--wb-mono)",
  color: "var(--wb-needs)",
  background: "transparent",
  border: "1px solid var(--wb-needs)",
  borderRadius: 3,
  padding: "3px 9px",
  cursor: "pointer",
};

const cancelBtnStyle: CSSProperties = {
  font: "11px var(--wb-mono)",
  color: "var(--wb-textDim2)",
  background: "transparent",
  border: "1px solid var(--wb-border)",
  borderRadius: 3,
  padding: "3px 9px",
  cursor: "pointer",
};
