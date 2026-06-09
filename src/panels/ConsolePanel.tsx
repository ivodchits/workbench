// ConsolePanel (step 1.6) — the dockview panel that hosts one instance's Claude
// console. dockview supplies the tab/group chrome; this renders the content:
// a header strip (project · branch · task note · short session id · cost) above
// either the live `xterm` terminal, an error notice, or — for a panel restored
// from a saved layout — a dormant placeholder offering a relaunch.
//
// The panel is bound to an instance via `params.instanceId`. It stays mounted
// while tabbed away (the Workspace sets dockview's `always` renderer) so its PTY
// survives split/tab/float; closing the panel unmounts it, which stops the PTY.

import { useCallback, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH, Spinner } from "../theme";
import Console from "./Console";
import type { Instance, Project } from "../ipc/registry";
import type { SpawnResult } from "../ipc/pty";
import { formatTokens, totalTokens } from "../util/format";
import { useRegistry } from "../state/registry";
import {
  markError,
  markSpawned,
  openConsole,
  useConsoles,
  type ConsoleSession,
} from "../state/consoles";

export interface ConsolePanelParams {
  instanceId: string;
}

function ConsolePanel(props: IDockviewPanelProps<ConsolePanelParams>) {
  const { instanceId } = props.params;
  const { open } = useConsoles();
  const { instances, projects } = useRegistry();

  const session = open.find((c) => c.instanceId === instanceId) ?? null;
  const instance = instances.find((i) => i.id === instanceId) ?? null;
  const project = instance
    ? projects.find((p) => p.id === instance.projectId) ?? null
    : null;

  // Keep the tab label in sync with the (renameable) instance title.
  const title = instance ? `console · ${instance.title}` : "console";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!instance) return <MissingInstance />;

  const dormant = !session || session.status === "dormant";

  // No onMouseDown→setActive here: that stole DOM focus from xterm's input on
  // every click. dockview activates the group natively when its content gains
  // focus, and that syncs the store via onDidActivePanelChange — so the terminal
  // keeps focus and you can type.
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <HeaderStrip
        project={project}
        instance={instance}
        sessionId={session?.sessionId ?? instance.lastSessionId ?? null}
        status={session?.status ?? "dormant"}
      />
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {dormant ? (
          <Dormant instance={instance} />
        ) : session.status === "error" ? (
          <ErrorBody message={session.error} />
        ) : (
          <LiveConsole instanceId={instanceId} session={session} />
        )}
      </div>
    </div>
  );
}

function LiveConsole({
  instanceId,
  session,
}: {
  instanceId: string;
  session: ConsoleSession;
}) {
  const onSpawned = useCallback(
    (result: SpawnResult) => markSpawned(instanceId, result),
    [instanceId],
  );
  const onError = useCallback(
    (message: string) => markError(instanceId, message),
    [instanceId],
  );
  return (
    <Console
      instanceId={instanceId}
      kind={session.kind}
      cwd={session.cwd}
      webgl={session.webgl}
      onSpawned={onSpawned}
      onError={onError}
    />
  );
}

/** project · branch · task note · short session id · cost — the context line (§5). */
function HeaderStrip({
  project,
  instance,
  sessionId,
  status,
}: {
  project: Project | null;
  instance: Instance;
  sessionId: string | null;
  status: ConsoleSession["status"];
}) {
  const branch = instance.branch ?? project?.defaultBranch ?? null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        padding: "7px 13px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--wb-text)", fontWeight: 600 }} title={instance.workingDir}>
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
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, paddingLeft: 12 }}>
        {status === "spawning" && (
          <span style={{ color: "var(--wb-working)" }}>
            <Spinner size={10} /> spawning
          </span>
        )}
        {sessionId && (
          <span style={{ color: "var(--wb-textFaint)" }}>{sessionId.slice(0, 8)}</span>
        )}
        <span title="tokens used (input + output + cache)">
          {formatTokens(totalTokens(instance))}
        </span>
      </span>
    </div>
  );
}

function Sep() {
  return <span style={{ color: "var(--wb-textFaint)", padding: "0 8px" }}>·</span>;
}

/** A panel restored from a saved layout whose PTY isn't running. */
function Dormant({ instance }: { instance: Instance }) {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-textDim2)", font: "12.5px var(--wb-mono)" }}>
        <span style={{ color: "var(--wb-closed)" }}>○</span> {instance.title} — not running
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}>
        this console was restored from your saved layout
      </div>
      <button onClick={() => openConsole(instance)} style={relaunchButton}>
        <span style={{ color: "var(--wb-accent)" }}>{GLYPH.run}</span> relaunch
      </button>
    </div>
  );
}

function ErrorBody({ message }: { message: string | null }) {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-needs)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} could not launch claude
      </div>
      <div style={{ color: "var(--wb-textDim2)", font: "11px var(--wb-mono)", maxWidth: 460, textAlign: "center" }}>
        {message ?? "unknown error"}
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)" }}>
        close this console and click the instance again to retry
      </div>
    </div>
  );
}

function MissingInstance() {
  return (
    <div style={centeredBody}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>
        {GLYPH.warn} this instance was removed
      </div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>
        close this panel
      </div>
    </div>
  );
}

const centeredBody: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: 24,
  background: "var(--wb-bg)",
};

const relaunchButton: React.CSSProperties = {
  marginTop: 4,
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 14px",
  font: "11.5px var(--wb-mono)",
  cursor: "pointer",
};

export default ConsolePanel;
