// Removing and resuming another machine's session from here (fleet plan F9.4): the
// rail's kill (✕, with its confirmation) and the resume picker (Ctrl+Shift+R's), for
// a remote card. Both act on the machine that has the session: a `delete` or
// `resume` action there (`state/remoteActions`), which its server takes from a
// fleet machine only. The resume picker reads that machine's conversations from its
// `/api/sessions`. Not for an SSH project's sessions (`inst.remote`): those are
// tmux sessions on a host, and killing one wants a password typed over there.

import { useEffect, useMemo, useRef, useState } from "react";

import Modal from "./InstanceManager/Modal";
import { fleetViewSessions } from "../ipc/fleet";
import type { SessionSummary } from "../ipc/sessions";
import type { RemoteInstance } from "../remote/protocol";
import { useFleetViews } from "../state/fleetView";
import { GLYPH } from "../theme";
import { sendRemote } from "./remoteSession";
import { Empty, Hint, InstanceRow, PaneLabel, SessionRow } from "./ResumePicker";
import { cancelBtnStyle, confirmBtnStyle, hintRowStyle, phaseDot, searchStyle, warnRowStyle } from "./resumePickerParts";
import { closeRemoteDialog, useRemoteDialog, type Target } from "../state/remoteSessionDialogs";

/** Always mounted beside the rail. */
export default function RemoteSessionDialogs() {
  const t = useRemoteDialog();
  if (!t) return null;
  return t.kind === "kill" ? <KillRemote t={t} /> : <ResumeRemote t={t} />;
}

function KillRemote({ t }: { t: Target }) {
  const { inst, machine, machineName } = t;
  const kill = () => {
    closeRemoteDialog();
    sendRemote(machine, { type: "delete", instanceId: inst.id });
  };
  return (
    <Modal title="kill instance" onClose={closeRemoteDialog} width={400}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Kill <strong style={{ color: "var(--wb-accent)" }}>{inst.title}</strong> in <strong>{inst.projectName}</strong>{" "}
        on{" "}
        <strong style={{ color: "var(--wb-accent)" }}>
          {GLYPH.remote} {machineName}
        </strong>
        ? This stops its console there and removes the instance from its rail.
        <div style={{ marginTop: 8, font: "11px var(--wb-mono)", color: "var(--wb-textDim2)" }}>
          {inst.taskNote && <div>{inst.taskNote}</div>}
          {inst.branch && <div>⌥ {inst.branch}</div>}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={closeRemoteDialog} style={cancelBtnStyle}>
          cancel
        </button>
        <button onClick={kill} style={confirmBtnStyle} autoFocus>
          kill
        </button>
      </div>
    </Modal>
  );
}

function ResumeRemote({ t }: { t: Target }) {
  const { machine, machineName } = t;
  const views = useFleetViews();
  const snapshot = views.get(machine)?.snapshot ?? null;

  // That machine's instances of the same project, as its latest snapshot has them
  // (SSH ones left out): the left pane.
  const instances = useMemo(
    () => (snapshot?.instances ?? []).filter((i) => i.projectId === t.inst.projectId && !i.remote),
    [snapshot, t.inst.projectId],
  );
  const [targetId, setTargetId] = useState(t.inst.id);
  const targetIdx = Math.max(
    0,
    instances.findIndex((i) => i.id === targetId),
  );
  const inst: RemoteInstance | undefined = instances[targetIdx];

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState<SessionSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const instId = inst?.id ?? "";
  useEffect(() => {
    if (!instId) {
      setSessions([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setSessions([]);
    setSelected(0);
    setConfirm(null);
    fleetViewSessions(machine, instId)
      .then((r) => {
        if (!alive) return;
        setSessions(r.sessions);
        setLastSessionId(r.lastSessionId);
        setDir(r.workingDir);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [machine, instId]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.firstPrompt.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q));
  }, [sessions, query]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  const busy = inst?.phase === "working" || inst?.phase === "needs_you";

  const doResume = (session: SessionSummary) => {
    if (!inst) return;
    closeRemoteDialog();
    sendRemote(machine, { type: "resume", instanceId: inst.id, sessionId: session.sessionId });
  };

  const attemptResume = (session: SessionSummary | undefined) => {
    if (!session || !inst) return;
    if (busy) {
      setConfirm(session);
      return;
    }
    doResume(session);
  };

  const cycle = (dir: 1 | -1) => {
    if (instances.length < 2) return;
    setTargetId(instances[(targetIdx + dir + instances.length) % instances.length].id);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (confirm) {
      if (e.key === "Enter") {
        e.preventDefault();
        doResume(confirm);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
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
        e.stopPropagation();
        cycle(e.shiftKey ? -1 : 1);
        break;
    }
  };

  return (
    <Modal
      title={
        <>
          resume a session on {GLYPH.remote} {machineName}
        </>
      }
      onClose={closeRemoteDialog}
      width={760}
    >
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
          <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <PaneLabel>instance</PaneLabel>
            <div style={{ display: "flex", flexDirection: "column", maxHeight: "52vh", overflowY: "auto" }}>
              {!snapshot ? (
                <Empty>{machineName} is offline</Empty>
              ) : instances.length === 0 ? (
                <Empty>no instances in this project</Empty>
              ) : (
                instances.map((i, n) => (
                  <InstanceRow
                    key={i.id}
                    inst={i}
                    dot={phaseDot(i.phase ?? undefined)}
                    selected={n === targetIdx}
                    onSelect={() => {
                      setTargetId(i.id);
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                  />
                ))
              )}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <PaneLabel>
              sessions
              {dir ? <span style={{ color: "var(--wb-textFaint)" }}> · {dir}</span> : null}
            </PaneLabel>
            <div style={{ display: "flex", flexDirection: "column", maxHeight: "52vh", overflowY: "auto" }}>
              {!inst ? (
                <Empty>pick an instance</Empty>
              ) : loading ? (
                <Empty>reading sessions on {machineName}…</Empty>
              ) : error ? (
                <Empty>{error}</Empty>
              ) : results.length === 0 ? (
                <Empty>{sessions.length === 0 ? "no sessions for this directory" : "no match"}</Empty>
              ) : (
                results.map((s, n) => (
                  <SessionRow
                    key={s.sessionId}
                    session={s}
                    selected={n === selected}
                    current={s.sessionId === lastSessionId}
                    // That machine doesn't say which conversation is running; its
                    // last one is, while its console is.
                    live={inst.live && s.sessionId === lastSessionId}
                    onHover={() => setSelected(n)}
                    onRun={() => attemptResume(s)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {confirm && inst ? (
          <div style={warnRowStyle}>
            <span style={{ color: "var(--wb-needs)" }}>⚠</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{inst.title}</b> is {inst.phase === "needs_you" ? "waiting on you" : "working"} — resume anyway? This
              ends its current session.
            </span>
            <button
              style={confirmBtnStyle}
              onMouseDown={(e) => {
                e.preventDefault();
                doResume(confirm);
              }}
            >
              resume anyway
            </button>
            <button
              style={cancelBtnStyle}
              onMouseDown={(e) => {
                e.preventDefault();
                setConfirm(null);
              }}
            >
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
              {busy ? " · ⚠ instance busy" : ""}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
