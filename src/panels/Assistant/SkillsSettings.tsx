// The skills tab of Duck's settings (step S2): Duck's capabilities in one place.
// Its skills and modes, files in the workspace's `skills/` (each on or off, opened
// in the editor), the external MCP servers it may use (X1), and the stdio servers
// from your Claude Code config Duck hosts itself, your Firefox bridge first (B2).
//
// Skills are made by asking Duck ("make that a skill"), which shows the draft on a
// card, or by writing `skills/<name>/SKILL.md` by hand; either is read on Duck's
// next request.

import { useEffect, useState } from "react";

import type { DuckSettings } from "../../assistant/settings";
import { loadHosted, setDuckSettings, type DuckState } from "./duckState";
import { openDuckFile } from "./openCore";

function Skills({ duck, settings }: { duck: DuckState; settings: DuckSettings }) {
  const [error, setError] = useState<string | null>(null);
  const toggle = (name: string, on: boolean) => {
    const off = settings.disabledSkills.filter((n) => n !== name);
    setDuckSettings({ disabledSkills: on ? off : [...off, name] });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {duck.skills.length === 0 && (
        <div style={hint}>
          No skills yet. Ask Duck to make one ("make that a skill"), or write skills/&lt;name&gt;/SKILL.md in Duck's
          workspace.
        </div>
      )}
      {duck.skills.map((s) => (
        <div key={s.name} style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.45 }}>
          <input
            type="checkbox"
            checked={s.enabled}
            aria-label={`use ${s.name}`}
            onChange={(e) => toggle(s.name, e.target.checked)}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              {s.name}
              {s.mode && <span style={hint}> (the mode "{s.mode}")</span>}
              {s.tools && <span style={hint}> (only {s.tools.join(", ")})</span>}
            </div>
            {s.description && <div style={hint}>{s.description}</div>}
            {s.problems.length > 0 && (
              <div style={{ color: "var(--wb-needs)" }}>Not used: {s.problems.join("; ")}.</div>
            )}
          </div>
          <button
            type="button"
            style={btn}
            onClick={() => {
              setError(null);
              openDuckFile(settings.workspace, s.path).catch((e: unknown) => setError(String(e)));
            }}
          >
            edit
          </button>
        </div>
      ))}
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
    </div>
  );
}

/** External MCP servers Duck may use (X1): each on or off, and its address. A
 *  server's token, if it needs one, is an environment variable named in the
 *  prefs (`tokenEnv`), never typed here. */
function McpServers({ settings }: { settings: DuckSettings }) {
  const servers = settings.mcpServers;
  const [urls, setUrls] = useState(() => servers.map((s) => s.url));
  useEffect(() => setUrls(servers.map((s) => s.url)), [servers]);
  const patch = (i: number, p: Partial<DuckSettings["mcpServers"][number]>) =>
    setDuckSettings({ mcpServers: servers.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <>
      {servers.map((s, i) => (
        <label key={s.name} style={{ ...row, alignItems: "center" }}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} />
          <span>Use {s.name}</span>
          <input
            value={urls[i] ?? s.url}
            onChange={(e) => setUrls(urls.map((u, j) => (j === i ? e.target.value : u)))}
            onBlur={() => {
              const url = (urls[i] ?? "").trim();
              if (url && url !== s.url) patch(i, { url });
              else setUrls(servers.map((x) => x.url));
            }}
            style={{ ...select, flex: 1, minWidth: 0 }}
          />
          <span style={hint}>(MCP; its app must be open)</span>
        </label>
      ))}
    </>
  );
}

/** The stdio servers in your Claude Code config (B2), each opted in for Duck: its
 *  tools become Duck's (`<server>__*`), the server starting on first use and
 *  stopping after 10 minutes idle. */
function HostedServers({ duck, settings }: { duck: DuckState; settings: DuckSettings }) {
  useEffect(() => loadHosted(), []);
  const servers = duck.hosted;
  const toggle = (name: string, on: boolean) => {
    const rest = settings.mcpHost.filter((n) => n !== name);
    setDuckSettings({ mcpHost: on ? [...rest, name] : rest });
  };
  if (!servers) return <div style={hint}>loading…</div>;
  if (servers.length === 0)
    return <div style={hint}>No stdio servers in your Claude Code config (the MCP panel adds them).</div>;
  return (
    <>
      {servers.map((s) => (
        <div key={s.name} style={{ ...row, alignItems: "center", cursor: "default" }}>
          <input
            type="checkbox"
            checked={s.on}
            aria-label={`let Duck use ${s.name}`}
            onChange={(e) => toggle(s.name, e.target.checked)}
          />
          <span>
            {s.name}
            {s.command && <span style={hint}> ({s.command})</span>}
          </span>
          {s.on && (
            <span style={s.error ? { color: "var(--wb-needs)" } : hint}>
              {s.error ?? (s.tools === null ? "listing…" : `${s.tools} tools${s.running ? " · running" : ""}`)}
            </span>
          )}
          {s.on && (
            <button type="button" style={btn} onClick={() => loadHosted(s.name)} title="Ask the server for its tools again (it starts)">
              refresh
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** Duck in your Firefox (B2): which browser is the agent and which is yours, and
 *  the sites your personal profile may be used for without asking. */
function FirefoxSettingsRow({ settings }: { settings: DuckSettings }) {
  const fx = settings.firefox;
  const [draft, setDraft] = useState(fx);
  const [sites, setSites] = useState(fx.personalSites.join(", "));
  useEffect(() => {
    setDraft(fx);
    setSites(fx.personalSites.join(", "));
  }, [fx]);
  const save = (p: Partial<DuckSettings["firefox"]>) => setDuckSettings({ firefox: { ...fx, ...p } });
  const field = (key: "agentProfile" | "agentBrowser" | "personalBrowser", label: string, placeholder: string) => (
    <label style={{ ...row, alignItems: "center" }}>
      <span style={{ minWidth: 150 }}>{label}</span>
      <input
        value={draft[key]}
        placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => draft[key].trim() !== fx[key] && save({ [key]: draft[key].trim() })}
        style={{ ...select, flex: 1, minWidth: 0 }}
      />
    </label>
  );
  if (!settings.mcpHost.includes(fx.server))
    return <div style={hint}>Turn on "{fx.server}" above for Duck to act in your Firefox.</div>;
  return (
    <>
      {field("agentProfile", "agent profile", "claude-agent")}
      {field("agentBrowser", "agent in the bridge", "the one connected browser")}
      {field("personalBrowser", "your own profile", "not set up")}
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ minWidth: 150 }}>yours, without asking</span>
        <input
          value={sites}
          placeholder="sites, comma-separated"
          onChange={(e) => setSites(e.target.value)}
          onBlur={() => {
            const list = sites.split(/[\s,]+/).filter(Boolean);
            if (list.join(",") !== fx.personalSites.join(",")) save({ personalSites: list });
          }}
          style={{ ...select, flex: 1, minWidth: 0 }}
        />
      </label>
      <div style={hint}>
        Duck works in the agent profile and opens it when it's closed. The names are as the bridge's browsers_list shows
        them (the add-on's options page). Your own profile needs the add-on too; using it asks, except for the sites
        listed.
      </div>
    </>
  );
}

export default function SkillsSettings({ duck, settings }: { duck: DuckState; settings: DuckSettings }) {
  return (
    <>
      <div style={heading}>Skills and modes</div>
      <Skills duck={duck} settings={settings} />
      <div style={heading}>MCP servers</div>
      <McpServers settings={settings} />
      <div style={heading}>From your Claude Code config</div>
      <HostedServers duck={duck} settings={settings} />
      <div style={heading}>Firefox</div>
      <FirefoxSettingsRow settings={settings} />
    </>
  );
}

const heading: React.CSSProperties = { color: "var(--wb-textDim2)", marginTop: 4 };

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };

const select: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
};

const btn: React.CSSProperties = { ...select, cursor: "pointer", padding: "0 6px", flex: "0 0 auto" };

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  cursor: "pointer",
  lineHeight: 1.45,
};
