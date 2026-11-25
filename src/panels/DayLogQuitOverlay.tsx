// Quitting waits for the daily log (improvement plan J3): "Updating the daily log",
// with the steps as they go and Quit anyway. It shows only when the run takes a
// moment, or when Duck's main can't be reached; the quit carries on by itself when
// it's done (`assistant/daylogQuit.ts`).

import { useEffect, useState, type CSSProperties } from "react";
import Modal from "./InstanceManager/Modal";
import Spinner from "../theme/Spinner";
import { cancelQuit, onQuitStatus, setQuitStatus, type QuitStatus } from "../assistant/daylogQuit";
import { daylogQuitCancel, daylogQuitFinished } from "../ipc/daylog";

export default function DayLogQuitOverlay() {
  const [status, setStatus] = useState<QuitStatus | null>(null);
  useEffect(() => onQuitStatus(setStatus), []);
  if (!status) return null;

  const quit = () => {
    setQuitStatus(null);
    void daylogQuitFinished().catch(() => {});
  };
  const stay = () => {
    cancelQuit();
    void daylogQuitCancel().catch(() => {});
  };

  let line: string;
  let mark: React.ReactNode = <Spinner />;
  switch (status.phase) {
    case "running":
      line = `${status.step}…`;
      break;
    case "unreachable":
      line = status.why;
      mark = <span style={{ color: "var(--wb-needs)" }}>✕</span>;
      break;
    case "failed":
      line = `The log couldn't be brought up to date: ${status.error}`;
      mark = <span style={{ color: "var(--wb-needs)" }}>✕</span>;
      break;
    case "gaveUp":
      line = "It's taking too long, so Workbench quits now. The log catches up the next time it runs.";
      mark = <span style={{ color: "var(--wb-needs)" }}>✕</span>;
      break;
  }

  return (
    // Nothing closes it by accident: you choose below.
    <Modal title="updating the daily log" onClose={() => {}} width={480}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        {mark}
        <span>{line}</span>
      </div>
      {status.phase !== "gaveUp" && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={stay} style={button}>
            keep Workbench open
          </button>
          <button onClick={quit} style={{ ...button, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}>
            quit anyway
          </button>
        </div>
      )}
      {status.phase !== "gaveUp" && (
        <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--wb-textFaint)", lineHeight: 1.5 }}>
          Quitting anyway loses nothing: this machine's work is read the next time the log runs with it on.
        </div>
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
