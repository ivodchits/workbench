// Console area (step 1.5) — the center surface that hosts every open console.
//
// Until dockview lands (step 1.6) this is a deliberately simple responsive grid:
// each open console is a Panel that stays mounted (so its PTY keeps running in the
// background) and the focused one is accented. Two instances therefore run side by
// side out of the box. The grid is throwaway scaffolding — 1.6 swaps it for a real
// split/tab/float dock without touching the console wiring below.

import { useCallback, useMemo, type CSSProperties } from "react";
import Panel from "../theme/Panel";
import { GLYPH, Spinner } from "../theme";
import Console from "./Console";
import type { Instance, Project } from "../ipc/registry";
import type { SpawnResult } from "../ipc/pty";
import { useRegistry } from "../state/registry";
import {
  closeConsole,
  focusConsole,
  markError,
  markSpawned,
  useConsoles,
  type ConsoleSession,
} from "../state/consoles";

function ConsoleArea() {
  const { open, activeId } = useConsoles();
  const { instances, projects } = useRegistry();

  const instanceById = useMemo(() => {
    const m = new Map<string, Instance>();
    for (const i of instances) m.set(i.id, i);
    return m;
  }, [instances]);
  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  if (open.length === 0) return <EmptyState />;

  return (
    <div style={gridStyle}>
      {open.map((session) => {
        const instance = instanceById.get(session.instanceId);
        if (!instance) return null; // row was removed out from under the console
        return (
          <ConsoleHost
            key={session.instanceId}
            session={session}
            instance={instance}
            project={projectById.get(instance.projectId) ?? null}
            active={session.instanceId === activeId}
          />
        );
      })}
    </div>
  );
}

interface ConsoleHostProps {
  session: ConsoleSession;
  instance: Instance;
  project: Project | null;
  active: boolean;
}

function ConsoleHost({ session, instance, project, active }: ConsoleHostProps) {
  const { instanceId } = session;

  const onSpawned = useCallback(
    (result: SpawnResult) => markSpawned(instanceId, result),
    [instanceId],
  );
  const onError = useCallback(
    (message: string) => markError(instanceId, message),
    [instanceId],
  );

  // The minted session id: prefer the live spawn result, fall back to whatever
  // the row last persisted (so a relaunch's header doesn't flicker to blank).
  const sessionId = session.sessionId ?? instance.lastSessionId;

  return (
    <Panel
      title={`console · ${instance.title}`}
      accent={active}
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {session.status === "spawning" ? (
            <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-working)" }}>
              <Spinner size={10} /> spawning
            </span>
          ) : session.status === "error" ? (
            <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-needs)" }}>
              {GLYPH.fail} failed
            </span>
          ) : (
            sessionId && (
              <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textDim2)" }}>
                {sessionId.slice(0, 8)}
              </span>
            )
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeConsole(instanceId);
            }}
            aria-label="close console"
            title="close console (stops the PTY; the instance remains)"
            style={closeButtonStyle}
          >
            {GLYPH.fail}
          </button>
        </span>
      }
      style={{ height: "100%", minHeight: 0 }}
      bodyStyle={{ padding: 0, paddingTop: 9 }}
    >
      <div onMouseDown={() => focusConsole(instanceId)} style={{ display: "contents" }}>
        <HeaderStrip
          project={project}
          instance={instance}
          cwd={session.cwd}
        />
        <div style={{ flex: "1 1 auto", minHeight: 0 }}>
          {session.status === "error" ? (
            <ErrorBody message={session.error} />
          ) : (
            <Console
              instanceId={instanceId}
              kind={session.kind}
              cwd={session.cwd}
              webgl={session.webgl}
              onSpawned={onSpawned}
              onError={onError}
            />
          )}
        </div>
      </div>
    </Panel>
  );
}

/** project · branch · task note · cost — the at-a-glance context line (§5). */
function HeaderStrip({
  project,
  instance,
  cwd,
}: {
  project: Project | null;
  instance: Instance;
  cwd: string;
}) {
  const branch = instance.branch ?? project?.defaultBranch ?? null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 0,
        padding: "8px 13px",
        borderBottom: "1px solid var(--wb-border)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--wb-text)", fontWeight: 600 }} title={cwd}>
        {project?.name ?? "—"}
      </span>
      {branch && (
        <>
          <Sep />
          <span style={{ color: "var(--wb-accent)" }}>
            {instance.worktreeOn && `${GLYPH.worktree} `}
            {branch}
          </span>
        </>
      )}
      {instance.taskNote && (
        <>
          <Sep />
          <span
            style={{ fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
          >
            {instance.taskNote}
          </span>
        </>
      )}
      <span style={{ marginLeft: "auto", paddingLeft: 12, color: "var(--wb-textDim2)" }}>
        ${instance.costUsd.toFixed(2)}
      </span>
    </div>
  );
}

function Sep() {
  return <span style={{ color: "var(--wb-textFaint)", padding: "0 8px" }}>·</span>;
}

function ErrorBody({ message }: { message: string | null }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ color: "var(--wb-needs)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} could not launch claude
      </div>
      <div style={{ color: "var(--wb-textDim2)", font: "11px var(--wb-mono)", maxWidth: 460 }}>
        {message ?? "unknown error"}
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
        close this console and click the instance again to retry
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={emptyStyle}>
      <div style={{ color: "var(--wb-textDim2)", font: "13px var(--wb-mono)" }}>
        no console open
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11.5px var(--wb-mono)", maxWidth: 420, textAlign: "center" }}>
        click an instance in the rail to launch its claude console — or several, to
        run agents side by side
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(440px, 1fr))",
  gridAutoRows: "minmax(300px, 1fr)",
  gap: 14,
  padding: "14px 14px 0",
  overflow: "auto",
};

const emptyStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  padding: "14px 14px 0",
};

const closeButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
  font: "11px var(--wb-mono)",
  color: "var(--wb-textDim2)",
};

export default ConsoleArea;
