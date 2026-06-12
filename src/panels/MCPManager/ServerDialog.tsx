// Add / edit an MCP server (step 3.7 — design §7). Writes go through
// `claude mcp add` (the backend shells out); an edit is remove-then-add, so the
// dialog passes `replaces` to drop the prior row. The scope is locked while editing
// (a scope move would orphan the old entry) — change scope by removing + re-adding.
//
// `server === undefined` ⇒ add mode; otherwise the form is prefilled for edit.

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { GLYPH } from "../../theme";
import {
  mcpAdd,
  type KeyValue,
  type McpScope,
  type McpServer,
  type McpTransport,
} from "../../ipc/mcp";
import Modal from "../InstanceManager/Modal";

interface ServerDialogProps {
  projectRoot: string;
  /** Existing server to edit; omit for the add flow. */
  server?: McpServer;
  onClose: () => void;
  /** Called after a successful write so the panel can reload the list. */
  onSaved: () => void;
}

const SCOPES: { value: McpScope; label: string; hint: string }[] = [
  { value: "local", label: "local", hint: "private to you, this project (~/.claude.json)" },
  { value: "project", label: "project", hint: "shared via .mcp.json (git-committed)" },
  { value: "user", label: "user", hint: "global, all projects (~/.claude.json)" },
];

const TRANSPORTS: McpTransport[] = ["stdio", "http", "sse"];

function ServerDialog({ projectRoot, server, onClose, onSaved }: ServerDialogProps) {
  const editing = server !== undefined;

  const [scope, setScope] = useState<McpScope>(server?.scope ?? "local");
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState((server?.args ?? []).join("\n"));
  const [url, setUrl] = useState(server?.url ?? "");
  const [env, setEnv] = useState<KeyValue[]>(server?.env ?? []);
  const [headers, setHeaders] = useState<KeyValue[]>(server?.headers ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStdio = transport === "stdio";

  const canSave = useMemo(() => {
    if (busy || name.trim().length === 0) return false;
    return isStdio ? command.trim().length > 0 : url.trim().length > 0;
  }, [busy, name, isStdio, command, url]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const args = argsText
        .split(/\r?\n/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const clean = (kv: KeyValue[]) =>
        kv.map((p) => ({ key: p.key.trim(), value: p.value })).filter((p) => p.key.length > 0);
      await mcpAdd({
        projectRoot,
        scope,
        name: name.trim(),
        transport,
        command: isStdio ? command.trim() : null,
        args: isStdio ? args : [],
        url: isStdio ? null : url.trim(),
        env: isStdio ? clean(env) : [],
        headers: isStdio ? [] : clean(headers),
        // On a rename, drop the old name; otherwise overwrite in place.
        replaces: editing ? server?.name : null,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }, [
    argsText,
    projectRoot,
    scope,
    name,
    transport,
    isStdio,
    command,
    url,
    env,
    headers,
    editing,
    server,
    onSaved,
    onClose,
  ]);

  const scopeHint = SCOPES.find((s) => s.value === scope)?.hint ?? "";

  return (
    <Modal title={editing ? `edit ${server?.name}` : "add MCP server"} onClose={onClose} width={500}>
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <Field label="scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as McpScope)}
            disabled={editing}
            style={{ ...inputStyle, opacity: editing ? 0.6 : 1 }}
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span style={hintStyle}>{scopeHint}</span>
        </Field>

        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            spellCheck={false}
            autoFocus={!editing}
            style={inputStyle}
          />
        </Field>

        <Field label="transport">
          <div style={{ display: "flex", gap: 6 }}>
            {TRANSPORTS.map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                style={{
                  ...buttonStyle,
                  flex: 1,
                  borderColor: transport === t ? "var(--wb-borderActive)" : "var(--wb-border)",
                  color: transport === t ? "var(--wb-accent)" : "var(--wb-textDim2)",
                  background: transport === t ? "var(--wb-accentSoft)" : "var(--wb-titlebar)",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {isStdio ? (
          <>
            <Field label="command">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
            <Field label="args (one per line)">
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={"-y\nsome-mcp-package"}
                spellCheck={false}
                rows={3}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
            </Field>
            <KeyValueRows label="environment" pairs={env} onChange={setEnv} keyPlaceholder="API_KEY" />
          </>
        ) : (
          <>
            <Field label="url">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
            <KeyValueRows
              label="headers"
              pairs={headers}
              onChange={setHeaders}
              keyPlaceholder="Authorization"
            />
          </>
        )}

        {error && (
          <div style={{ color: "var(--wb-needs)", font: "11.5px var(--wb-mono)", whiteSpace: "pre-wrap" }}>
            {GLYPH.fail} {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={buttonStyle}>
            cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave}
            style={{
              ...buttonStyle,
              borderColor: "var(--wb-borderActive)",
              color: canSave ? "var(--wb-text)" : "var(--wb-textFaint)",
              opacity: canSave ? 1 : 0.6,
            }}
          >
            {busy ? "working…" : `${GLYPH.ok} ${editing ? "save" : "add"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** An editable list of key/value pairs (env vars or headers). */
function KeyValueRows({
  label,
  pairs,
  onChange,
  keyPlaceholder,
}: {
  label: string;
  pairs: KeyValue[];
  onChange: (next: KeyValue[]) => void;
  keyPlaceholder: string;
}) {
  const setAt = (i: number, patch: Partial<KeyValue>) =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const removeAt = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));
  const add = () => onChange([...pairs, { key: "", value: "" }]);

  return (
    <Field label={label}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pairs.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <input
              value={p.key}
              onChange={(e) => setAt(i, { key: e.target.value })}
              placeholder={keyPlaceholder}
              spellCheck={false}
              style={{ ...inputStyle, flex: "0 0 38%" }}
            />
            <input
              value={p.value}
              onChange={(e) => setAt(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={() => removeAt(i)} aria-label="remove" style={{ ...buttonStyle, padding: "0 9px" }}>
              {GLYPH.fail}
            </button>
          </div>
        ))}
        <button onClick={add} style={{ ...buttonStyle, alignSelf: "flex-start" }}>
          + add {label === "headers" ? "header" : "variable"}
        </button>
      </div>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          font: "600 10px var(--wb-mono)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--wb-textDim2)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 8px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
};

const buttonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

const hintStyle: CSSProperties = {
  font: "10px var(--wb-mono)",
  color: "var(--wb-textFaint)",
  marginTop: 3,
};

export default ServerDialog;
