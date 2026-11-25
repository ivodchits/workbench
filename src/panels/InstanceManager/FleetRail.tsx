// The rail's fleet parts (fleet plan F9.2):
//
// - **The machine divider** (decision 1): `── laptop ──` under a project's own
//   cards, before that machine's; one dim line `laptop · offline` while it's gone
//   (decision 5).
// - **The bottom section** (decisions 2 and 4): after the last group, the
//   `OTHER MACHINES` band, then one header per machine, its projects with sessions,
//   and last a folded `No sessions` group with the rest, from where a session can
//   still be started. All of them fold, and the folds are remembered.
// - **The picker** (decision 9): which machine, when more than one has the project.

import { useState, type CSSProperties } from "react";
import { GLYPH } from "../../theme";
import type { MachineSection, RemoteOnly } from "../../state/fleetRail";
import { closeCreatePicker, createOn, useCreatePicker } from "../../state/fleetCreate";
import RemoteInstanceCard from "./RemoteInstanceCard";
import { remoteStatus } from "../remoteSession";
import Modal from "./Modal";

const FOLDS_KEY = "wb.rail.fleetFolds";

function readFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** A fold remembered across restarts; `open` is its default. */
function useFold(key: string, open: boolean): [boolean, () => void] {
  const [folds, setFolds] = useState(readFolds);
  const isOpen = folds[key] ?? open;
  const toggle = () => {
    const next = { ...readFolds(), [key]: !isOpen };
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(next));
    } catch {
      // storage off: the fold just isn't remembered
    }
    setFolds(next);
  };
  return [isOpen, toggle];
}

export function MachineDivider({ name, offline }: { name: string; offline: string | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "6px 12px 4px 13px",
        font: "10px var(--wb-mono)",
        letterSpacing: "0.06em",
        color: offline ? "var(--wb-textFaint)" : "var(--wb-textDim2)",
        opacity: offline ? 0.6 : 1,
      }}
    >
      <span style={{ flex: 1, borderTop: "1px solid var(--wb-border)" }} />
      <span>
        {GLYPH.remote} {name}
        {offline && ` · ${offline}`}
      </span>
      <span style={{ flex: 1, borderTop: "1px solid var(--wb-border)" }} />
    </div>
  );
}

export function FleetSection({
  sections,
  needsYouOnly,
  whyOffline,
}: {
  sections: MachineSection[];
  needsYouOnly: boolean;
  whyOffline: (machine: string) => string;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          margin: "0 0 6px",
          padding: "5px 12px",
          background: "var(--wb-sel)",
          borderTop: "1px solid var(--wb-border)",
          borderBottom: "1px solid var(--wb-border)",
          font: "600 10px var(--wb-mono)",
          letterSpacing: "0.14em",
          color: "var(--wb-textDim2)",
        }}
      >
        OTHER MACHINES
      </div>
      {sections.map((s) => (
        <MachineBlock key={s.machine} section={s} needsYouOnly={needsYouOnly} why={s.online ? null : whyOffline(s.machine)} />
      ))}
    </div>
  );
}

function MachineBlock({ section, needsYouOnly, why }: { section: MachineSection; needsYouOnly: boolean; why: string | null }) {
  const [open, toggle] = useFold(`machine:${section.machine}`, true);
  const [emptyOpen, toggleEmpty] = useFold(`empty:${section.machine}`, false);
  const withSessions = needsYouOnly
    ? section.withSessions.filter((r) => r.instances.some((i) => remoteStatus(i).needsYou))
    : section.withSessions;
  return (
    <div style={{ marginBottom: 6 }}>
      <button onClick={toggle} style={{ ...headerStyle, opacity: why ? 0.6 : 1 }} disabled={why !== null}>
        <span style={{ color: "var(--wb-textFaint)" }}>{why ? " " : open ? "▾" : "▸"}</span>
        <span style={{ color: why ? "var(--wb-textFaint)" : "var(--wb-accent)" }}>
          {GLYPH.remote} {section.name}
          {why && ` · ${why}`}
        </span>
        {!why && (
          <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)", letterSpacing: 0 }}>
            {section.withSessions.length + section.noSessions.length}
          </span>
        )}
      </button>
      {open && !why && (
        <>
          {withSessions.map((r) => (
            <RemoteProjectNode key={r.project.id} entry={r} machineName={section.name} needsYouOnly={needsYouOnly} />
          ))}
          {section.noSessions.length > 0 && !needsYouOnly && (
            <div>
              <button onClick={toggleEmpty} style={{ ...headerStyle, paddingLeft: 20, letterSpacing: "0.06em" }}>
                <span style={{ color: "var(--wb-textFaint)" }}>{emptyOpen ? "▾" : "▸"}</span>
                <span style={{ color: "var(--wb-textDim2)" }}>no sessions</span>
                <span style={{ marginLeft: "auto", color: "var(--wb-textFaint)", letterSpacing: 0 }}>
                  {section.noSessions.length}
                </span>
              </button>
              {emptyOpen &&
                section.noSessions.map((r) => <EmptyProjectRow key={r.project.id} entry={r} machineName={section.name} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RemoteProjectNode({ entry, machineName, needsYouOnly }: { entry: RemoteOnly; machineName: string; needsYouOnly: boolean }) {
  const [open, toggle] = useFold(`rproj:${entry.machine}:${entry.project.id}`, true);
  const [hover, setHover] = useState(false);
  const needs = entry.instances.filter((i) => remoteStatus(i).needsYou).length;
  const running = entry.instances.filter((i) => i.live).length;
  const shown = needsYouOnly ? entry.instances.filter((i) => remoteStatus(i).needsYou) : entry.instances;
  return (
    <div>
      <div
        tabIndex={0}
        data-wb-rail-row
        onClick={toggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "relative",
          padding: "10px 15px 11px 15px",
          margin: "5px 8px",
          borderRadius: 4,
          border: "1px solid var(--wb-border)",
          borderLeft: "3px solid var(--wb-border)",
          background: hover ? "var(--wb-sel)" : "transparent",
          cursor: "pointer",
        }}
        title={`${entry.project.name} — only on ${machineName}`}
      >
        <NewHere entry={entry} machineName={machineName} visible={hover} />
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ color: "var(--wb-textFaint)", font: "15px var(--wb-mono)" }}>{open ? "▾" : "▸"}</span>
          <span style={{ font: "600 14px var(--wb-mono)", color: "var(--wb-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entry.project.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, marginLeft: 21, marginTop: 3, font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
          <span>
            {entry.instances.length} instance{entry.instances.length === 1 ? "" : "s"}
          </span>
          {running > 0 && <span style={{ color: "var(--wb-accent)" }}>{running} running</span>}
          {needs > 0 && <span style={{ color: "var(--wb-needs)" }}>● {needs} need you</span>}
        </div>
      </div>
      {open && (
        <div style={{ paddingLeft: 8 }}>
          {shown.map((i) => (
            <RemoteInstanceCard key={i.id} inst={i} machine={entry.machine} machineName={machineName} localProject={null} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyProjectRow({ entry, machineName }: { entry: RemoteOnly; machineName: string }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      tabIndex={0}
      data-wb-rail-row
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        padding: "6px 15px 6px 34px",
        font: "12px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        background: hover ? "var(--wb-sel)" : "transparent",
      }}
      title={`${entry.project.name} — on ${machineName}, no sessions`}
    >
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.project.name}</span>
      <NewHere entry={entry} machineName={machineName} visible={hover} inline />
    </div>
  );
}

/** A remote-only project's `+`: a session there. */
function NewHere({ entry, machineName, visible, inline }: { entry: RemoteOnly; machineName: string; visible: boolean; inline?: boolean }) {
  return (
    <button
      aria-label={`new instance on ${machineName}`}
      title={`new instance on ${machineName}`}
      onClick={(e) => {
        e.stopPropagation();
        createOn({ machine: entry.machine, name: machineName, projectId: entry.project.id });
      }}
      style={{
        ...(inline ? {} : { position: "absolute", top: 8, right: 12 }),
        visibility: visible ? "visible" : "hidden",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        lineHeight: 1,
        font: "15px var(--wb-mono)",
        color: "var(--wb-accent)",
      }}
    >
      +
    </button>
  );
}

/** Which machine to start a session on, when more than one has the project. */
export function RemotePicker() {
  const picking = useCreatePicker();
  if (!picking) return null;
  return (
    <Modal title={`new ${picking.projectName} session on…`} onClose={closeCreatePicker} width={340}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {picking.targets.map((t) => (
          <button
            key={t.machine}
            disabled={!t.online}
            autoFocus={t === picking.targets.find((x) => x.online)}
            onClick={() => {
              closeCreatePicker();
              createOn(t);
            }}
            style={{
              ...pickStyle,
              opacity: t.online ? 1 : 0.5,
              cursor: t.online ? "pointer" : "default",
            }}
          >
            <span style={{ color: "var(--wb-accent)" }}>{GLYPH.remote}</span> {t.name}
            <span style={{ marginLeft: "auto", color: t.online ? "var(--wb-done)" : "var(--wb-textFaint)" }}>
              {t.online ? "online" : "offline"}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

const headerStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 12px",
  font: "600 10.5px var(--wb-mono)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--wb-textDim2)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};

const pickStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  background: "transparent",
  border: "1px solid var(--wb-border)",
  borderRadius: 3,
  font: "12.5px var(--wb-mono)",
  color: "var(--wb-text)",
  textAlign: "left",
};
