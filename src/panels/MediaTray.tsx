// The media a session showed (improvement plan S2), for the console in terminal view:
// the header's badge (how many were shown since you last looked) and the tray it
// opens over the console, newest first, with the same viewer as the transcript.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { mediaList, mediaRefuseGet, mediaRefuseSet } from "../ipc/media";
import { closeMediaTray, desktopActions, openMediaTray, refOf, useMediaCounts } from "../state/media";
import { attachMediaViewer, mediaStrip } from "../transcript/media";
import "../theme/transcript.css";

export function MediaButton({ instanceId }: { instanceId: string }) {
  const { unseen, total } = useMediaCounts(instanceId);
  if (total === 0) return null;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openMediaTray(instanceId)}
      title={unseen ? `${unseen} shown since you last looked; open the session's media` : "open the session's media"}
      style={{ ...buttonStyle, color: unseen ? "var(--wb-accent)" : "var(--wb-textDim2)" }}
    >
      media{unseen ? ` · ${unseen}` : ""}
    </button>
  );
}

/** Over the console (its parent must be positioned). */
export function MediaTray({ instanceId }: { instanceId: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number | null>(null);
  const [refuse, setRefuse] = useState<boolean | null>(null);
  const { total } = useMediaCounts(instanceId);

  useEffect(() => {
    void mediaRefuseGet().then(setRefuse, () => setRefuse(null));
  }, []);

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Newest first; read again when the session shows more while it's open.
  useEffect(() => {
    let live = true;
    void mediaList(instanceId).then((all) => {
      const grid = gridRef.current;
      if (!live || !grid) return;
      setCount(all.length);
      grid.replaceChildren(mediaStrip(all.map((i) => refOf(i))));
    });
    return () => {
      live = false;
    };
  }, [instanceId, total]);

  useEffect(() => {
    const grid = gridRef.current;
    const root = rootRef.current;
    if (grid && root) return attachMediaViewer(grid, root, desktopActions(instanceId));
  }, [instanceId]);

  return (
    <div
      ref={rootRef}
      className="wb-media-tray"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeMediaTray();
        }
      }}
    >
      <div className="wb-media-bar">
        <span className="wb-media-label">
          media in this session{count !== null ? ` · ${count}` : ""}, newest first
        </span>
        {refuse !== null && (
          <label className="wb-media-refuse" title="Refuse a shell command that only opens a media file in another app, and tell the agent to use show_media">
            <input
              type="checkbox"
              checked={refuse}
              onChange={(e) => {
                const on = e.target.checked;
                setRefuse(on);
                void mediaRefuseSet(on).catch(() => setRefuse(!on));
              }}
            />
            refuse opening media in other apps
          </label>
        )}
        <button type="button" className="wb-media-btn" title="close (Esc)" onClick={closeMediaTray}>
          ✕
        </button>
      </div>
      <div ref={gridRef} className="wb-media-tray-grid" />
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  font: "10.5px var(--wb-mono)",
  cursor: "pointer",
  padding: "0 7px",
  lineHeight: 1.5,
};
