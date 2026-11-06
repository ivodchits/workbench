// A session's autopilot decisions log, as a document: every question, plan and
// permission prompt Duck settled for it without you, and each one it left to you
// (`src/assistant/decisionsLog.ts`). Read-only, in a tab beside its console; opened
// by the console header's "decisions" button or by Duck. It reads the file again
// whenever Duck writes to it.
//
// The session's id travels in the panel params, so the tab survives layout saves
// and restarts like a plan's.

import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { decisionsLogRead } from "../ipc/assistant";
import { useDecisionsVersion } from "../state/decisionsLog";
import MarkdownPreview from "./Editor/MarkdownPreview";

export interface DecisionsPanelParams {
  /** The session. Not `instanceId`: the workspace takes a panel with that param
   *  for a console. */
  fromInstance: string;
  title: string;
}

const EMPTY = "_Nothing yet: Duck hasn't settled anything for this session without you._";

function DecisionsPanel(props: IDockviewPanelProps<DecisionsPanelParams>) {
  const { fromInstance } = props.params;
  const version = useDecisionsVersion(fromInstance);
  const [reload, setReload] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    decisionsLogRead(fromInstance).then(
      (t) => {
        if (!live) return;
        setText(t);
        setError(null);
      },
      (e: unknown) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [fromInstance, version, reload]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          padding: "5px 12px",
          borderBottom: "1px solid var(--wb-border)",
          background: "var(--wb-titlebar)",
          font: "10.5px var(--wb-mono)",
          color: "var(--wb-textDim2)",
        }}
      >
        <span style={{ color: "var(--wb-text)" }}>decisions</span>
        <span style={{ color: "var(--wb-textFaint)" }}>what Duck settled without you · read-only</span>
        {error && <span style={{ color: "var(--wb-needs)" }}>{error}</span>}
        <button
          onClick={() => setReload((n) => n + 1)}
          title="read the log again"
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--wb-accent)",
            font: "10.5px var(--wb-mono)",
          }}
        >
          refresh
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MarkdownPreview source={text ?? EMPTY} scrollKey={`decisions:${fromInstance}`} />
      </div>
    </div>
  );
}

export default DecisionsPanel;
