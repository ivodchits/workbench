// Torn-off window (step 4.2) — the minimal app rendered in a second Tauri window
// when a Console or Project Shell panel is popped out to its own monitor.
//
// It's the same bundle as the main window but a *separate webview* (separate JS
// context, separate terminal pool). It doesn't run the rail, dock, or stores — it
// just attaches one xterm terminal to the already-live PTY as a second multiplexer
// subscriber (step 4.1) via the pool's `attach` mode. Scrollback replays on attach,
// input routes back, and the min-size arbitration handles two clients (the main
// window released its terminal on tear-off, so usually this is the sole subscriber).
//
// Closing this window docks the panel back into the main dock (the main window
// listens for WINDOW_DESTROYED — see state/tearoff); the session keeps running.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import Console from "../panels/Console";
import FileDropZone from "../panels/FileDropZone";
import { ViewToggle } from "../panels/ConsolePanel";
import TranscriptView from "../panels/TranscriptView";
import { copyLastResponse } from "../panels/consoleCommands";
import { initQueueDelivery } from "../panels/promptDelivery";
import { GLYPH } from "../theme";
import { initAppearance } from "../state/appearance";
import { initPendingChoices } from "../state/pendingChoice";
import { initStatusEngine, useLiveStatuses } from "../state/status";
import { loadTemplatesFor } from "../state/templates";
import { initViewModes, setViewMode, toggleViewMode, useViewMode } from "../state/viewMode";
import { loadKeymap, matchCommand } from "../keyboard/keymap";
import type { TornKind } from "../state/tearoff";

interface TornParams {
  kind: TornKind;
  /** PTY key — instance id for a console, shell id for a shell. */
  id: string;
  title: string;
}

/** Parse the `?torn=…&id=…&title=…` the tear-off opener encoded into the URL. */
export function readTornParams(): TornParams | null {
  const q = new URLSearchParams(window.location.search);
  const kind = q.get("torn");
  const id = q.get("id");
  if ((kind !== "console" && kind !== "shell") || !id) return null;
  return { kind, id, title: q.get("title") ?? kind };
}

function TornWindow({ params }: { params: TornParams }) {
  const { kind, id, title } = params;
  const [error, setError] = useState<string | null>(null);
  // A torn-off console honours (and can change) the same per-instance view mode
  // as the main window (step T3); a shell has no transcript.
  const viewMode = useViewMode(id);
  const live = useLiveStatuses().get(id) ?? null;
  const isConsole = kind === "console";
  const showTranscript = isConsole && viewMode === "transcript" && !error;

  // Apply the persisted theme + font scale so the torn-off window matches the main
  // one (it reads the same prefs store). Suppress the webview context menu, as the
  // main window does — its "Reload" would drop the attached terminal.
  useEffect(() => {
    void initAppearance();
    document.title = `${title} — Workbench`;
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, [title]);

  // The transcript view's needs (step T3): the saved view mode, live status for
  // its working indicator (from the hook events this window sees from now on),
  // and the two console chords — this window doesn't run the global key layer.
  // Its composer (step T4) needs the queue's delivery and the templates; this
  // window has no active project, so it offers the global ones.
  useEffect(() => {
    if (!isConsole) return;
    void initViewModes();
    initStatusEngine();
    initPendingChoices();
    void loadKeymap();
    void loadTemplatesFor(null);
    const stopDelivery = initQueueDelivery();
    const onKeyDown = (e: KeyboardEvent) => {
      const command = matchCommand(e, "global")?.command;
      if (command !== "toggleTranscriptView" && command !== "copyLastResponse") return;
      e.preventDefault();
      e.stopPropagation();
      if (command === "toggleTranscriptView") toggleViewMode(id);
      else void copyLastResponse(id);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      stopDelivery();
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [isConsole, id]);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--wb-bg)",
        color: "var(--wb-text)",
        font: "12.5px var(--wb-mono)",
        overflow: "hidden",
      }}
    >
      <Header kind={kind} title={title}>
        {isConsole && !error && <ViewToggle mode={viewMode} onToggle={() => toggleViewMode(id)} />}
      </Header>
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {error ? (
          <Ended message={error} />
        ) : (
          // A file dragged over from the main window (step D1). This window doesn't
          // know the session's working dir, so the references are absolute paths.
          <FileDropZone
            instanceId={id}
            cwd=""
            target={showTranscript ? "composer" : "terminal"}
            enabled={isConsole}
          >
            {showTranscript ? (
              <TranscriptView
                instanceId={id}
                live={live}
                onShowTerminal={() => setViewMode(id, "terminal")}
              />
            ) : (
              <Console
                instanceId={id}
                kind={kind === "shell" ? "shell" : "claude"}
                cwd=""
                webgl={kind === "console"}
                resumeSessionId={null}
                remote={null}
                attach
                onError={setError}
              />
            )}
          </FileDropZone>
        )}
      </div>
    </div>
  );
}

/** A slim title bar: the panel name + a "dock back" button. Closing the window is
 *  exactly "dock back" — the main window re-adds the panel on WINDOW_DESTROYED. */
function Header({
  kind,
  title,
  children,
}: {
  kind: TornKind;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: 32,
        flex: "0 0 32px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        background: "var(--wb-titlebar)",
        borderBottom: "1px solid var(--wb-border)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-accent)" }}>{kind === "shell" ? "$" : GLYPH.run}</span>
      <span style={{ color: "var(--wb-text)", fontWeight: 600 }}>{title}</span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>{children}</span>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        aria-label="dock back into the main window"
        title="dock back into the main window"
        style={{
          background: "transparent",
          border: "1px solid var(--wb-border)",
          color: "var(--wb-textDim2)",
          font: "10.5px var(--wb-mono)",
          cursor: "pointer",
          padding: "2px 9px",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        ⤓ dock back
      </button>
    </div>
  );
}

/** Shown when the PTY is gone (the session ended or was killed) — the window has
 *  nothing live to mirror, so invite the user to dock it back. */
function Ended({ message }: { message: string }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 24,
        textAlign: "center",
        background: "var(--wb-bg)",
      }}
    >
      <div style={{ color: "var(--wb-closed)", font: "12.5px var(--wb-mono)" }}>
        ○ session ended
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360 }}>
        {message}
      </div>
      <button onClick={() => void getCurrentWindow().close()} style={dockBackButton}>
        ⤓ dock back
      </button>
    </div>
  );
}

const dockBackButton: React.CSSProperties = {
  marginTop: 4,
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 14px",
  font: "11.5px var(--wb-mono)",
  cursor: "pointer",
};

export default TornWindow;
