// The status bar's way into the office (office plan O0.2), beside the palette's "Open
// the office". The office runs in the browser, so this only opens it: a dot once its
// listener is up, since the snapshot then flows to it as it does to a phone.

import { useState } from "react";

import { officeOpen } from "../ipc/office";
import { useRemoteServer } from "../state/remoteServer";

export default function OfficeButton() {
  const running = useRemoteServer().status?.office ?? false;
  const [error, setError] = useState<string | null>(null);
  return (
    <button
      type="button"
      onClick={() => {
        setError(null);
        officeOpen().catch((e) => setError(String(e)));
      }}
      title={error ?? "open the office in the browser"}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        font: "10.5px var(--wb-mono)",
        color: error ? "var(--wb-needs)" : running ? "var(--wb-accent)" : "var(--wb-textFaint)",
        padding: 0,
      }}
    >
      {error ? "office ✕" : running ? "office ●" : "office ○"}
    </button>
  );
}
