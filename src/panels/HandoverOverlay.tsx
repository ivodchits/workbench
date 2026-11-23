// The handover on quitting: when this machine holds Duck and another machine could
// run it, closing Workbench hands Duck over first, and this overlay says how it's
// going. All going well, the app just closes after it; a failed round stays on
// screen with what went wrong while it's tried again, until it works, you stay, or
// you quit anyway.

import { useEffect, useState, type CSSProperties } from "react";
import Modal from "./InstanceManager/Modal";
import Spinner from "../theme/Spinner";
import {
  fleetLeaveCancel,
  fleetLeaveRetry,
  fleetQuitNow,
  onFleetLeaving,
  type LeaveStatus,
} from "../ipc/fleet";

/** The backend's wait between rounds (`LEAVE_RETRY`). */
const RETRY_S = 15;

function HandoverOverlay() {
  const [status, setStatus] = useState<LeaveStatus | null>(null);
  const [waitingSince, setWaitingSince] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const off = onFleetLeaving((s) => {
      setStatus(s);
      if (s.phase === "waiting") setWaitingSince(Date.now());
    });
    return () => void off.then((f) => f());
  }, []);

  const waiting = status?.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  if (!status) return null;

  const stay = () => {
    setStatus(null);
    void fleetLeaveCancel().catch(() => {});
  };
  const left = Math.max(0, RETRY_S - Math.floor((now - waitingSince) / 1000));

  let line: string;
  switch (status.phase) {
    case "draining":
      line = "Duck is finishing what it's doing…";
      break;
    case "handing":
      line = `Handing Duck to ${status.to ?? "another machine"}…`;
      break;
    case "done":
      line = status.to ? `Duck is on ${status.to} now. Closing…` : "Duck is on another machine now. Closing…";
      break;
    default:
      line = "Duck couldn't be handed over.";
  }

  return (
    // Nothing closes it by accident (Escape, a click outside): you choose below.
    <Modal title="handing Duck over" onClose={() => {}} width={480}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--wb-text)" }}>
        {status.phase === "waiting" ? (
          <span style={{ color: "var(--wb-needs)" }}>✕</span>
        ) : status.phase === "done" ? (
          <span style={{ color: "var(--wb-done)" }}>✓</span>
        ) : (
          <Spinner />
        )}
        <span>{line}</span>
      </div>

      {status.phase === "waiting" && (
        <>
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              border: "1px solid var(--wb-needs)",
              color: "var(--wb-needs)",
              fontSize: 11.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {status.error ?? "Something went wrong."}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--wb-textDim2)" }}>
            {left > 0 ? `Trying again in ${left} s` : "Trying again…"} · attempt {status.attempt}
          </div>
        </>
      )}

      {status.phase !== "done" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button onClick={stay} style={button}>
              keep Workbench open
            </button>
            {status.phase === "waiting" && (
              <button onClick={() => void fleetLeaveRetry().catch(() => {})} style={{ ...button, borderColor: "var(--wb-accent)", color: "var(--wb-accent)" }}>
                try again now
              </button>
            )}
            <button
              onClick={() => void fleetQuitNow().catch(() => {})}
              style={{ ...button, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
            >
              quit anyway
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
            Quitting anyway leaves Duck without a machine until another one notices this one is gone and takes over
            from its own copy. Anything that copy hasn't synced yet stays on this machine until it's back.
          </div>
        </>
      )}
    </Modal>
  );
}

const button: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default HandoverOverlay;
