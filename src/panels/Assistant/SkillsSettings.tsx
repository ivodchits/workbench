// The skills tab of Duck's settings (step S2): Duck's capabilities in one place.
// Its skills and modes, files in the workspace's `skills/` (each on or off, opened
// in the editor), and the external MCP servers it may use (X1).
//
// Skills are made by asking Duck ("make that a skill"), which shows the draft on a
// card, or by writing `skills/<name>/SKILL.md` by hand; either is read on Duck's
// next request.

import { useEffect, useState } from "react";

import type { DuckSettings } from "../../assistant/settings";
import { setDuckSettings, type DuckState } from "./duckState";
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

export default function SkillsSettings({ duck, settings }: { duck: DuckState; settings: DuckSettings }) {
  return (
    <>
      <div style={heading}>Skills and modes</div>
      <Skills duck={duck} settings={settings} />
      <div style={heading}>MCP servers</div>
      <McpServers settings={settings} />
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
