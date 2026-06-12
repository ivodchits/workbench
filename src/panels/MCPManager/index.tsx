// MCP Server Manager panel (step 3.7 — design §7). Bound to a project via the mcp
// store; the binding (repo root) is all the state, so the panel re-fetches the
// server list from the backend on mount / refresh / after each edit rather than
// caching it.
//
// Layout: servers grouped by scope in precedence order (local > project > user),
// each row showing transport + command/url and a "shadowed" marker when a
// higher-precedence scope overrides it. Writes go through `claude mcp` (add/edit
// via the form, remove via a confirm); the project-scope `.mcp.json` also gets a
// raw-JSON editor. Two documented gotchas are surfaced as a footnote.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { GLYPH } from "../../theme";
import { mcpList, mcpRemove, type McpScope, type McpServer } from "../../ipc/mcp";
import { useMcps, type McpSession } from "../../state/mcp";
import Modal from "../InstanceManager/Modal";
import ServerDialog from "./ServerDialog";
import RawJsonDialog from "./RawJsonDialog";

export interface McpPanelParams {
  mcpId: string;
}

const SCOPE_ORDER: McpScope[] = ["local", "project", "user"];

const SCOPE_BLURB: Record<McpScope, string> = {
  local: "private to you, this project · ~/.claude.json",
  project: "shared via .mcp.json (git-committed)",
  user: "global, every project · ~/.claude.json",
};

export function McpManagerPanel(props: IDockviewPanelProps<McpPanelParams>) {
  const { mcpId } = props.params;
  const { open } = useMcps();
  const session = open.find((m) => m.mcpId === mcpId) ?? null;

  const title = session ? `mcp · ${session.title}` : "mcp servers";
  const setTitle = props.api.setTitle.bind(props.api);
  useEffect(() => setTitle(title), [setTitle, title]);

  if (!session) return <Missing />;
  return <McpBody session={session} />;
}

type Dialog =
  | { kind: "add" }
  | { kind: "edit"; server: McpServer }
  | { kind: "raw" }
  | { kind: "remove"; server: McpServer };

function McpBody({ session }: { session: McpSession }) {
  const { repoRoot } = session;
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServers(await mcpList(repoRoot));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
      setServers(null);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const byScope = useMemo(() => {
    const map = new Map<McpScope, McpServer[]>();
    for (const s of servers ?? []) {
      const arr = map.get(s.scope) ?? [];
      arr.push(s);
      map.set(s.scope, arr);
    }
    return map;
  }, [servers]);

  const total = servers?.length ?? 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--wb-bg)" }}>
      <Header
        total={total}
        loading={loading}
        onAdd={() => setDialog({ kind: "add" })}
        onRaw={() => setDialog({ kind: "raw" })}
        onRefresh={() => void load()}
      />

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {loadError ? (
          <div style={{ padding: "12px 14px", color: "var(--wb-needs)", font: "11.5px var(--wb-mono)" }}>
            {GLYPH.warn} {loadError}
          </div>
        ) : servers && total === 0 ? (
          <Empty />
        ) : (
          SCOPE_ORDER.map((scope) => {
            const list = byScope.get(scope);
            if (!list || list.length === 0) return null;
            return (
              <ScopeSection
                key={scope}
                scope={scope}
                servers={list}
                onEdit={(server) => setDialog({ kind: "edit", server })}
                onRemove={(server) => setDialog({ kind: "remove", server })}
              />
            );
          })
        )}

        {servers && total > 0 && <Gotchas />}
      </div>

      {dialog?.kind === "add" && (
        <ServerDialog projectRoot={repoRoot} onClose={() => setDialog(null)} onSaved={() => void load()} />
      )}
      {dialog?.kind === "edit" && (
        <ServerDialog
          projectRoot={repoRoot}
          server={dialog.server}
          onClose={() => setDialog(null)}
          onSaved={() => void load()}
        />
      )}
      {dialog?.kind === "raw" && (
        <RawJsonDialog projectRoot={repoRoot} onClose={() => setDialog(null)} onSaved={() => void load()} />
      )}
      {dialog?.kind === "remove" && (
        <RemoveConfirm
          projectRoot={repoRoot}
          server={dialog.server}
          onClose={() => setDialog(null)}
          onRemoved={() => void load()}
        />
      )}
    </div>
  );
}

function Header({
  total,
  loading,
  onAdd,
  onRaw,
  onRefresh,
}: {
  total: number;
  loading: boolean;
  onAdd: () => void;
  onRaw: () => void;
  onRefresh: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
      }}
    >
      <span style={{ color: "var(--wb-text)" }}>
        {loading && total === 0 ? "reading…" : `${total} server${total === 1 ? "" : "s"}`}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <HeaderButton onClick={onAdd} accent>
          + add server
        </HeaderButton>
        <HeaderButton onClick={onRaw}>edit .mcp.json</HeaderButton>
        <HeaderButton onClick={onRefresh} disabled={loading}>
          ↻ refresh
        </HeaderButton>
      </span>
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  accent,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--wb-textFaint)" : accent ? "var(--wb-accent)" : "var(--wb-textDim2)",
        font: "11px var(--wb-mono)",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function ScopeSection({
  scope,
  servers,
  onEdit,
  onRemove,
}: {
  scope: McpScope;
  servers: McpServer[];
  onEdit: (server: McpServer) => void;
  onRemove: (server: McpServer) => void;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "8px 14px 4px",
        }}
      >
        <span
          style={{
            font: "600 10.5px var(--wb-mono)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--wb-accent)",
          }}
        >
          {scope}
        </span>
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
          {SCOPE_BLURB[scope]}
        </span>
      </div>
      {servers.map((s) => (
        <ServerRow key={`${s.scope}:${s.name}`} server={s} onEdit={() => onEdit(s)} onRemove={() => onRemove(s)} />
      ))}
    </div>
  );
}

function ServerRow({
  server,
  onEdit,
  onRemove,
}: {
  server: McpServer;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  const detail = server.transport === "stdio"
    ? [server.command, ...server.args].filter(Boolean).join(" ")
    : server.url ?? "";
  const extras =
    server.transport === "stdio"
      ? server.env.length > 0
        ? `${server.env.length} env`
        : ""
      : server.headers.length > 0
        ? `${server.headers.length} header${server.headers.length === 1 ? "" : "s"}`
        : "";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "5px 14px",
        opacity: server.shadowed ? 0.55 : 1,
      }}
    >
      <span
        title={server.transport}
        style={{
          flex: "0 0 auto",
          font: "9.5px var(--wb-mono)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--wb-textDim2)",
          border: "1px solid var(--wb-border)",
          borderRadius: 3,
          padding: "1px 5px",
          width: 38,
          textAlign: "center",
        }}
      >
        {server.transport}
      </span>
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span
            style={{
              font: "12.5px var(--wb-mono)",
              color: "var(--wb-text)",
              textDecoration: server.shadowed ? "line-through" : "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {server.name}
          </span>
          {server.shadowed && (
            <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-working)", flex: "0 0 auto" }}>
              overridden
            </span>
          )}
          {extras && (
            <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)", flex: "0 0 auto" }}>
              {extras}
            </span>
          )}
        </span>
        <span
          style={{
            font: "10.5px var(--wb-mono)",
            color: "var(--wb-textFaint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={detail}
        >
          {detail || "—"}
        </span>
      </span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 9, visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={onEdit} label="edit server">
          ✎
        </RowAction>
        <RowAction onClick={onRemove} label="remove server" danger>
          {GLYPH.fail}
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({
  children,
  onClick,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0,
        lineHeight: 1,
        font: "11.5px var(--wb-mono)",
        color: danger ? "var(--wb-needs)" : "var(--wb-accent)",
      }}
    >
      {children}
    </button>
  );
}

function RemoveConfirm({
  projectRoot,
  server,
  onClose,
  onRemoved,
}: {
  projectRoot: string;
  server: McpServer;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await mcpRemove(projectRoot, server.scope, server.name);
      onRemoved();
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  return (
    <Modal title="remove MCP server" onClose={onClose} width={400}>
      <div style={{ fontSize: 12.5, color: "var(--wb-text)", lineHeight: 1.5 }}>
        Remove <strong style={{ color: "var(--wb-accent)" }}>{server.name}</strong> from the{" "}
        <strong style={{ color: "var(--wb-accent)" }}>{server.scope}</strong> scope?
        {error && (
          <div style={{ marginTop: 8, color: "var(--wb-needs)", font: "11.5px var(--wb-mono)", whiteSpace: "pre-wrap" }}>
            {GLYPH.fail} {error}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={confirmButtonStyle}>
          cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy}
          style={{ ...confirmButtonStyle, borderColor: "var(--wb-needs)", color: "var(--wb-needs)" }}
        >
          {GLYPH.fail} remove
        </button>
      </div>
    </Modal>
  );
}

/** The two documented MCP gotchas (design §7 / plan step 3.7). */
function Gotchas() {
  return (
    <div
      style={{
        margin: "10px 14px 16px",
        padding: "9px 11px",
        border: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        font: "10px/1.55 var(--wb-mono)",
        color: "var(--wb-textFaint)",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <span>
        {GLYPH.warn} <strong style={{ color: "var(--wb-textDim2)" }}>project</strong> servers need a
        one-time trust prompt in a console before first use.
      </span>
      <span>
        {GLYPH.warn} MCP <strong style={{ color: "var(--wb-textDim2)" }}>local</strong> scope lives in{" "}
        <code>~/.claude.json</code> — not <code>.claude/settings.local.json</code>.
      </span>
    </div>
  );
}

function Empty() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "13px var(--wb-mono)" }}>no MCP servers</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)", maxWidth: 360, textAlign: "center" }}>
        add one with “+ add server”, or edit the project’s <code>.mcp.json</code> directly
      </div>
    </div>
  );
}

function Missing() {
  return (
    <div style={centered}>
      <div style={{ color: "var(--wb-textDim2)", font: "12px var(--wb-mono)" }}>{GLYPH.warn} this panel is gone</div>
      <div style={{ color: "var(--wb-textFaint)", font: "11px var(--wb-mono)" }}>close it</div>
    </div>
  );
}

const centered: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  background: "var(--wb-bg)",
};

const confirmButtonStyle: React.CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

export default McpManagerPanel;
