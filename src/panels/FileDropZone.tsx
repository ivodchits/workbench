// The body of a console as a drop target for files dragged from inside the app
// (step D1): the editor's tree and tabs, the Diff file list, the Git status list —
// and, on Windows, from the OS (step D2), whose paths the host reads. A drop writes an `@path` reference per file — pasted into the terminal (not
// submitted), or put at the caret of the transcript view's composer.
//
// Only a drag carrying files is answered — our own type (`state/fileDrag`) or the
// OS's — so dragging a dockview panel over a console still reaches dockview
// untouched. A file outside the session's directory is referenced by its full path.

import { useRef, useState } from "react";

import { isOsFileDrag, osDropPaths, osDropSupported } from "../ipc/osDrop";
import { insertReferences } from "../state/composer";
import { isFileDrag, readDragPaths, referenceText } from "../state/fileDrag";
import { pasteIntoTerminal } from "./terminalPool";

interface FileDropZoneProps {
  instanceId: string;
  /** The session's working directory; paths inside it are written relative to it. */
  cwd: string;
  /** Where a drop lands: the transcript view's composer, or the terminal. */
  target: "composer" | "terminal";
  /** False when the session can't take a reference (not running; on another host). */
  enabled: boolean;
  children: React.ReactNode;
}

function FileDropZone({ instanceId, cwd, target, enabled, children }: FileDropZoneProps) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every element crossed inside the zone.
  const depth = useRef(0);

  const accepts = (e: React.DragEvent) =>
    enabled && (isFileDrag(e.dataTransfer) || (osDropSupported() && isOsFileDrag(e.dataTransfer)));

  const insert = (paths: string[]) => {
    const text = referenceText(paths, cwd);
    if (!text) return;
    if (target === "composer") insertReferences(instanceId, text);
    else pasteIntoTerminal(instanceId, text);
  };

  const leave = () => {
    depth.current = 0;
    setOver(false);
  };

  return (
    <div
      style={{ position: "relative", height: "100%" }}
      onDragEnter={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!accepts(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) leave();
      }}
      onDrop={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        leave();
        if (isFileDrag(e.dataTransfer)) insert(readDragPaths(e.dataTransfer));
        // The files are read now: the drop's data is gone once the event ends.
        else void osDropPaths(Array.from(e.dataTransfer.files)).then(insert);
      }}
    >
      {children}
      {over && <div className="wb-filedrop">drop to reference</div>}
    </div>
  );
}

export default FileDropZone;
