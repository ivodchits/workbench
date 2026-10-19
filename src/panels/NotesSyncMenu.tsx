// Notes sync menu (step N3) — the status-bar control for syncing project notes across
// machines through a private git repo. Off by default. Here you create the repo (a
// private GitHub repo made with `gh`, after a confirm), join one that exists (this
// machine's notes are merged in), sync now, or stop. Below that are the sync's
// notices: conflict copies, notes brought back, links found, an hour of failing.
// Mirrors the RemoteAccessMenu's upward popover.

import { useEffect, useRef, useState } from "react";

import { notesSyncCreate, notesSyncDisable, notesSyncJoin, notesSyncNow } from "../ipc/notes";
import { markNoticesSeen, useNotesSync } from "../state/notesSync";
import { formatAgo } from "../util/format";

type Mode = { kind: "idle" } | { kind: "create"; name: string; confirm: boolean } | { kind: "join"; url: string };

export default function NotesSyncMenu() {
  const { status, notices, unseen } = useNotesSync();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    markNoticesSeen();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, notices.length]);

  const on = status?.remote != null;
  const state = status?.state ?? "off";

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode({ kind: "idle" });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const label =
    state === "syncing" ? "notes ↻" : state === "failing" ? "notes ✕" : on ? "notes ●" : "notes ○";
  const color = state === "failing" ? "var(--wb-needs)" : on ? "var(--wb-accent)" : "var(--wb-textFaint)";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="notes sync across machines"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        {label}
        {unseen > 0 && <span style={{ color: "var(--wb-needs)" }}>· {unseen}</span>}
      </button>

      {open && (
        <div style={popover}>
          <SectionLabel>notes sync</SectionLabel>
          {!status?.available ? (
            <Note>Notes sync runs in the installed app. This build keeps its notes in notes.dev, which never syncs.</Note>
          ) : on ? (
            <>
              <Row>
                <span style={{ color: "var(--wb-text)", flex: 1 }}>
                  {state === "syncing"
                    ? "syncing…"
                    : state === "failing"
                      ? "not syncing — retrying"
                      : status.lastSync
                        ? `synced ${formatAgo(status.lastSync / 1000)}`
                        : "on"}
                </span>
                <button type="button" disabled={busy} style={miniBtn} onClick={() => void notesSyncNow()}>
                  sync now
                </button>
              </Row>
              <Row>
                <code style={{ flex: 1, color: "var(--wb-textDim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={status.remote ?? ""}>
                  {status.remote}
                </code>
                <button type="button" disabled={busy} style={miniBtn} onClick={() => void act(notesSyncDisable)}>
                  stop
                </button>
              </Row>
              {status.error && <Note tone="error">{status.error}</Note>}
              <Note>this machine: {status.machine}</Note>
            </>
          ) : mode.kind === "create" ? (
            <>
              <Row>
                <span style={{ color: "var(--wb-textFaint)" }}>repo</span>
                <input
                  autoFocus
                  value={mode.name}
                  spellCheck={false}
                  onChange={(e) => setMode({ ...mode, name: e.target.value, confirm: false })}
                  style={input}
                />
              </Row>
              {mode.confirm ? (
                <>
                  <Note>
                    This runs <code>gh repo create {mode.name} --private</code> on your GitHub account and pushes this
                    machine&apos;s notes to it.
                  </Note>
                  <Row>
                    <span style={{ flex: 1 }} />
                    <button type="button" style={miniBtn} onClick={() => setMode({ kind: "idle" })}>
                      cancel
                    </button>
                    <button type="button" disabled={busy} style={accentBtn} onClick={() => void act(() => notesSyncCreate(mode.name))}>
                      {busy ? "creating…" : "create it"}
                    </button>
                  </Row>
                </>
              ) : (
                <Row>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={miniBtn} onClick={() => setMode({ kind: "idle" })}>
                    cancel
                  </button>
                  <button type="button" disabled={!mode.name.trim()} style={accentBtn} onClick={() => setMode({ ...mode, confirm: true })}>
                    next
                  </button>
                </Row>
              )}
            </>
          ) : mode.kind === "join" ? (
            <>
              <Row>
                <span style={{ color: "var(--wb-textFaint)" }}>url</span>
                <input
                  autoFocus
                  value={mode.url}
                  placeholder="https://github.com/you/workbench-notes"
                  spellCheck={false}
                  onChange={(e) => setMode({ kind: "join", url: e.target.value })}
                  style={input}
                />
              </Row>
              <Note>This machine&apos;s notes are merged in; nothing is overwritten.</Note>
              <Row>
                <span style={{ flex: 1 }} />
                <button type="button" style={miniBtn} onClick={() => setMode({ kind: "idle" })}>
                  cancel
                </button>
                <button type="button" disabled={busy || !mode.url.trim()} style={accentBtn} onClick={() => void act(() => notesSyncJoin(mode.url))}>
                  {busy ? "joining…" : "join"}
                </button>
              </Row>
            </>
          ) : (
            <>
              <Note>Keep project notes (and the project toolbar&apos;s plugins.json) the same on every PC, in a private git repo.</Note>
              <Row>
                <button type="button" style={accentBtn} onClick={() => setMode({ kind: "create", name: "workbench-notes", confirm: false })}>
                  create repo…
                </button>
                <button type="button" style={miniBtn} onClick={() => setMode({ kind: "join", url: "" })}>
                  join existing…
                </button>
              </Row>
            </>
          )}
          {error && <Note tone="error">{error}</Note>}

          {notices.length > 0 && (
            <>
              <Divider />
              <SectionLabel>notices</SectionLabel>
              {[...notices].reverse().slice(0, 12).map((n, i) => (
                <div key={`${n.at}-${i}`} style={{ padding: "3px 12px", fontSize: 10.5, lineHeight: 1.5 }}>
                  <span style={{ color: n.kind === "conflict" || n.kind === "failing" ? "var(--wb-needs)" : "var(--wb-textDim2)" }}>
                    {n.kind}
                  </span>{" "}
                  <span style={{ color: "var(--wb-text)" }}>{n.text}</span>{" "}
                  <span style={{ color: "var(--wb-textFaint)" }}>{formatAgo(n.at / 1000)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const popover: React.CSSProperties = {
  position: "absolute",
  bottom: 22,
  left: 0,
  zIndex: 200,
  width: 380,
  maxHeight: "80vh",
  overflowY: "auto",
  background: "var(--wb-panel)",
  border: "1px solid var(--wb-border)",
  boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
  padding: "10px 0",
  font: "11px var(--wb-mono)",
};

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "10px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 8px",
};

const accentBtn: React.CSSProperties = { ...miniBtn, color: "var(--wb-accent)" };

const input: React.CSSProperties = {
  flex: 1,
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "11px var(--wb-mono)",
  padding: "3px 6px",
  outline: "none",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--wb-textFaint)", letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 9.5, padding: "2px 12px 4px" }}>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px" }}>{children}</div>;
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div style={{ color: tone === "error" ? "var(--wb-needs)" : "var(--wb-textFaint)", padding: "2px 12px 4px", fontSize: 10, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />;
}
