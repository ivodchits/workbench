// Another machine's session, in a tab here (fleet plan F9.2, decision 6): what the
// phone can do with it, from the desktop. Like a local console it switches between
// its transcript and its terminal:
//
// - **Transcript:** the local console's own `TranscriptView`, bound to that
//   machine (`fleet`): fed over its `/api/transcript` (`transcript/fleetSource.ts`),
//   the composer sending `prompt`, and over it the card for a prompt the session
//   waits on, from the machine's snapshot, answered with `choose`.
// - **Terminal:** an xterm on that machine's `/api/term`, as the phone's console
//   mirror: the scrollback replayed on connect, raw keys up. It keeps the owner's
//   size (the `size` frame) and never resizes the other machine's terminal; a
//   smaller panel scales it down.
//
// Everything rides the fleet view (`fleet::view`): its snapshot for the session's
// state, its sockets for the rest. The tab's binding (machine and instance) lives
// in the panel params, so it survives layout saves like a plan tab.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { Terminal } from "@xterm/xterm";

import { Spinner } from "../theme";
import { deriveXtermTheme, mono } from "../theme/tokens";
import { fleetSocketOpen, type FleetSocket } from "../ipc/fleet";
import type { RemoteInstance, TermControl } from "../remote/protocol";
import { withQuery } from "../transcript/fleetSource";
import type { LiveStatus } from "../state/status";
import { formatTokens } from "../util/format";
import { registerScrollTerminal } from "../keyboard/pageScroll";
import TranscriptView from "./TranscriptView";
import {
  remoteConsolePanelId,
  sendRemote,
  useMachineName,
  useRemoteInstance,
  type RemoteConsoleParams,
} from "./remoteSession";
import { setViewMode, useViewMode, type ViewMode } from "../state/viewMode";


function RemoteConsole(props: IDockviewPanelProps<RemoteConsoleParams>) {
  const { machine, remoteInstance } = props.params;
  const name = useMachineName(machine);
  const { inst, online } = useRemoteInstance(machine, remoteInstance);
  // Kept in the view-mode store like a local console's, so a project switch (which
  // unmounts the tab) brings it back showing what it showed.
  const viewKey = remoteConsolePanelId(machine, remoteInstance);
  const mode = useViewMode(viewKey, "transcript");
  const setMode = (m: ViewMode) => setViewMode(viewKey, m);
  const title = inst?.title ?? props.params.title;

  useEffect(() => {
    props.api.setTitle(`${title} · ${name}`);
  }, [props.api, title, name]);

  // Killed (from the rail here or over there): close the tab, as a local console's
  // does. Only once this tab has seen the session, so a snapshot taken before that
  // machine's registry loaded doesn't close a restored tab.
  const seen = useRef(false);
  useEffect(() => {
    if (inst) seen.current = true;
    else if (online && seen.current) props.api.close();
  }, [inst, online, props.api]);

  const phase = inst?.phase ?? null;
  const live = useMemo(() => liveOf(inst), [inst]);
  const status = !online
    ? `${name} · offline`
    : !inst
      ? "this session is gone"
      : inst.compacting
        ? "compacting…"
        : phase === "working"
          ? "working"
          : phase === "needs_you"
            ? "needs you"
            : phase === "done"
              ? "done"
              : inst.live
                ? "idle"
                : "not running";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "5px 12px",
          borderBottom: "1px solid var(--wb-border)",
          font: "11px var(--wb-mono)",
          color: "var(--wb-textDim2)",
        }}
      >
        <span style={{ color: "var(--wb-accent)", fontWeight: 600 }}>{name}</span>
        <span style={{ color: "var(--wb-text)" }}>{title}</span>
        <span style={{ color: phase === "needs_you" ? "var(--wb-needs)" : "var(--wb-textFaint)" }}>
          {phase === "working" && <Spinner size={10} color="var(--wb-working)" />} {status}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {inst && inst.live && phase === "working" && (
            <HeaderButton onClick={() => sendRemote(machine, { type: "interrupt", instanceId: remoteInstance })}>
              interrupt
            </HeaderButton>
          )}
          {inst && !inst.live && (
            <HeaderButton onClick={() => sendRemote(machine, { type: "start", instanceId: remoteInstance })}>
              start
            </HeaderButton>
          )}
          {inst && inst.live && (
            <HeaderButton onClick={() => sendRemote(machine, { type: "stop", instanceId: remoteInstance })}>
              stop
            </HeaderButton>
          )}
          <HeaderButton onClick={() => setMode(mode === "transcript" ? "terminal" : "transcript")}>
            {mode === "transcript" ? "terminal ▸" : "transcript ▸"}
          </HeaderButton>
          {inst && inst.ctxTokens > 0 && <span>ctx {formatTokens(inst.ctxTokens)}</span>}
        </span>
      </div>
      {!online ? (
        <div className="wb-txv-empty" style={{ padding: 20 }}>
          {name} is offline. This tab comes back to life when it does.
        </div>
      ) : mode === "transcript" ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <TranscriptView
            instanceId={fleetKey(machine, remoteInstance)}
            live={live}
            onShowTerminal={() => setMode("terminal")}
            fleet={{
              machine,
              instance: remoteInstance,
              running: inst?.live ?? false,
              choice: inst?.phase === "needs_you" ? inst.choice : null,
            }}
          />
        </div>
      ) : (
        <RemoteTerminal
          machine={machine}
          instance={remoteInstance}
          live={inst?.live ?? false}
          onStart={() => sendRemote(machine, { type: "start", instanceId: remoteInstance })}
        />
      )}
    </div>
  );
}

/** The key a remote session's draft and sent prompts go by here. */
const fleetKey = (machine: string, instance: string) => `fleet:${machine}:${instance}`;

/** The snapshot's status in the shape the transcript view takes. */
function liveOf(inst: RemoteInstance | null): LiveStatus | null {
  if (!inst?.phase) return null;
  return {
    phase: inst.phase,
    compacting: inst.compacting,
    subagents: inst.subagents,
    activity: inst.activity,
    updatedAt: 0,
    needsSince: inst.needsSince,
    reason: null,
  };
}

function HeaderButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        font: "11px var(--wb-mono)",
        color: "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

// --- the terminal -----------------------------------------------------------------

const RECONNECT_MS = 1500;

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function RemoteTerminal({
  machine,
  instance,
  live,
  onStart,
}: {
  machine: string;
  instance: string;
  live: boolean;
  onStart: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [notRunning, setNotRunning] = useState(false);
  const [conn, setConn] = useState<"connecting" | "live" | "dropped">("connecting");
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [scale, setScale] = useState(1);
  // A start from here: connect again once it's running.
  const liveKey = live ? 1 : 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: mono,
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorBlink: true,
      scrollback: 5000,
      theme: deriveXtermTheme(),
    });
    term.open(host);
    registerScrollTerminal(term);
    termRef.current = term;
    let socket: FleetSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const enc = new TextEncoder();
    const keys = term.onData((d) => socket?.sendBytes(enc.encode(d)));
    const binKeys = term.onBinary((d) => socket?.sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));

    const connect = () => {
      retry = null;
      if (stopped) return;
      setConn("connecting");
      fleetSocketOpen(machine, withQuery("/api/term", { instance }), (m) => {
        if (stopped) return;
        if (m.t === "open") {
          term.reset();
          setConn("live");
          setNotRunning(false);
        } else if (m.t === "text") {
          let ctl: TermControl;
          try {
            ctl = JSON.parse(m.d) as TermControl;
          } catch {
            return;
          }
          if (ctl.type === "notrunning") setNotRunning(true);
          else if (ctl.type === "size") {
            term.resize(ctl.cols, ctl.rows);
            setSize({ cols: ctl.cols, rows: ctl.rows });
          }
        } else if (m.t === "bin") {
          term.write(base64Bytes(m.d));
        } else if (m.t === "closed") {
          socket = null;
          setConn("dropped");
          if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
        }
      })
        .then((s) => {
          if (stopped) s.close();
          else socket = s;
        })
        .catch(() => {
          if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
        });
    };
    connect();
    term.focus();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      keys.dispose();
      binKeys.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [machine, instance, liveKey]);

  // Scale the owner's size down to fit the panel, never up, and never resize it.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host) return;
    const fit = () => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const w = screen.offsetWidth;
      const h = screen.offsetHeight;
      if (!w || !h) return;
      setScale(Math.min(1, wrap.clientWidth / w, wrap.clientHeight / h));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [size]);

  const note = useMemo(() => {
    if (notRunning) return "not running";
    if (conn === "connecting") return "connecting…";
    if (conn === "dropped") return "reconnecting…";
    return null;
  }, [notRunning, conn]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: "var(--wb-termBg, #000)" }}>
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: "max-content", visibility: notRunning ? "hidden" : "visible" }}
      />
      {note && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 12,
            font: "11px var(--wb-mono)",
            color: "var(--wb-textFaint)",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          {note}
          {notRunning && (
            <HeaderButton onClick={onStart}>start it</HeaderButton>
          )}
        </div>
      )}
    </div>
  );
}

export default RemoteConsole;
