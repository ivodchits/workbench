// The morning routine's settings (phase 2): Google access and the monthly invoice.
// Google: the Desktop OAuth client id from the user's own Google Cloud project, and
// connecting it in the browser (drive.readonly + drive.file; the tokens stay in
// Credential Manager). The invoice: the sheet, its tab, the quest_log tag that marks
// the entry, the draft folder, and the cells a draft changes with each one's rule.
// The invoice form is saved with its button, since a half-typed cell would
// otherwise be dropped by the settings' check; "test sheet" reads the saved cells
// so a wrong address shows up now rather than on the morning it's due, and says what
// a draft made today would set (amounts Duck asks for count as 0 here).

import { useEffect, useState } from "react";
import {
  googleConnect,
  googleDisconnect,
  googleStatus,
  sheetCells,
  type GoogleStatus,
  type SheetCells,
} from "../../ipc/assistant";
import {
  AMOUNT_SOURCES,
  cleanInvoice,
  DATE_RULES,
  INVOICE_DEFAULTS,
  MAX_INVOICE_FIELDS,
  type DuckSettings,
  type InvoiceSettings,
} from "../../assistant/settings";
import { googleErrorText } from "../../assistant/google";
import { askedFields, cellsToRead, changeLine, planDraft } from "../../assistant/invoice";
import { setDuckSettings } from "./duckState";

const RULE_LABELS: Record<string, string> = {
  today: "today",
  first_of_month: "1st of this month",
  last_of_month: "last day of this month",
  first_of_prev_month: "1st of last month",
  last_of_prev_month: "last day of last month",
  fixed: "a fixed amount",
  same_as_last: "same as now",
  cells: "from other cells",
  ask: "ask me",
};

/** A cell row as typed, before the settings' check. */
interface Row {
  label: string;
  address: string;
  kind: "date" | "amount";
  rule: string;
  value: string;
  formula: string;
}

interface Form {
  sheet: string;
  tab: string;
  entryTag: string;
  draftFolder: string;
  rows: Row[];
}

function formOf(inv: InvoiceSettings | null): Form {
  return {
    sheet: inv?.sheetId ?? "",
    tab: inv?.tab ?? "",
    entryTag: inv?.entryTag ?? INVOICE_DEFAULTS.entryTag,
    draftFolder: inv?.draftFolder ?? INVOICE_DEFAULTS.draftFolder,
    rows: (inv?.fields ?? []).map((f) => ({
      label: f.label,
      address: f.address,
      kind: f.kind,
      rule: f.rule,
      value: f.kind === "amount" && f.value !== undefined ? String(f.value) : "",
      formula: f.kind === "amount" ? (f.formula ?? "") : "",
    })),
  };
}

function invoiceOf(f: Form): Record<string, unknown> {
  return {
    sheetId: f.sheet,
    tab: f.tab,
    entryTag: f.entryTag,
    draftFolder: f.draftFolder,
    fields: f.rows.map((r) => ({
      label: r.label,
      address: r.address,
      kind: r.kind,
      rule: r.rule,
      ...(r.rule === "fixed" && { value: Number(r.value.replace(/[^0-9.-]/g, "")) }),
      ...(r.rule === "cells" && { formula: r.formula }),
    })),
  };
}

const blankRow = (kind: Row["kind"]): Row => ({
  label: "",
  address: "",
  kind,
  rule: kind === "date" ? "today" : "same_as_last",
  value: "",
  formula: "",
});

export default function MorningSettings({ settings }: { settings: DuckSettings }) {
  const morning = settings.morning;
  const [clientId, setClientId] = useState(morning.googleClientId ?? "");
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState(() => formOf(morning.invoice));
  const [saved, setSaved] = useState<string | null>(null);
  const [test, setTest] = useState<SheetCells | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setClientId(morning.googleClientId ?? ""), [morning.googleClientId]);
  useEffect(() => setForm(formOf(morning.invoice)), [morning.invoice]);
  useEffect(() => {
    void googleStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const saveClientId = () => {
    const id = clientId.trim();
    if (id !== (morning.googleClientId ?? "")) setDuckSettings({ morning: { ...morning, googleClientId: id || null } });
  };

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      setStatus(await googleConnect(clientId.trim()));
    } catch (e) {
      setError(googleErrorText(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      setStatus(await googleDisconnect());
    } catch (e) {
      setError(String(e));
    }
  };

  const save = () => {
    setTest(null);
    const raw = invoiceOf(form);
    const clean = cleanInvoice(raw);
    if (!clean) {
      setSaved("Not saved: it needs the sheet (its id or link) and the tab's name.");
      return;
    }
    const dropped = form.rows.length - clean.fields.length;
    setDuckSettings({ morning: { ...morning, invoice: clean } });
    setSaved(dropped ? `Saved; ${dropped} cell${dropped > 1 ? "s were" : " was"} left out (check the address and rule).` : "Saved.");
  };

  const runTest = async () => {
    const inv = morning.invoice;
    if (!inv || !morning.googleClientId) return;
    setError(null);
    setTest(null);
    setTesting(true);
    try {
      setTest(await sheetCells(morning.googleClientId, inv.sheetId, inv.tab, cellsToRead(inv)));
    } catch (e) {
      setError(googleErrorText(e));
      setStatus(await googleStatus().catch(() => status));
    } finally {
      setTesting(false);
    }
  };

  const patchRow = (i: number, p: Partial<Row>) =>
    setForm({ ...form, rows: form.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });

  return (
    <>
      <div style={heading}>Google</div>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>OAuth client id</span>
        <input
          value={clientId}
          placeholder="…apps.googleusercontent.com"
          onChange={(e) => setClientId(e.target.value)}
          onBlur={saveClientId}
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
      </label>
      <div style={{ ...row, alignItems: "center" }}>
        {status?.connected ? (
          <>
            <span>Connected</span>
            <button type="button" onClick={() => void disconnect()} style={button}>
              disconnect
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={connecting || !morning.googleClientId}
              style={button}
            >
              {connecting ? "waiting for the browser…" : "connect Google"}
            </button>
            <span style={hint}>(read your Drive; change only files Duck makes)</span>
          </>
        )}
      </div>
      {status && !status.secretStored && (
        <div style={hint}>
          If the client has a secret, store it first in your own terminal:{" "}
          <code>cmdkey /generic:{status.secretTarget} /user:duck /pass:&lt;secret&gt;</code>
        </div>
      )}

      <div style={heading}>Monthly invoice</div>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={label}>Sheet</span>
        <input
          value={form.sheet}
          placeholder="its link or id"
          onChange={(e) => setForm({ ...form, sheet: e.target.value })}
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={label}>Tab</span>
        <input value={form.tab} onChange={(e) => setForm({ ...form, tab: e.target.value })} style={{ ...input, flex: 1, minWidth: 0 }} />
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={label}>quest_log tag</span>
        <input
          value={form.entryTag}
          onChange={(e) => setForm({ ...form, entryTag: e.target.value })}
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={label}>Drafts folder</span>
        <input
          value={form.draftFolder}
          onChange={(e) => setForm({ ...form, draftFolder: e.target.value })}
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
      </label>
      {form.rows.map((r, i) => (
        <div key={i} style={{ ...row, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={r.label}
            placeholder="label"
            onChange={(e) => patchRow(i, { label: e.target.value })}
            style={{ ...input, width: 90 }}
          />
          <input
            value={r.address}
            placeholder="B2"
            onChange={(e) => patchRow(i, { address: e.target.value })}
            style={{ ...input, width: 44 }}
          />
          <select
            value={r.kind}
            onChange={(e) => {
              const kind = e.target.value as Row["kind"];
              patchRow(i, { kind, rule: blankRow(kind).rule });
            }}
            style={input}
          >
            <option value="date">date</option>
            <option value="amount">amount</option>
          </select>
          <select value={r.rule} onChange={(e) => patchRow(i, { rule: e.target.value })} style={input}>
            {(r.kind === "date" ? DATE_RULES : AMOUNT_SOURCES).map((x) => (
              <option key={x} value={x}>
                {RULE_LABELS[x]}
              </option>
            ))}
          </select>
          {r.rule === "fixed" && (
            <input
              value={r.value}
              placeholder="1200"
              onChange={(e) => patchRow(i, { value: e.target.value })}
              style={{ ...input, width: 64 }}
            />
          )}
          {r.rule === "cells" && (
            <input
              value={r.formula}
              placeholder="C5*C6"
              onChange={(e) => patchRow(i, { formula: e.target.value })}
              style={{ ...input, width: 80 }}
            />
          )}
          <button
            type="button"
            title="remove this cell"
            onClick={() => setForm({ ...form, rows: form.rows.filter((_, j) => j !== i) })}
            style={button}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ ...row, alignItems: "center", flexWrap: "wrap" }}>
        {form.rows.length < MAX_INVOICE_FIELDS && (
          <>
            <button type="button" onClick={() => setForm({ ...form, rows: [...form.rows, blankRow("date")] })} style={button}>
              + date cell
            </button>
            <button type="button" onClick={() => setForm({ ...form, rows: [...form.rows, blankRow("amount")] })} style={button}>
              + amount cell
            </button>
          </>
        )}
        <button type="button" onClick={save} style={button}>
          save
        </button>
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={testing || !morning.invoice || !status?.connected}
          title={!status?.connected ? "connect Google first" : "read the saved cells from the sheet"}
          style={button}
        >
          {testing ? "reading…" : "test sheet"}
        </button>
        {saved && <span style={hint}>{saved}</span>}
      </div>
      {test && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={hint}>{test.name}, as it is now:</span>
          {test.cells.map((c) => {
            const f = morning.invoice?.fields.find((x) => x.address === c.address);
            if (!f) return null;
            return (
              <span key={c.address}>
                {f.label} <span style={hint}>{c.address}</span> {c.value || <span style={hint}>(empty)</span>}
                {c.formula && <span style={{ color: "var(--wb-needs)" }}> formula {c.formula}: a draft won't change it</span>}
              </span>
            );
          })}
          {morning.invoice && <span style={hint}>{draftPreview(morning.invoice, test)}</span>}
        </div>
      )}
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
    </>
  );
}

/** What a draft made today would set, in a line. */
function draftPreview(inv: InvoiceSettings, sheet: SheetCells): string {
  const answers = Object.fromEntries(askedFields(inv).map((f) => [f.label, 0]));
  try {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const plan = planDraft(inv, sheet.name, sheet.cells, today, answers);
    return plan.changes.length
      ? `A draft made today would set: ${plan.changes.map(changeLine).join("; ")}.`
      : "A draft made today would change nothing.";
  } catch (e) {
    return `A draft can't be planned: ${e instanceof Error ? e.message : String(e)}.`;
  }
}

const input: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
  padding: "1px 4px",
};

const button: React.CSSProperties = { ...input, cursor: "pointer", padding: "1px 8px" };

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  lineHeight: 1.45,
};

const label: React.CSSProperties = { width: 86, flex: "0 0 auto" };

const heading: React.CSSProperties = { color: "var(--wb-textDim2)", marginTop: 4 };

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };
