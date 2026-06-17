// Remote access menu (step 4.3, design §11) — the status-bar control for the
// tailnet remote server. Off by default; this is where you enable it, read the URL
// to open on your phone, mint a one-time pairing code, and revoke paired devices.
// Mirrors the AppearanceMenu's upward popover so it sits naturally in the status bar.
//
// The server binds *only* the detected Tailscale interface — if Tailscale isn't up,
// enabling is disabled and the panel says so, rather than ever binding broader.

import { useEffect, useRef, useState } from "react";
import {
  newPairingCode,
  refreshRemoteStatus,
  startRemote,
  stopRemote,
  useRemoteServer,
} from "../state/remoteServer";
import { remoteDevicesList, remoteRevokeDevice, type RemoteDevice } from "../ipc/remote";
import { formatCountdown } from "../util/format";

function RemoteAccessMenu() {
  const status = useRemoteServer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh status + devices whenever the popover opens (status can change out of
  // band — a device pairs, a code expires).
  useEffect(() => {
    if (!open) return;
    void refreshRemoteStatus();
    void remoteDevicesList().then(setDevices).catch(() => setDevices([]));
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

  async function revoke(token: string) {
    setDevices(await remoteRevokeDevice(token));
    void refreshRemoteStatus();
  }

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
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 22,
            left: 0,
            zIndex: 200,
            width: 320,
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
              disabled={busy || (!running && !tailscale)}
              onClick={() => void toggle()}
              style={toggleStyle(running, busy || (!running && !tailscale))}
            >
              {running ? "disable" : "enable"}
            </button>
          </Row>

          {!tailscale && (
            <Note>
              Tailscale interface not found — start/connect Tailscale, then reopen this
              menu.
            </Note>
          )}

          {running && status?.url && (
            <Row>
              <span style={{ color: "var(--wb-textFaint)" }}>url</span>
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
              ) : (
                <Note>
                  Open the url on the device, then generate a code to enter there. The
                  page installs as an app — use “Add to Home Screen”.
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
            devices.map((d) => (
              <Row key={d.token}>
                <span style={{ color: "var(--wb-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {d.name}
                </span>
                <span style={{ color: "var(--wb-textFaint)", fontSize: 10 }}>
                  {d.lastSeen ? `seen ${formatCountdown(d.lastSeen)}` : "never used"}
                </span>
                <button
                  type="button"
                  onClick={() => void revoke(d.token)}
                  title="revoke"
                  style={{ ...miniBtn, color: "var(--wb-needs)" }}
                >
                  revoke
                </button>
              </Row>
            ))
          )}

          {error && <Note tone="error">{error}</Note>}
        </div>
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "var(--wb-textFaint)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontSize: 9.5,
        padding: "2px 12px 4px",
      }}
    >
      {children}
    </div>
  );
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
