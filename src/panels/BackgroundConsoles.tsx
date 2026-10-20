// The hidden holder for consoles started in the background (Duck's workers, step
// D1). A console's PTY is spawned when its terminal first mounts, and the dock only
// mounts the shown project's consoles, so a worker in another project would never
// start. This mounts each such console off screen until it is running; from then
// on the pool keeps it alive like any console of a project you aren't looking at,
// and it docks when you open its project.

import { useCallback } from "react";

import type { SpawnResult } from "../ipc/pty";
import { useActiveProject } from "../state/activeProject";
import { markError, markSpawned, useConsoles, type ConsoleSession } from "../state/consoles";
import { useRegistry } from "../state/registry";
import Console from "./Console";

/** Big enough for a TUI the size of a normal panel (≈ 120 × 36). */
const HOLDER = { width: 1100, height: 700 };

export default function BackgroundConsoles() {
  const { open } = useConsoles();
  const { instances } = useRegistry();
  const shown = useActiveProject();
  const held = open.filter(
    (c) =>
      c.background &&
      !c.headless &&
      c.status === "spawning" &&
      !c.tornOff &&
      instances.find((i) => i.id === c.instanceId)?.projectId !== shown,
  );
  if (held.length === 0) return null;
  return (
    <div
      aria-hidden
      style={{ position: "fixed", left: -10_000, top: 0, ...HOLDER, overflow: "hidden", pointerEvents: "none" }}
    >
      {held.map((c) => (
        <Held key={c.instanceId} session={c} />
      ))}
    </div>
  );
}

function Held({ session }: { session: ConsoleSession }) {
  const id = session.instanceId;
  const onSpawned = useCallback((r: SpawnResult) => markSpawned(id, r), [id]);
  const onError = useCallback((m: string) => markError(id, m), [id]);
  return (
    <div style={HOLDER}>
      <Console
        instanceId={id}
        kind={session.kind}
        cwd={session.cwd}
        webgl={false}
        resumeSessionId={session.resumeSessionId}
        remote={session.remote}
        onSpawned={onSpawned}
        onError={onError}
      />
    </div>
  );
}
