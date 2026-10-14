// A plan, as a document (step P1): the markdown a session proposed with
// `ExitPlanMode`, opened read-only in a tab beside its console — only ever by a
// click ("open plan" in the console header, on the plan's card in the transcript,
// or on the plan approval card).
//
// The plan's text travels in the panel params, so the tab survives layout saves,
// restarts and presets like any dockview panel, with no store behind it. "save as
// note" copies it into the project's notes (N1).

import { useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { notesCreateWith } from "../ipc/notes";
import { nameFromText } from "../state/noteName";
import { openNotes } from "../state/notes";
import { useRegistry } from "../state/registry";
import MarkdownPreview from "./Editor/MarkdownPreview";

export interface PlanPanelParams {
  /** The plan's tool-call id; part of the panel id. */
  planId: string;
  /** The session it came from. Not `instanceId`: the workspace takes a panel
   *  with that param for a console. */
  fromInstance: string;
  projectId: string;
  title: string;
  /** The plan as markdown. */
  source: string;
}

function PlanPanel(props: IDockviewPanelProps<PlanPanelParams>) {
  const { planId, projectId, title, source } = props.params;
  const { projects } = useRegistry();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveAsNote = async () => {
    try {
      const note = await notesCreateWith(projectId, nameFromText(`plan — ${title}`), source);
      setSaved(note.id);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const project = projects.find((p) => p.id === projectId);
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
        <span style={{ color: "var(--wb-text)" }}>plan</span>
        <span style={{ color: "var(--wb-textFaint)" }}>read-only</span>
        {saved && (
          <button
            onClick={() => project && openNotes({ projectId, title: project.name })}
            title="open the project's notes"
            style={linkButton("var(--wb-done)")}
          >
            ✓ saved as “{saved}”
          </button>
        )}
        {error && <span style={{ color: "var(--wb-needs)" }}>{error}</span>}
        <button
          onClick={() => void saveAsNote()}
          disabled={!project}
          title="copy this plan into the project's notes"
          style={{ ...linkButton("var(--wb-accent)"), marginLeft: "auto" }}
        >
          save as note
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MarkdownPreview source={source} scrollKey={`plan:${planId}`} />
      </div>
    </div>
  );
}

function linkButton(color: string): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color,
    font: "10.5px var(--wb-mono)",
  };
}

export default PlanPanel;
