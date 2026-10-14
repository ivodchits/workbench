// Remote access menu (step 4.3, design §11) — the status-bar control for the
// tailnet remote server. Off by default; this is where you enable it, read the URL
// to open on your phone, mint a one-time pairing code, allow or revoke devices, and
// see recent auth failures (step R2).
// Mirrors the AppearanceMenu's upward popover so it sits naturally in the status bar.
//
// The server binds *only* the detected Tailscale interface and loopback — never the
// LAN. If Tailscale isn't up yet the panel says so, and the tailnet address follows
// once it connects. Public access (step R3) is a separate switch: Tailscale Funnel
// puts the loopback listener at a fixed https address, shown here with a QR code.

import { useEffect, useRef, useState } from "react";
import {
  approveDevice,
  newPairingCode,
  refreshRemoteStatus,
  revokeDevice,
  setPublicAccess,
  startRemote,
  stopRemote,
  useRemoteServer,
} from "../state/remoteServer";
import {
  remoteClearAuthLog,
  remoteQrSvg,
  type PublicStatus,
  type RemoteDevice,
} from "../ipc/remote";
import { openUrl } from "../ipc/os";
import { formatAgo, formatCountdown } from "../util/format";

/** Failures listed before "show all". */
const FAILURES_SHOWN = 4;

function RemoteAccessMenu() {
  const { status, devices, failures } = useRemoteServer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allFailures, setAllFailures] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh whenever the popover opens: a code's expiry and "seen" times move on
  // without the backend announcing anything.
  useEffect(() => {
    if (!open) return;
    void refreshRemoteStatus();
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const running = status?.running ?? false;
  const tailscale = status?.tailscaleAvailable ?? false;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (running) await stopRemote();
      else await startRemote();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function mintCode() {
    setBusy(true);
    setError(null);
    try {
      await newPairingCode();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const waiting = status?.pendingCount ?? 0;
  const shownFailures = allFailures ? failures : failures.slice(0, FAILURES_SHOWN);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="remote access (tailnet)"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color: running ? "var(--wb-accent)" : "var(--wb-textFaint)",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{ color: running ? "var(--wb-accent)" : "var(--wb-textFaint)" }}>⇄</span>
        remote {running ? `:${status?.port ?? ""}` : "off"}
        {running && status?.public.phase === "on" && <span>· public</span>}
        {running && status?.public.phase === "problem" && (
          <span style={{ color: "var(--wb-needs)" }}>· public ✕</span>
        )}
        {waiting > 0 && <span style={{ color: "var(--wb-needs)" }}>· {waiting} waiting</span>}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 22,
            left: 0,
            zIndex: 200,
            width: 340,
            maxHeight: "80vh",
            overflowY: "auto",
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: "10px 0",
            font: "11px var(--wb-mono)",
          }}
        >
          <SectionLabel>remote access · tailnet</SectionLabel>

          <Row>
            <span style={{ color: "var(--wb-text)", flex: 1 }}>
              {running ? "serving" : "off"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggle()}
              style={toggleStyle(running, busy)}
            >
              {running ? "disable" : "enable"}
            </button>
          </Row>

          {(running ? !status?.boundAddr : !tailscale) && (
            <Note>
              Tailscale isn’t connected — the tailnet url appears here once it is.
            </Note>
          )}

          {running && status?.url && (
            <Row>
              <span style={{ color: "var(--wb-textFaint)" }}>tailnet</span>
              <code
                style={{
                  flex: 1,
                  color: "var(--wb-accent)",
                  userSelect: "all",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {status.url}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(status.url ?? "")}
                title="copy"
                style={miniBtn}
              >
                copy
              </button>
            </Row>
          )}

          {running && status && <PublicAccess pub={status.public} />}

          {running && (
            <>
              <Divider />
              <SectionLabel>pair a device</SectionLabel>
              {status?.pairingCode ? (
                <Row>
                  <code
                    style={{
                      flex: 1,
                      color: "var(--wb-text)",
                      fontSize: 14,
                      letterSpacing: "0.15em",
                      userSelect: "all",
                    }}
                  >
                    {status.pairingCode}
                  </code>
                  <span style={{ color: "var(--wb-textFaint)", fontSize: 10 }}>
                    {status.pairingExpiresAt
                      ? `expires ${formatCountdown(status.pairingExpiresAt)}`
                      : ""}
                  </span>
                </Row>
              ) : status?.pairingLocked ? (
                <Note tone="error">
                  The last code took too many wrong tries and no longer works. Generate a
                  new one.
                </Note>
              ) : (
                <Note>
                  Open the url on the device, then generate a code to enter there. You
                  will be asked here to allow the device. The page installs as an app —
                  use “Add to Home Screen”.
                </Note>
              )}
              <Row>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mintCode()}
                  style={{ ...miniBtn, marginLeft: "auto" }}
                >
                  {status?.pairingCode ? "new code" : "generate code"}
                </button>
              </Row>
            </>
          )}

          <Divider />
          <SectionLabel>paired devices ({devices.length})</SectionLabel>
          {devices.length === 0 ? (
            <Note>none yet</Note>
          ) : (
            devices.map((d) => <DeviceRow key={d.id} device={d} />)
          )}

          {failures.length > 0 && (
            <>
              <Divider />
              <Row>
                <span style={sectionLabelStyle}>auth failures</span>
                <button
                  type="button"
                  onClick={() => void remoteClearAuthLog()}
                  title="clear the list"
                  style={{ ...miniBtn, marginLeft: "auto" }}
                >
                  clear
                </button>
              </Row>
              {shownFailures.map((f) => (
                <div
                  key={`${f.addr} ${f.what}`}
                  style={{ padding: "2px 12px", fontSize: 10, lineHeight: 1.5 }}
                >
                  <div style={{ color: "var(--wb-text)" }}>
                    {f.what}
                    {f.count > 1 && <span style={{ color: "var(--wb-textFaint)" }}> ×{f.count}</span>}
                  </div>
                  <div style={{ color: "var(--wb-textFaint)" }}>
                    {f.addr} · {formatAgo(f.at)}
                  </div>
                </div>
              ))}
              {failures.length > FAILURES_SHOWN && (
                <Row>
                  <button
                    type="button"
                    onClick={() => setAllFailures((v) => !v)}
                    style={{ ...miniBtn, border: "none", padding: 0 }}
                  >
                    {allFailures ? "show fewer" : `show all ${failures.length}`}
                  </button>
                </Row>
              )}
            </>
          )}

          {error && <Note tone="error">{error}</Note>}
        </div>
      )}
    </div>
  );
}

/** The public access (Funnel) switch, what it exposes, and where it stands. */
function PublicAccess({ pub }: { pub: PublicStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      await setPublicAccess(!pub.enabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Divider />
      <Row>
        <span style={{ ...sectionLabelStyle, flex: 1 }}>public access · funnel</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void flip()}
          style={toggleStyle(pub.enabled, busy)}
        >
          {pub.enabled ? "turn off" : "turn on"}
        </button>
      </Row>
      {!pub.enabled && (
        <Note>
          Puts this server on the internet at a fixed https address (port {pub.port}) through
          Tailscale Funnel, so a phone can reach it without Tailscale. Anyone can load the
          page; nothing works without a pairing code from here and your allow. Stays on
          across restarts.
        </Note>
      )}
      {pub.phase === "starting" && <Note>setting up the funnel…</Note>}
      {pub.phase === "problem" && (
        <Note tone="error">
          {pub.problem}
          {pub.fixUrl && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void openUrl(pub.fixUrl ?? "").catch(() => {})}
                style={{ ...miniBtn, border: "none", padding: 0, textDecoration: "underline" }}
              >
                open the page
              </button>
            </>
          )}
          <span style={{ color: "var(--wb-textFaint)" }}> Workbench keeps trying.</span>
        </Note>
      )}
      {pub.phase === "on" && pub.url && <PublicUrl url={pub.url} />}
      {error && <Note tone="error">{error}</Note>}
    </>
  );
}

/** The public address, with a copy button and a QR code to scan with the phone. */
function PublicUrl({ url }: { url: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    remoteQrSvg(url)
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <>
      <Row>
        <span style={{ color: "var(--wb-textFaint)" }}>public</span>
        <code
          style={{
            flex: 1,
            color: "var(--wb-accent)",
            userSelect: "all",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {url}
        </code>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(url)}
          title="copy"
          style={miniBtn}
        >
          copy
        </button>
      </Row>
      {svg && (
        <div style={{ padding: "4px 12px", display: "flex", justifyContent: "center" }}>
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            alt={`QR code for ${url}`}
            width={150}
            height={150}
          />
        </div>
      )}
    </>
  );
}

/** One paired device: allow / turn away while it waits, revoke once allowed. */
function DeviceRow({ device: d }: { device: RemoteDevice }) {
  const detail = d.approved
    ? [d.lastAddr, d.lastSeen ? `seen ${formatAgo(d.lastSeen)}` : "never used"]
    : [d.lastAddr, `waiting · ${formatCountdown(d.expiresAt)} left`];
  return (
    <div style={{ padding: "4px 12px", display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
        <div
          style={{
            color: d.approved ? "var(--wb-text)" : "var(--wb-needs)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {d.name}
        </div>
        <div
          style={{ color: "var(--wb-textFaint)", fontSize: 10 }}
          title={d.approved ? `stops working in ${formatCountdown(d.expiresAt)} unless used` : undefined}
        >
          {detail.filter(Boolean).join(" · ")}
        </div>
      </div>
      {d.approved ? (
        <button
          type="button"
          onClick={() => void revokeDevice(d.id)}
          title="revoke: it is disconnected and has to pair again"
          style={{ ...miniBtn, color: "var(--wb-needs)" }}
        >
          revoke
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void revokeDevice(d.id)}
            style={{ ...miniBtn, color: "var(--wb-needs)" }}
          >
            turn away
          </button>
          <button
            type="button"
            onClick={() => void approveDevice(d.id)}
            style={{ ...miniBtn, color: "var(--wb-accent)" }}
          >
            allow
          </button>
        </>
      )}
    </div>
  );
}

function toggleStyle(running: boolean, disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--wb-border)",
    color: disabled ? "var(--wb-textFaint)" : running ? "var(--wb-needs)" : "var(--wb-accent)",
    font: "10.5px var(--wb-mono)",
    cursor: disabled ? "default" : "pointer",
    padding: "2px 10px",
  };
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "10px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 8px",
};

const sectionLabelStyle: React.CSSProperties = {
  color: "var(--wb-textFaint)",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontSize: 9.5,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ ...sectionLabelStyle, padding: "2px 12px 4px" }}>{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
      }}
    >
      {children}
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      style={{
        color: tone === "error" ? "var(--wb-needs)" : "var(--wb-textFaint)",
        padding: "2px 12px 4px",
        fontSize: 10,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />;
}

export default RemoteAccessMenu;
