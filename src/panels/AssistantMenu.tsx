// Assistant menu (step A1): the status-bar control for Duck's API access. Shows this
// month's API spend against the cap; the popover holds the key (stored in Windows
// Credential Manager, never shown), a one-token test call through the proxy, the
// spend by model and purpose, and the budget limits.
// Mirrors the AppearanceMenu's upward popover so it sits naturally in the status bar.
//
// Entering the key here works, but the recommended way is `cmdkey` in your own
// terminal, so the key never passes through the app at all.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearKey,
  getKeyStatus,
  getSpend,
  onUsage,
  setBudget,
  setKey,
  testCall,
  type Bucket,
  type KeyStatus,
  type Spend,
} from "../ipc/assistant";

const usd = (n: number) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

function AssistantMenu() {
  const [open, setOpen] = useState(false);
  const [key, setKeyStatus] = useState<KeyStatus | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([getKeyStatus(), getSpend()]);
      setKeyStatus(k);
      setSpend(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Keep the trigger's figure current: every metered call reports in.
  useEffect(() => {
    void refresh();
    const off = onUsage(() => void refresh());
    return () => void off.then((f) => f());
  }, [refresh]);

  // Refresh on open too: a key stored with `cmdkey` announces nothing.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

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

  const tone = !key?.present
    ? "var(--wb-textFaint)"
    : spend?.capReached
      ? "var(--wb-needs)"
      : spend?.softReached
        ? "var(--wb-working)"
        : "var(--wb-accent)";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Duck's API key, spend and budget"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color: tone,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span>◆</span>
        duck{" "}
        {!key
          ? ""
          : !key.present
            ? "· no key"
            : spend
              ? `${usd(spend.monthUsd)} / ${usd(spend.limits.hardCapUsd)}`
              : ""}
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
          {key && <KeySection status={key} onChange={setKeyStatus} />}
          {spend && (
            <>
              <Divider />
              <SpendSection spend={spend} />
              <Divider />
              <BudgetSection spend={spend} onSaved={() => void refresh()} />
            </>
          )}
          {error && <Note tone="error">{error}</Note>}
        </div>
      )}
    </div>
  );
}

function KeySection({
  status,
  onChange,
}: {
  status: KeyStatus;
  onChange: (s: KeyStatus) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone?: "error"; text: string } | null>(
    null,
  );
  const cmd = `cmdkey /generic:${status.target} /user:duck /pass:<key>`;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setResult(null);
    try {
      await action();
    } catch (e) {
      setResult({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionLabel>duck · api key</SectionLabel>
      <Row>
        <span
          style={{
            color: status.present ? "var(--wb-text)" : "var(--wb-needs)",
            flex: 1,
          }}
        >
          {status.present ? "stored" : "not stored"}
          <span style={{ color: "var(--wb-textFaint)" }}>
            {" "}
            · {status.target}
          </span>
        </span>
        {status.present && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => onChange(await clearKey()))}
            title="remove the key from Credential Manager"
            style={{ ...miniBtn, color: "var(--wb-needs)" }}
          >
            remove
          </button>
        )}
      </Row>
      <Note>
        Store it from your own terminal, so it never passes through the app:
      </Note>
      <Row>
        <code
          style={{
            flex: 1,
            color: "var(--wb-text)",
            fontSize: 10,
            wordBreak: "break-all",
            userSelect: "all",
          }}
        >
          {cmd}
        </code>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(cmd)}
          title="copy"
          style={miniBtn}
        >
          copy
        </button>
      </Row>
      <Row>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="or paste it here"
          autoComplete="off"
          spellCheck={false}
          style={inputStyle}
        />
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() =>
            void run(async () => {
              const s = await setKey(draft);
              setDraft("");
              onChange(s);
            })
          }
          style={miniBtn}
        >
          save
        </button>
      </Row>
      <Row>
        <button
          type="button"
          disabled={busy || !status.present}
          onClick={() =>
            void run(async () => {
              const r = await testCall();
              setResult(
                r.ok
                  ? { text: "the API answered; the call is in the ledger" }
                  : { tone: "error", text: r.error },
              );
            })
          }
          title="a one-token Haiku call through the proxy"
          style={miniBtn}
        >
          {busy ? "…" : "test"}
        </button>
        {result && (
          <span
            style={{
              flex: 1,
              color: result.tone ? "var(--wb-needs)" : "var(--wb-textDim2)",
              fontSize: 10,
            }}
          >
            {result.text}
          </span>
        )}
      </Row>
    </>
  );
}

function SpendSection({ spend }: { spend: Spend }) {
  const soft = spend.limits.hardCapUsd * spend.limits.softRatio;
  return (
    <>
      <SectionLabel>spend · this month</SectionLabel>
      <Row>
        <span style={{ color: "var(--wb-text)", flex: 1 }}>
          {usd(spend.monthUsd)}{" "}
          <span style={{ color: "var(--wb-textFaint)" }}>
            of {usd(spend.limits.hardCapUsd)}
          </span>
        </span>
        <span style={{ color: "var(--wb-textFaint)" }}>
          today {usd(spend.todayUsd)}
        </span>
      </Row>
      {spend.capReached ? (
        <Note tone="error">
          At the cap: only Haiku background jobs run until next month.
        </Note>
      ) : spend.softReached ? (
        <Note tone="error">Past the soft limit ({usd(soft)}).</Note>
      ) : null}
      <Buckets title="by model" rows={spend.byModel} />
      <Buckets title="by purpose" rows={spend.byPurpose} />
    </>
  );
}

function Buckets({ title, rows }: { title: string; rows: Bucket[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ padding: "2px 12px" }}>
      <div style={{ color: "var(--wb-textFaint)", fontSize: 10 }}>{title}</div>
      {rows.map((b) => (
        <div
          key={b.key}
          style={{
            display: "flex",
            gap: 8,
            color: "var(--wb-textDim2)",
            lineHeight: 1.6,
          }}
        >
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {b.key}
          </span>
          <span style={{ color: "var(--wb-textFaint)" }}>{b.calls}×</span>
          <span>{usd(b.costUsd)}</span>
        </div>
      ))}
    </div>
  );
}

function BudgetSection({
  spend,
  onSaved,
}: {
  spend: Spend;
  onSaved: () => void;
}) {
  const [cap, setCap] = useState(String(spend.limits.hardCapUsd));
  const [softPct, setSoftPct] = useState(
    String(Math.round(spend.limits.softRatio * 100)),
  );
  const [error, setError] = useState<string | null>(null);
  const changed =
    Number(cap) !== spend.limits.hardCapUsd ||
    Number(softPct) !== Math.round(spend.limits.softRatio * 100);

  async function save() {
    setError(null);
    try {
      await setBudget({
        hardCapUsd: Number(cap),
        softRatio: Number(softPct) / 100,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <SectionLabel>budget</SectionLabel>
      <Row>
        <span style={{ color: "var(--wb-textFaint)" }}>cap $</span>
        <input
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          inputMode="decimal"
          style={{ ...inputStyle, width: 56, flex: "none" }}
        />
        <span style={{ color: "var(--wb-textFaint)" }}>soft</span>
        <input
          value={softPct}
          onChange={(e) => setSoftPct(e.target.value)}
          inputMode="numeric"
          style={{ ...inputStyle, width: 36, flex: "none" }}
        />
        <span style={{ color: "var(--wb-textFaint)", flex: 1 }}>%</span>
        <button
          type="button"
          disabled={!changed}
          onClick={() => void save()}
          style={miniBtn}
        >
          save
        </button>
      </Row>
      {error && <Note tone="error">{error}</Note>}
    </>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "10px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 8px",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--wb-bg)",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "10.5px var(--wb-mono)",
  padding: "2px 6px",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "var(--wb-textFaint)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontSize: 9.5,
        padding: "2px 12px 4px",
      }}
    >
      {children}
    </div>
  );
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

function Note({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
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
  return (
    <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />
  );
}

export default AssistantMenu;
