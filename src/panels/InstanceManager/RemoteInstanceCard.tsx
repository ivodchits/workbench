// Another machine's session in the rail (fleet plan F9.2, decision 6): a card like
// a local one, fed from that machine's snapshot (phase, activity, needs-you,
// context), with a small machine mark. Clicking it opens the session in a remote
// console tab. Its actions are only what the phone can do: interrupt, start, stop.
// No kill, worktree or edit: those belong to the machine that has it.

import { useState } from "react";
import { GLYPH, Spinner } from "../../theme";
import { matchCommand } from "../../keyboard";
import type { RemoteInstance } from "../../remote/protocol";
import { formatTokens } from "../../util/format";
import { openRemoteConsole, remoteStatus, sendRemote } from "../remoteSession";
import { relativeTime } from "./status";

interface Props {
  inst: RemoteInstance;
  machine: string;
  machineName: string;
  /** The local project it's shown under, when it's a merged one. */
  localProject: string | null;
}

function RemoteInstanceCard({ inst, machine, machineName, localProject }: Props) {
  const [hover, setHover] = useState(false);
  const view = remoteStatus(inst);
  const open = () => openRemoteConsole(machine, inst, localProject);
  const act = (type: "interrupt" | "start" | "stop") => sendRemote(machine, { type, instanceId: inst.id });
  const latest = inst.latest;
  const line = latest?.tool ? `${latest.tool.name} ${latest.tool.target}` : latest?.reply ?? latest?.prompt ?? inst.taskNote;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const m = matchCommand(e.nativeEvent, "rail");
    if (!m) return;
    switch (m.command) {
      case "railOpen":
        open();
        break;
      case "railInterrupt":
        if (inst.live) act("interrupt");
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      tabIndex={0}
      data-wb-rail-row
      data-wb-remote-instance={`${machine}:${inst.id}`}
      onClick={open}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${inst.title} on ${machineName}\n(click to open it here)`}
      style={{
        position: "relative",
        padding: "8px 11px 9px 13px",
        marginBottom: 3,
        cursor: "pointer",
        background: hover ? "var(--wb-sel)" : "transparent",
        opacity: !inst.live && !inst.phase ? 0.55 : 1,
        outline: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{ color: view.colorVar, fontSize: 12, width: 12, flex: "0 0 12px", textAlign: "center", lineHeight: 1 }}
          title={view.label}
        >
          {view.spinning ? <Spinner size={12} color={view.colorVar} /> : view.glyph}
        </span>
        <span
          style={{
            color: "var(--wb-text)",
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {inst.title}
        </span>
        {view.needsYou && (
          <span
            style={{
              font: "600 9px var(--wb-mono)",
              letterSpacing: "0.08em",
              color: "var(--wb-bg)",
              background: "var(--wb-needs)",
              padding: "1px 5px",
              borderRadius: 2,
              textTransform: "uppercase",
              flex: "0 0 auto",
            }}
          >
            needs you
          </span>
        )}
        {hover ? (
          <span style={{ display: "flex", gap: 9, flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
            {inst.live && inst.phase === "working" && <CardAction label="interrupt" onClick={() => act("interrupt")}>⏹</CardAction>}
            {inst.live ? (
              <CardAction label={`stop it on ${machineName}`} onClick={() => act("stop")}>{GLYPH.fail}</CardAction>
            ) : (
              <CardAction label={`start it on ${machineName}`} onClick={() => act("start")}>▶</CardAction>
            )}
          </span>
        ) : (
          <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)", flex: "0 0 auto" }}>
            {relativeTime(latest?.at ?? null)}
          </span>
        )}
      </div>
      {line && (
        <div
          style={{
            marginLeft: 20,
            marginTop: 3,
            font: "11px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {line}
        </div>
      )}
      <div style={{ marginLeft: 20, marginTop: 3, display: "flex", gap: 8, font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
        <span style={{ color: "var(--wb-accent)" }} title={`on ${machineName}`}>
          {GLYPH.remote} {machineName}
        </span>
        {inst.branch && <span>⌥ {inst.branch}</span>}
        {inst.ctxTokens > 0 && <span>{formatTokens(inst.ctxTokens)}</span>}
      </div>
    </div>
  );
}

function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, font: "11px var(--wb-mono)", color: "var(--wb-accent)" }}
    >
      {children}
    </button>
  );
}

export default RemoteInstanceCard;
