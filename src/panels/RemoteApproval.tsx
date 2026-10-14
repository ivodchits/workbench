// The desktop's yes or no for a newly paired device (step R2). A device that pairs
// with a valid code gets a token that does nothing until it is allowed here, so a
// code read over your shoulder (or guessed) is not enough on its own. Always mounted
// from App; shows the oldest waiting device. Closing the dialog without deciding
// leaves the device waiting in the Remote Access menu until it runs out.

import { useState, type CSSProperties } from "react";

import { GLYPH } from "../theme";
import { approveDevice, revokeDevice, useRemoteServer } from "../state/remoteServer";
import { formatAgo, formatCountdown } from "../util/format";
import Modal from "./InstanceManager/Modal";

export default function RemoteApprovalHost() {
  const { devices } = useRemoteServer();
  /** Waiting devices put off in this window ("decide later"). */
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const device = devices
    .filter((d) => !d.approved && !later.has(d.id))
    .sort((a, b) => a.pairedAt - b.pairedAt)[0];
  if (!device) return null;

  async function decide(allow: boolean) {
    setBusy(true);
    try {
      await (allow ? approveDevice(device.id) : revokeDevice(device.id));
    } finally {
      setBusy(false);
    }
  }

  const putOff = () => setLater((prev) => new Set(prev).add(device.id));

  return (
    <Modal title="allow a new device?" onClose={putOff} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, font: "12px var(--wb-mono)" }}>
        <div style={{ color: "var(--wb-text)", lineHeight: 1.6 }}>
          <div style={{ fontSize: 14 }}>{device.name}</div>
          <div style={{ color: "var(--wb-textDim2)" }}>
            from {device.lastAddr ?? "unknown address"} · paired {formatAgo(device.pairedAt)}
          </div>
        </div>
        <div style={{ color: "var(--wb-textDim2)", fontSize: 11, lineHeight: 1.6 }}>
          It entered the pairing code. Allowed, it can watch and drive every session.
          Only allow it if you paired it just now yourself. It is turned away by
          itself in {formatCountdown(device.expiresAt)}.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={putOff} disabled={busy} style={buttonStyle}>
            decide later
          </button>
          <button
            type="button"
            onClick={() => void decide(false)}
            disabled={busy}
            style={{ ...buttonStyle, color: "var(--wb-needs)" }}
          >
            {GLYPH.fail} turn away
          </button>
          <button
            type="button"
            onClick={() => void decide(true)}
            disabled={busy}
            style={{ ...buttonStyle, borderColor: "var(--wb-borderActive)" }}
          >
            {GLYPH.ok} allow
          </button>
        </div>
      </div>
    </Modal>
  );
}

const buttonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};
