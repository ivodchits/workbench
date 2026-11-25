// A file a session showed (improvement plan S2), popped out of the viewer into a
// dockable panel of its own, like the preview panel. It owns no store entry: its
// params are all it needs, so it's restored with the layout. The file is served as
// it is now, so a render that's rewritten shows its new self on reopen.

import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { mediaInfo, mediaUrl, type MediaInfo } from "../ipc/media";
import { openPath, revealPath } from "../ipc/os";
import type { MediaPanelParams } from "../state/media";
import { sizeWords } from "../transcript/media";
import "../theme/transcript.css";

export default function MediaPanel(props: IDockviewPanelProps<MediaPanelParams>) {
  const { mediaId, title } = props.params;
  const [info, setInfo] = useState<MediaInfo | null | undefined>(undefined);
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(`media · ${title}`), [setTitle, title]);

  useEffect(() => {
    let live = true;
    void mediaInfo([mediaId]).then(
      (all) => live && setInfo(all[0] ?? null),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [mediaId]);

  if (info === undefined) return <div className="wb-media-panel" />;
  if (info === null || info.state === "gone") {
    return (
      <div className="wb-media-panel wb-media-panel-centre">
        <div className="wb-media-file">
          <span className="wb-tx-file-name">{title}</span>
          <span className="wb-tx-file-facts">{info ? "file gone" : "not known here"}</span>
        </div>
      </div>
    );
  }
  const src = mediaUrl(info.id);
  const card = (why?: string) => (
    <div className="wb-media-file">
      <span className="wb-tx-file-name">{info.name}</span>
      <span className="wb-tx-file-facts">{[sizeWords(info.size), why].filter(Boolean).join(" · ")}</span>
      <div className="wb-media-file-actions">
        <button type="button" className="wb-media-btn" onClick={() => void openPath(info.path)}>
          open externally
        </button>
        <button type="button" className="wb-media-btn" onClick={() => void revealPath(info.path)}>
          show in folder
        </button>
      </div>
    </div>
  );
  return (
    <div className={`wb-media-panel${info.kind === "image" && actual ? "" : " wb-media-panel-centre"}`}>
      {failed || info.kind === "file" ? (
        card(failed ? "can't play here" : undefined)
      ) : info.kind === "image" ? (
        <img
          src={src}
          alt={info.name}
          className={actual ? "wb-media-panel-actual" : "wb-media-panel-fit"}
          title={actual ? "click to fit" : "click for actual size"}
          onClick={() => setActual((a) => !a)}
        />
      ) : info.kind === "video" ? (
        <video src={src} controls className="wb-media-panel-fit" onError={() => setFailed(true)} />
      ) : (
        <div className="wb-media-play wb-media-play-audio">
          <span className="wb-tx-file-name">♪ {info.name}</span>
          <audio src={src} controls onError={() => setFailed(true)} />
        </div>
      )}
    </div>
  );
}
