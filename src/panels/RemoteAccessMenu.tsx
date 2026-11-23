// Remote access menu (step 4.3, design §11) — the status-bar control for the
// tailnet remote server. Off by default; this is where you enable it, read the URL
// to open on your phone, mint a one-time pairing code, allow or revoke devices, and
// see recent auth failures (step R2).
// Mirrors the AppearanceMenu's upward popover so it sits naturally in the status bar.
//
// The server binds *only* the detected Tailscale interface and loopback — never the
// LAN. If Tailscale isn't up yet the panel says so, and the tailnet address follows
// once it connects. Public access (step R3) is a separate switch: Tailscale Funnel
// puts the loopback listener at a fixed https address, shown here with a QR code.

import { useEffect, useRef, useState } from "react";
import {
  approveDevice,
  newPairingCode,
  refreshRemoteStatus,
  revokeDevice,
  setPublicAccess,
  startRemote,
  stopRemote,
  useRemoteServer,
} from "../state/remoteServer";
import {
  remoteClearAuthLog,
  remoteQrSvg,
  type PublicStatus,
  type RemoteDevice,
} from "../ipc/remote";
import {
  fleetClearLog,
  fleetJoin,
  fleetNewCode,
  fleetRemove,
  fleetRename,
  fleetResetIdentity,
  fleetSetCanBeMain,
  fleetSetKind,
  fleetSetOrder,
  fleetSetPin,
  fleetSetWakeable,
  fleetWake,
  FLEET_KINDS,
  type FleetKind,
  type FleetMember,
  type FleetStatus,
} from "../ipc/fleet";
import { openUrl } from "../ipc/os";
import { refreshFleet, setFleetStatus, useFleet } from "../state/fleet";
import { formatAgo, formatCountdown } from "../util/format";

/** Failures listed before "show all". */
const FAILURES_SHOWN = 4;

function RemoteAccessMenu() {
  const { status, devices, failures } = useRemoteServer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allFailures, setAllFailures] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh whenever the popover opens: a code's expiry and "seen" times move on
  // without the backend announcing anything.
  useEffect(() => {
    if (!open) return;
    void refreshRemoteStatus();
    void refreshFleet();
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const running = status?.running ?? false;
  const tailscale = status?.tailscaleAvailable ?? false;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (running) await stopRemote();
      else await startRemote();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function mintCode() {
    setBusy(true);
    setError(null);
    try {
      await newPairingCode();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const waiting = status?.pendingCount ?? 0;
  const fleet = useFleet();
  const machines = fleet?.members.length ?? 0;
  const machinesOnline = fleet?.members.filter((m) => m.online).length ?? 0;
  const shownFailures = allFailures ? failures : failures.slice(0, FAILURES_SHOWN);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="remote access (tailnet)"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color: running ? "var(--wb-accent)" : "var(--wb-textFaint)",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{ color: running ? "var(--wb-accent)" : "var(--wb-textFaint)" }}>⇄</span>
        remote {running ? `:${status?.port ?? ""}` : "off"}
        {running && status?.public.phase === "on" && <span>· public</span>}
        {running && status?.public.phase === "problem" && (
          <span style={{ color: "var(--wb-needs)" }}>· public ✕</span>
        )}
        {waiting > 0 && <span style={{ color: "var(--wb-needs)" }}>· {waiting} waiting</span>}
        {machines > 0 && (
          <span
            title={`${machinesOnline} of ${machines} other machines online`}
            style={{ color: machinesOnline > 0 ? "var(--wb-accent)" : "var(--wb-textFaint)" }}
          >
            · fleet {machinesOnline}/{machines}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 22,
            left: 0,
            zIndex: 200,
            width: 340,
            maxHeight: "80vh",
            overflowY: "auto",
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: "10px 0",
            font: "11px var(--wb-mono)",
          }}
        >
          <SectionLabel>remote access · tailnet</SectionLabel>

          <Row>
            <span style={{ color: "var(--wb-text)", flex: 1 }}>
              {running ? "serving" : "off"}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggle()}
              style={toggleStyle(running, busy)}
            >
              {running ? "disable" : "enable"}
            </button>
          </Row>

          {(running ? !status?.boundAddr : !tailscale) && (
            <Note>
              Tailscale isn’t connected — the tailnet url appears here once it is.
            </Note>
          )}

          {running && status?.url && (
            <Row>
              <span style={{ color: "var(--wb-textFaint)" }}>tailnet</span>
              <code
                style={{
                  flex: 1,
                  color: "var(--wb-accent)",
                  userSelect: "all",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {status.url}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(status.url ?? "")}
                title="copy"
                style={miniBtn}
              >
                copy
              </button>
            </Row>
          )}

          {running && status && <PublicAccess pub={status.public} />}

          {running && (
            <>
              <Divider />
              <SectionLabel>pair a device</SectionLabel>
              {status?.pairingCode ? (
                <Row>
                  <code
                    style={{
                      flex: 1,
                      color: "var(--wb-text)",
                      fontSize: 14,
                      letterSpacing: "0.15em",
                      userSelect: "all",
                    }}
                  >
                    {status.pairingCode}
                  </code>
                  <span style={{ color: "var(--wb-textFaint)", fontSize: 10 }}>
                    {status.pairingExpiresAt
                      ? `expires ${formatCountdown(status.pairingExpiresAt)}`
                      : ""}
                  </span>
                </Row>
              ) : status?.pairingLocked ? (
                <Note tone="error">
                  The last code took too many wrong tries and no longer works. Generate a
                  new one.
                </Note>
              ) : (
                <Note>
                  Open the url on the device, then generate a code to enter there. You
                  will be asked here to allow the device. The page installs as an app —
                  use “Add to Home Screen”.
                </Note>
              )}
              <Row>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mintCode()}
                  style={{ ...miniBtn, marginLeft: "auto" }}
                >
                  {status?.pairingCode ? "new code" : "generate code"}
                </button>
              </Row>
            </>
          )}

          <Divider />
          <SectionLabel>paired devices ({devices.length})</SectionLabel>
          {devices.length === 0 ? (
            <Note>none yet</Note>
          ) : (
            devices.map((d) => <DeviceRow key={d.id} device={d} />)
          )}

          {failures.length > 0 && (
            <>
              <Divider />
              <Row>
                <span style={sectionLabelStyle}>auth failures</span>
                <button
                  type="button"
                  onClick={() => void remoteClearAuthLog()}
                  title="clear the list"
                  style={{ ...miniBtn, marginLeft: "auto" }}
                >
                  clear
                </button>
              </Row>
              {shownFailures.map((f) => (
                <div
                  key={`${f.addr} ${f.what}`}
                  style={{ padding: "2px 12px", fontSize: 10, lineHeight: 1.5 }}
                >
                  <div style={{ color: "var(--wb-text)" }}>
                    {f.what}
                    {f.count > 1 && <span style={{ color: "var(--wb-textFaint)" }}> ×{f.count}</span>}
                  </div>
                  <div style={{ color: "var(--wb-textFaint)" }}>
                    {f.addr} · {formatAgo(f.at)}
                  </div>
                </div>
              ))}
              {failures.length > FAILURES_SHOWN && (
                <Row>
                  <button
                    type="button"
                    onClick={() => setAllFailures((v) => !v)}
                    style={{ ...miniBtn, border: "none", padding: 0 }}
                  >
                    {allFailures ? "show fewer" : `show all ${failures.length}`}
                  </button>
                </Row>
              )}
            </>
          )}

          <Divider />
          <FleetSection />

          {error && <Note tone="error">{error}</Note>}
        </div>
      )}
    </div>
  );
}

/** The fleet (fleet plan F1.1, F1.2): this machine's name, the other Workbench
 *  machines it links to over the tailnet, joining with a one-time code, and who is
 *  main. Independent of the phone's server above: machines talk on their own
 *  tailnet-only port. */
function FleetSection() {
  const fleet = useFleet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [join, setJoin] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (!fleet) return null;

  async function run(f: () => Promise<FleetStatus>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setFleetStatus(await f());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveName() {
    const next = name?.trim();
    setName(null);
    if (next && next !== fleet?.me.name) void run(() => fleetRename(next));
  }

  async function joinNow() {
    const text = join.trim();
    if (text && (await run(() => fleetJoin(text)))) setJoin("");
  }

  const others = fleet.members;
  return (
    <>
      <SectionLabel>fleet · your machines</SectionLabel>
      <Row>
        <span style={{ color: "var(--wb-textFaint)" }}>this</span>
        {name === null ? (
          <button
            type="button"
            onClick={() => setName(fleet.me.name)}
            title="rename this machine (the others see it)"
            style={{
              ...miniBtn,
              border: "none",
              padding: 0,
              color: "var(--wb-text)",
              flex: 1,
              textAlign: "left",
            }}
          >
            {fleet.me.name}
          </button>
        ) : (
          <input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(null);
              }
            }}
            style={inputStyle}
          />
        )}
        {fleet.config.duck === fleet.me.id && <MainBadge term={fleet.config.leaseTerm} />}
        <span style={{ color: "var(--wb-textFaint)", fontSize: 10 }} title={`fleet id ${fleet.me.id}`}>
          {[versionOf(fleet.me), fleet.listening ?? (fleet.tailnet ? "not listening" : "no tailnet")]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Row>

      {fleet.problem && (
        <>
          <Note tone="error">{fleet.problem}</Note>
          <Row>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(fleetResetIdentity)}
              title="a new id and key for this machine; it leaves the fleet and has to join again"
              style={{ ...miniBtn, marginLeft: "auto", color: "var(--wb-needs)" }}
            >
              reset this machine’s identity
            </button>
          </Row>
        </>
      )}

      {others.length === 0 ? (
        <Note>
          No other machines yet. Make a join code here and paste it on the other machine (or
          the other way round). Both need Tailscale, logged in as you.
        </Note>
      ) : (
        others.map((m) => (
          <MachineRow
            key={m.id}
            m={m}
            main={fleet.config.duck === m.id ? fleet.config.leaseTerm : null}
            canWake={fleet.config.wake.includes(m.id)}
            busy={busy}
            onRemove={() => void run(() => fleetRemove(m.id))}
            onWakeable={(on) => void run(() => fleetSetWakeable(m.id, on))}
            onWake={() => {
              setError(null);
              setInfo(null);
              fleetWake(m.id).then(
                (said) => setInfo(`Wake-on-LAN: ${said}.`),
                (e: unknown) => setError(String(e)),
              );
            }}
          />
        ))
      )}

      {others.length > 0 && <PriorityList fleet={fleet} busy={busy} run={run} />}
      {fleet.replica && (
        <Note tone={fleet.replica.error ? "error" : undefined}>
          Duck&apos;s state: a copy of {fleet.replica.of}&apos;s
          {fleet.replica.head > fleet.replica.seq ? `, ${fleet.replica.head - fleet.replica.seq} changes behind` : ", up to date"}
          {fleet.replica.at ? ` · ${formatAgo(fleet.replica.at)}` : ""}
          {fleet.replica.error ? ` · ${fleet.replica.error}` : ""}
        </Note>
      )}

      <Row>
        {fleet.joinString ? (
          <>
            <code
              style={{
                flex: 1,
                color: "var(--wb-text)",
                userSelect: "all",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title="paste this on the other machine"
            >
              {fleet.joinString}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(fleet.joinString ?? "")}
              style={miniBtn}
            >
              copy
            </button>
          </>
        ) : (
          <span style={{ flex: 1, color: "var(--wb-textFaint)", fontSize: 10 }}>
            {fleet.codeLocked ? "the last code took too many wrong tries" : "add a machine"}
          </span>
        )}
        <button
          type="button"
          disabled={busy || !fleet.tailnet}
          onClick={() => void run(fleetNewCode)}
          title={fleet.tailnet ? "a one-time code for 10 minutes" : "Tailscale isn’t connected"}
          style={miniBtn}
        >
          {fleet.joinString ? "new code" : "join code"}
        </button>
      </Row>
      {fleet.joinString && fleet.codeExpiresAt && (
        <Note>Paste it on the other machine · expires {formatCountdown(fleet.codeExpiresAt)}</Note>
      )}
      <Row>
        <input
          value={join}
          placeholder="paste a join code from another machine"
          onChange={(e) => setJoin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void joinNow();
          }}
          style={inputStyle}
        />
        <button
          type="button"
          disabled={busy || !join.trim()}
          onClick={() => void joinNow()}
          style={miniBtn}
        >
          join
        </button>
      </Row>

      {others.length > 0 && (
        <Row>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => fleetRemove(fleet.me.id))}
            title="this machine forgets the fleet, and the others forget it"
            style={{ ...miniBtn, marginLeft: "auto", color: "var(--wb-needs)" }}
          >
            leave the fleet
          </button>
        </Row>
      )}

      {fleet.log.length > 0 && (
        <>
          <Row>
            <span style={sectionLabelStyle}>fleet log</span>
            <button
              type="button"
              onClick={() => void run(fleetClearLog)}
              style={{ ...miniBtn, marginLeft: "auto" }}
            >
              clear
            </button>
          </Row>
          {fleet.log.slice(0, FAILURES_SHOWN).map((f) => (
            <div
              key={`${f.addr} ${f.what}`}
              style={{ padding: "2px 12px", fontSize: 10, lineHeight: 1.5 }}
            >
              <div style={{ color: "var(--wb-text)" }}>
                {f.what}
                {f.count > 1 && <span style={{ color: "var(--wb-textFaint)" }}> ×{f.count}</span>}
              </div>
              <div style={{ color: "var(--wb-textFaint)" }}>
                {f.addr} · {formatAgo(f.at)}
              </div>
            </div>
          ))}
        </>
      )}
      {info && <Note>{info}</Note>}
      {error && <Note tone="error">{error}</Note>}
    </>
  );
}

/** Who is main and in what order (F1.2): the fleet's shared list, edited on any
 *  machine. While there's no election the main is the pinned machine; the list's
 *  first choice is shown for when there will be. */
function PriorityList({
  fleet,
  busy,
  run,
}: {
  fleet: FleetStatus;
  busy: boolean;
  run: (f: () => Promise<FleetStatus>) => Promise<boolean>;
}) {
  const c = fleet.config;
  const byId = new Map<string, FleetMember>([fleet.me, ...fleet.members].map((m) => [m.id, m]));
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? "a machine") : "");
  const order = c.order.filter((id) => byId.has(id));

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    void run(() => fleetSetOrder(next));
  }

  const summary = c.main
    ? `main: ${name(c.main)} (pinned)`
    : c.firstChoice
      ? `no main pinned · the list would pick ${name(c.firstChoice)}`
      : "no main pinned · no machine that can be main is up";

  return (
    <>
      <Row>
        <span style={sectionLabelStyle}>main · priority</span>
        {c.customOrder && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => fleetSetOrder([]))}
            title="back to the default order: desktop, server, laptop"
            style={{ ...miniBtn, marginLeft: "auto" }}
          >
            default order
          </button>
        )}
      </Row>
      {order.map((id, i) => {
        const m = byId.get(id)!;
        const isMe = id === fleet.me.id;
        const pinned = c.pin === id;
        const canBeMain = !c.notMain.includes(id);
        return (
          <div
            key={id}
            style={{ padding: "2px 12px", display: "flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ color: "var(--wb-textFaint)", width: 12, textAlign: "right" }}>
              {i + 1}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: canBeMain ? "var(--wb-text)" : "var(--wb-textFaint)",
              }}
              title={isMe ? "this machine" : m.online ? "online" : "offline"}
            >
              {m.name}
              {isMe && <span style={{ color: "var(--wb-textFaint)" }}> (this)</span>}
            </span>
            {isMe ? (
              <select
                value={m.kind || "desktop"}
                disabled={busy}
                onChange={(e) => void run(() => fleetSetKind(e.target.value as FleetKind))}
                title="what sort of machine this is; it places it in the default order"
                style={{ ...miniBtn, padding: "1px 2px" }}
              >
                {FLEET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ color: "var(--wb-textFaint)", fontSize: 10 }}>{m.kind || "?"}</span>
            )}
            <button
              type="button"
              disabled={busy || i === 0}
              onClick={() => move(i, -1)}
              title="higher priority"
              style={{ ...miniBtn, padding: "1px 5px" }}
            >
              ↑
            </button>
            <button
              type="button"
              disabled={busy || i === order.length - 1}
              onClick={() => move(i, 1)}
              title="lower priority"
              style={{ ...miniBtn, padding: "1px 5px" }}
            >
              ↓
            </button>
            <input
              type="checkbox"
              checked={canBeMain}
              disabled={busy}
              onChange={(e) => void run(() => fleetSetCanBeMain(id, e.target.checked))}
              title="can be main"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => fleetSetPin(pinned ? null : id))}
              title={pinned ? "unpin: no main by hand" : "pin the main to this machine"}
              style={{
                ...miniBtn,
                padding: "1px 6px",
                color: pinned ? "var(--wb-accent)" : "var(--wb-textDim2)",
                borderColor: pinned ? "var(--wb-accent)" : "var(--wb-border)",
              }}
            >
              {pinned ? "main" : "pin"}
            </button>
          </div>
        );
      })}
      <Note>
        {summary}
        {c.by && ` · changed on ${c.by} ${formatAgo(Math.floor(c.updatedAt / 1000))}`}
      </Note>
    </>
  );
}

/** A machine's app version, as its row says it. */
function versionOf(m: FleetMember): string | null {
  return m.version ? `v${m.version}${m.build === "debug" ? " dev" : ""}` : null;
}

/** Marks the machine Duck runs on now: the fleet's main (the lease's holder). */
function MainBadge({ term }: { term: number }) {
  return (
    <span
      title={term > 0 ? `the main: Duck runs here (term ${term})` : "the main: Duck runs here"}
      style={{
        color: "var(--wb-accent)",
        border: "1px solid var(--wb-accent)",
        padding: "0 4px",
        fontSize: 9.5,
        lineHeight: "14px",
        flexShrink: 0,
      }}
    >
      main
    </span>
  );
}

/** One other machine: online or when last heard from, what it runs, waking it
 *  (Wake-on-LAN, F4.1), remove. */
function MachineRow({
  m,
  main,
  canWake,
  busy,
  onRemove,
  onWakeable,
  onWake,
}: {
  m: FleetMember;
  /** Duck runs there: the lease's term. */
  main: number | null;
  canWake: boolean;
  busy: boolean;
  onRemove: () => void;
  onWakeable: (on: boolean) => void;
  onWake: () => void;
}) {
  const seen = m.online
    ? `online · ${m.direction === "out" ? "dialed" : "dialed in"}`
    : m.lastSeen
      ? `seen ${formatAgo(m.lastSeen)}`
      : "never connected";
  const detail = [seen, versionOf(m), m.os];
  const where = [
    m.host ?? m.ip,
    `${m.ip}:${m.port}`,
    m.caps.length > 0 ? `can: ${m.caps.join(", ")}` : "",
  ];
  return (
    <div style={{ padding: "4px 12px", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: m.online ? "var(--wb-accent)" : "var(--wb-textFaint)" }}>●</span>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
        <div
          style={{
            color: "var(--wb-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {m.name}
          {main !== null && (
            <>
              {" "}
              <MainBadge term={main} />
            </>
          )}
        </div>
        <div
          style={{ color: "var(--wb-textFaint)", fontSize: 10 }}
          title={where.filter(Boolean).join("\n")}
        >
          {detail.filter(Boolean).join(" · ")}
        </div>
      </div>
      <label
        title={
          m.wakeable
            ? "can be woken with Wake-on-LAN (from sleep; from off needs it on in the BIOS)"
            : "it hasn't said its network address yet: start it once"
        }
        style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--wb-textFaint)", fontSize: 10 }}
      >
        <input
          type="checkbox"
          checked={canWake}
          disabled={busy || (!m.wakeable && !canWake)}
          onChange={(e) => onWakeable(e.target.checked)}
        />
        wake
      </label>
      {!m.online && canWake && m.wakeable && (
        <button type="button" disabled={busy} onClick={onWake} title="send it a Wake-on-LAN packet" style={miniBtn}>
          wake now
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="remove it from the fleet, on every machine"
        style={{ ...miniBtn, color: "var(--wb-needs)" }}
      >
        remove
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "10.5px var(--wb-mono)",
  padding: "2px 6px",
};

/** The public access (Funnel) switch, what it exposes, and where it stands. */
function PublicAccess({ pub }: { pub: PublicStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      await setPublicAccess(!pub.enabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Divider />
      <Row>
        <span style={{ ...sectionLabelStyle, flex: 1 }}>public access · funnel</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void flip()}
          style={toggleStyle(pub.enabled, busy)}
        >
          {pub.enabled ? "turn off" : "turn on"}
        </button>
      </Row>
      {!pub.enabled && (
        <Note>
          Puts this server on the internet at a fixed https address (port {pub.port}) through
          Tailscale Funnel, so a phone can reach it without Tailscale. Anyone can load the
          page; nothing works without a pairing code from here and your allow. Stays on
          across restarts.
        </Note>
      )}
      {pub.phase === "starting" && <Note>setting up the funnel…</Note>}
      {pub.phase === "problem" && (
        <Note tone="error">
          {pub.problem}
          {pub.fixUrl && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void openUrl(pub.fixUrl ?? "").catch(() => {})}
                style={{ ...miniBtn, border: "none", padding: 0, textDecoration: "underline" }}
              >
                open the page
              </button>
            </>
          )}
          <span style={{ color: "var(--wb-textFaint)" }}> Workbench keeps trying.</span>
        </Note>
      )}
      {pub.phase === "on" && pub.url && <PublicUrl url={pub.url} />}
      {error && <Note tone="error">{error}</Note>}
    </>
  );
}

/** The public address, with a copy button and a QR code to scan with the phone. */
function PublicUrl({ url }: { url: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    remoteQrSvg(url)
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <>
      <Row>
        <span style={{ color: "var(--wb-textFaint)" }}>public</span>
        <code
          style={{
            flex: 1,
            color: "var(--wb-accent)",
            userSelect: "all",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {url}
        </code>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(url)}
          title="copy"
          style={miniBtn}
        >
          copy
        </button>
      </Row>
      {svg && (
        <div style={{ padding: "4px 12px", display: "flex", justifyContent: "center" }}>
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            alt={`QR code for ${url}`}
            width={150}
            height={150}
          />
        </div>
      )}
    </>
  );
}

/** One paired device: allow / turn away while it waits, revoke once allowed. */
function DeviceRow({ device: d }: { device: RemoteDevice }) {
  const detail = d.approved
    ? [d.lastAddr, d.lastSeen ? `seen ${formatAgo(d.lastSeen)}` : "never used", d.bound ? "key-bound" : "no device key"]
    : [d.lastAddr, `waiting · ${formatCountdown(d.expiresAt)} left`, d.bound ? "key-bound" : "no device key"];
  return (
    <div style={{ padding: "4px 12px", display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
        <div
          style={{
            color: d.approved ? "var(--wb-text)" : "var(--wb-needs)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {d.name}
        </div>
        <div
          style={{ color: "var(--wb-textFaint)", fontSize: 10 }}
          title={[
            d.approved ? `stops working in ${formatCountdown(d.expiresAt)} unless used` : "",
            d.bound
              ? "Its browser holds a key that can't be copied out; the token alone opens nothing."
              : "Paired without a device key (over plain http, or before keys): its token alone gets in. Pair it again on the https address to bind one.",
          ]
            .filter(Boolean)
            .join("\n")}
        >
          {detail.filter(Boolean).join(" · ")}
        </div>
      </div>
      {d.approved ? (
        <button
          type="button"
          onClick={() => void revokeDevice(d.id)}
          title="revoke: it is disconnected and has to pair again"
          style={{ ...miniBtn, color: "var(--wb-needs)" }}
        >
          revoke
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void revokeDevice(d.id)}
            style={{ ...miniBtn, color: "var(--wb-needs)" }}
          >
            turn away
          </button>
          <button
            type="button"
            onClick={() => void approveDevice(d.id)}
            style={{ ...miniBtn, color: "var(--wb-accent)" }}
          >
            allow
          </button>
        </>
      )}
    </div>
  );
}

function toggleStyle(running: boolean, disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--wb-border)",
    color: disabled ? "var(--wb-textFaint)" : running ? "var(--wb-needs)" : "var(--wb-accent)",
    font: "10.5px var(--wb-mono)",
    cursor: disabled ? "default" : "pointer",
    padding: "2px 10px",
  };
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "10px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 8px",
};

const sectionLabelStyle: React.CSSProperties = {
  color: "var(--wb-textFaint)",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontSize: 9.5,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ ...sectionLabelStyle, padding: "2px 12px 4px" }}>{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
      }}
    >
      {children}
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      style={{
        color: tone === "error" ? "var(--wb-needs)" : "var(--wb-textFaint)",
        padding: "2px 12px 4px",
        fontSize: 10,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />;
}

export default RemoteAccessMenu;
