// Raw `.mcp.json` editor (step 3.7 — design §7). The project-scope config is a
// small, git-committed file that's safe to edit directly, so the manager offers a
// raw-text escape hatch alongside the form. The backend validates the JSON before
// writing, so a syntax slip surfaces as an error rather than a corrupt file.

import { useEffect, useState, type CSSProperties } from "react";
import { GLYPH } from "../../theme";
import { mcpProjectFile, mcpSaveProjectFile } from "../../ipc/mcp";
import Modal from "../InstanceManager/Modal";

interface RawJsonDialogProps {
  projectRoot: string;
  onClose: () => void;
  /** Called after a successful write so the panel can reload the list. */
  onSaved: () => void;
}

const TEMPLATE = `{
  "mcpServers": {
  }
}
`;

function RawJsonDialog({ projectRoot, onClose, onSaved }: RawJsonDialogProps) {
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void mcpProjectFile(projectRoot)
      .then((text) => alive && setContent(text.trim().length > 0 ? text : TEMPLATE))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [projectRoot]);

  const save = async () => {
    if (content === null) return;
    setBusy(true);
    setError(null);
    try {
      await mcpSaveProjectFile(projectRoot, content);
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title=".mcp.json" onClose={onClose} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
          project-scope servers, shared via git. Empty the file to remove it.
        </span>
        <textarea
          value={content ?? ""}
          onChange={(e) => setContent(e.target.value)}
          disabled={content === null}
          spellCheck={false}
          rows={16}
          style={{
            background: "var(--wb-bg)",
            color: "var(--wb-text)",
            border: "1px solid var(--wb-border)",
            padding: "8px 10px",
            font: "12px/1.5 var(--wb-mono)",
            resize: "vertical",
            tabSize: 2,
          }}
        />
        {error && (
          <div style={{ color: "var(--wb-needs)", font: "11.5px var(--wb-mono)", whiteSpace: "pre-wrap" }}>
            {GLYPH.fail} {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={buttonStyle}>
            cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || content === null}
            style={{ ...buttonStyle, borderColor: "var(--wb-borderActive)" }}
          >
            {busy ? "saving…" : `${GLYPH.ok} save`}
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

export default RawJsonDialog;
