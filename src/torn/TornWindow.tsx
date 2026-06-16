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
import { GLYPH } from "../theme";
import { initAppearance } from "../state/appearance";
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
      <Header kind={kind} title={title} />
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {error ? (
          <Ended message={error} />
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
      </div>
    </div>
  );
}

/** A slim title bar: the panel name + a "dock back" button. Closing the window is
 *  exactly "dock back" — the main window re-adds the panel on WINDOW_DESTROYED. */
function Header({ kind, title }: { kind: TornKind; title: string }) {
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
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        aria-label="dock back into the main window"
        title="dock back into the main window"
        style={{
          marginLeft: "auto",
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
