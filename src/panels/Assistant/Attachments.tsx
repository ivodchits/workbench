// Attachments in the drawer (step G1): the chips, staged above the composer, in
// your messages, and the files a worker made.
//
// A chip opens its file on a click and drags out of the window (to Explorer, the
// desktop, a mail) when pulled: the drag is the OS's own, started by the backend
// (`assistant_attach_drag`) while the button is still held.

import { useRef } from "react";

import { attachDrag } from "../../ipc/assistant";
import { openPath } from "../../ipc/os";
import { sizeText, type AttachmentRef } from "../../assistant/attachments";
import { clearStagingError, unstage, useStaging } from "./staging";

/** How far a held button moves before it's a drag out. */
const DRAG_PX = 5;

function icon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("spreadsheet") || mime === "text/csv") return "📊";
  if (mime.startsWith("text/") || mime === "application/json") return "📄";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎞";
  return "📦";
}

export function FileChip({ file, onRemove }: { file: AttachmentRef; onRemove?: () => void }) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const where = file.path;
  return (
    <span
      className="duck-file"
      title={`${file.name} · ${sizeText(file.size)}${where ? "\nclick to open · drag out to Explorer" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        from.current = { x: e.clientX, y: e.clientY };
        dragged.current = false;
      }}
      onPointerMove={(e) => {
        const f = from.current;
        if (!f || dragged.current || !(e.buttons & 1)) return;
        if (Math.abs(e.clientX - f.x) + Math.abs(e.clientY - f.y) < DRAG_PX) return;
        dragged.current = true;
        from.current = null;
        void attachDrag(file.id, file.name).catch((err: unknown) => console.warn("duck: dragging a file out failed", err));
      }}
      onPointerUp={() => {
        if (from.current && !dragged.current && where) void openPath(where).catch(() => {});
        from.current = null;
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: 240,
        padding: "2px 6px",
        border: "1px solid var(--wb-border)",
        background: "var(--wb-bg)",
        cursor: where ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {file.thumb ? (
        <img src={file.thumb} alt="" draggable={false} style={{ width: 28, height: 28, objectFit: "cover" }} />
      ) : (
        <span aria-hidden>{icon(file.mime)}</span>
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
      <span style={{ color: "var(--wb-textDim2)", whiteSpace: "nowrap" }}>{sizeText(file.size)}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`remove ${file.name}`}
          onClick={onRemove}
          style={{ background: "none", border: "none", color: "var(--wb-textDim2)", cursor: "pointer", padding: 0 }}
        >
          ×
        </button>
      )}
    </span>
  );
}

export function FileList({ files }: { files: readonly AttachmentRef[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {files.map((f) => (
        <FileChip key={`${f.id}/${f.name}`} file={f} />
      ))}
    </div>
  );
}

/** What waits to go with the next message. */
export function StagedFiles() {
  const s = useStaging();
  if (!s.files.length && !s.storing && !s.error) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {s.error && (
        <div style={{ display: "flex", gap: 6, color: "var(--wb-needs)" }}>
          <span style={{ flex: 1 }}>{s.error}</span>
          <button type="button" aria-label="dismiss" onClick={clearStagingError} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            ×
          </button>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {s.files.map((f) => (
          <FileChip key={`${f.id}/${f.name}`} file={f} onRemove={() => unstage(f.id, f.name)} />
        ))}
        {s.storing > 0 && <span style={{ color: "var(--wb-textDim2)" }}>adding {s.storing}…</span>}
      </div>
    </div>
  );
}
