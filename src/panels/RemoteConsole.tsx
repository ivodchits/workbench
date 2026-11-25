// Another machine's session, in a tab here (fleet plan F9.2, decision 6): what the
// phone can do with it, from the desktop. Like a local console it switches between
// its transcript and its terminal:
//
// - **Transcript:** the feed and renderer the local view uses, fed over that
//   machine's `/api/transcript` (`transcript/fleetSource.ts`). Under it a composer
//   that sends `prompt`, and over it the card for a prompt the session waits on,
//   from the machine's snapshot, answered with `choose`.
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
import { openUrl } from "../ipc/os";
import type { RemoteChoice, RemoteInstance, TermControl } from "../remote/protocol";
import { createFeed, type Feed } from "../transcript/feed";
import { fleetTranscriptSource, withQuery } from "../transcript/fleetSource";
import { createRenderer, renderPendingTool } from "../transcript/render";
import { sendRemote, useMachineName, useRemoteInstance, type RemoteConsoleParams } from "./remoteSession";


function RemoteConsole(props: IDockviewPanelProps<RemoteConsoleParams>) {
  const { machine, remoteInstance } = props.params;
  const name = useMachineName(machine);
  const { inst, online } = useRemoteInstance(machine, remoteInstance);
  const [mode, setMode] = useState<"transcript" | "terminal">("transcript");
  const title = inst?.title ?? props.params.title;

  useEffect(() => {
    props.api.setTitle(`${title} · ${name}`);
  }, [props.api, title, name]);

  const phase = inst?.phase ?? null;
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
        <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
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
        </span>
      </div>
      {!online ? (
        <div className="wb-txv-empty" style={{ padding: 20 }}>
          {name} is offline. This tab comes back to life when it does.
        </div>
      ) : mode === "transcript" ? (
        <RemoteTranscript machine={machine} instance={remoteInstance} inst={inst} onShowTerminal={() => setMode("terminal")} />
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

// --- the transcript ---------------------------------------------------------------

const STICK_PX = 48;

function RemoteTranscript({
  machine,
  instance,
  inst,
  onShowTerminal,
}: {
  machine: string;
  instance: string;
  inst: RemoteInstance | null;
  onShowTerminal: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<Feed | null>(null);
  const [state, setState] = useState({ count: 0, ready: false, loading: false, hasEarlier: false });
  const [link, setLink] = useState(true);
  const stuck = useRef(true);

  useEffect(() => {
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    const renderer = createRenderer(list, {});
    stuck.current = true;
    const feed = createFeed(fleetTranscriptSource(machine, instance, setLink), (why) => {
      const follow = why === "reset" || stuck.current;
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      if (why !== "loading") renderer.update(feed.items);
      if (follow) scroll.scrollTop = scroll.scrollHeight;
      else if (why === "prepend") scroll.scrollTop = top + (scroll.scrollHeight - height);
      setState({ count: feed.items.length, ready: feed.ready, loading: feed.loading, hasEarlier: feed.hasEarlier });
    });
    feedRef.current = feed;
    const onScroll = () => {
      if (scroll.clientHeight === 0) return;
      stuck.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX;
    };
    scroll.addEventListener("scroll", onScroll);
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      feed.stop();
      feedRef.current = null;
      renderer.clear();
    };
  }, [machine, instance]);

  const onLink = (e: React.MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    e.preventDefault();
    void openUrl(a.getAttribute("href") ?? "").catch(() => {});
  };

  const choice = inst?.phase === "needs_you" ? inst.choice : null;

  return (
    <div className="wb-txv" tabIndex={-1} style={{ flex: 1, minHeight: 0 }}>
      <div className="wb-txv-body">
        <div ref={scrollRef} className="wb-txv-scroll" onClick={onLink}>
          {state.hasEarlier && (
            <button
              type="button"
              className="wb-txv-earlier"
              disabled={state.loading}
              onClick={() => void feedRef.current?.loadEarlier()}
            >
              {state.loading ? "loading…" : "↑ load earlier"}
            </button>
          )}
          {state.count === 0 && (
            <div className="wb-txv-empty">
              {!state.ready || state.loading ? "loading…" : "nothing in this session yet"}
            </div>
          )}
          <div ref={listRef} />
          {!link && <div className="wb-txv-status">○ reconnecting…</div>}
        </div>
      </div>
      {choice && <RemoteChoiceCard machine={machine} instance={instance} choice={choice} onShowTerminal={onShowTerminal} />}
      <RemoteComposer machine={machine} instance={instance} disabled={!inst?.live} />
    </div>
  );
}

const KIND_TITLE: Record<RemoteChoice["kind"], string> = { permission: "permission", question: "question", plan: "plan ready" };

function RemoteChoiceCard({
  machine,
  instance,
  choice,
  onShowTerminal,
}: {
  machine: string;
  instance: string;
  choice: RemoteChoice;
  onShowTerminal: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => setSent(null), [choice.id]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || choice.kind === "question") return;
    body.replaceChildren(renderPendingTool(choice.toolName, choice.input));
    return () => body.replaceChildren();
  }, [choice.id, choice.kind, choice.toolName, choice.input]);

  const choose = (option: number | "deny", label: string) => {
    sendRemote(machine, { type: "choose", instanceId: instance, choiceId: choice.id, option });
    setSent(label);
  };
  const shownSent = choice.sent ?? sent;

  return (
    <div className={`wb-chc wb-chc-${choice.kind}`} role="group" aria-label={`${KIND_TITLE[choice.kind]} — waiting for an answer`}>
      <div className="wb-chc-head">
        <span className="wb-chc-kind">● {KIND_TITLE[choice.kind]}</span>
        <span className="wb-chc-tool">{choice.kind === "permission" ? choice.toolName : choice.questions[0]?.header ?? ""}</span>
      </div>
      <div className="wb-chc-content">
        {choice.kind === "question" ? (
          choice.questions.map((q, i) => (
            <div key={i} className="wb-chc-question">
              <div className="wb-chc-question-text">{q.question}</div>
            </div>
          ))
        ) : (
          <div ref={bodyRef} />
        )}
      </div>
      {shownSent ? (
        <div className="wb-chc-note">sent: {shownSent}</div>
      ) : (
        <>
          {choice.terminalOnly ? (
            <div className="wb-chc-note">{choice.terminalOnly}</div>
          ) : (
            <div className="wb-chc-options">
              {choice.options.map((o) => (
                <button key={o.key} type="button" className="wb-chc-option" onClick={() => choose(o.key, o.label)}>
                  <span className="wb-chc-option-key">{o.key}</span>
                  <span className="wb-chc-option-label">
                    {o.label}
                    {o.detail && <span className="wb-chc-option-detail"> — {o.detail}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="wb-chc-bar">
            <button type="button" onClick={onShowTerminal}>
              answer in terminal
            </button>
            <button type="button" className="wb-chc-deny" onClick={() => choose("deny", choice.kind === "permission" ? "deny" : "cancel")}>
              {choice.kind === "permission" ? "deny" : "cancel"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RemoteComposer({ machine, instance, disabled }: { machine: string; instance: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    sendRemote(machine, { type: "prompt", instanceId: instance, text: t });
    setText("");
  };
  return (
    <div style={{ flex: "0 0 auto", borderTop: "1px solid var(--wb-border)", padding: "6px 10px", display: "flex", gap: 8 }}>
      <textarea
        value={text}
        disabled={disabled}
        placeholder={disabled ? "not running — start it first" : "a prompt for this session (Enter sends)"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        style={{
          flex: 1,
          resize: "none",
          background: "var(--wb-bgInset, transparent)",
          color: "var(--wb-text)",
          border: "1px solid var(--wb-border)",
          borderRadius: 3,
          padding: "5px 8px",
          font: "12.5px var(--wb-mono)",
        }}
      />
    </div>
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
