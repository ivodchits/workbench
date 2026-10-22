// The routines tab of Duck's settings (step L4): what Duck does on a schedule
// (yours and the built-in ones), where its data is backed up, with a button to set
// the backup up, and how long an idle thread is kept.
//
// Setting up the backup creates a private GitHub repo with `gh`: the button asks
// once more before it does. Routines are made by asking Duck ("every weekday at
// 8:30, my morning briefing"); here they're paused, resumed, run now or deleted.

import { useState } from "react";

import { DELETE_IDLE_CHOICES, type DuckSettings } from "../../assistant/settings";
import { createBackup, setDuckSettings, setRoutine, type DuckState } from "./duckState";

const when = (ms: number) =>
  new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Backup({ duck }: { duck: DuckState }) {
  const [name, setName] = useState("duck-data");
  const [asking, setAsking] = useState(false);
  const b = duck.backup;
  if (!b) return <div style={hint}>Backup: checking…</div>;
  if (b.remote)
    return (
      <div style={{ lineHeight: 1.45 }}>
        <div>
          Backed up to <span style={{ color: "var(--wb-textDim2)" }}>{b.remote}</span>
          <span style={hint}>
            {" "}
            ({b.ahead === null ? "not pushed yet" : b.ahead ? `${b.ahead} commits to push` : "up to date"})
          </span>
        </div>
        {b.failing && <div style={{ color: "var(--wb-needs)" }}>The last push failed: {b.failing}</div>}
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div>
        Duck's data isn't backed up
        <span style={hint}>
          {b.repo ? " (its memory, config and task results are only on this PC)" : " (nothing remembered yet)"}
        </span>
      </div>
      {asking ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span>Create a private GitHub repo "{name}" with gh and push to it?</span>
          <button
            type="button"
            style={btn}
            onClick={() => {
              setAsking(false);
              createBackup(name.trim());
            }}
          >
            yes
          </button>
          <button type="button" style={btn} onClick={() => setAsking(false)}>
            no
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, width: 140 }} aria-label="repo name" />
          <button type="button" style={btn} disabled={!/^[A-Za-z0-9._-]+$/.test(name.trim())} onClick={() => setAsking(true)}>
            back up to a private GitHub repo…
          </button>
        </div>
      )}
    </div>
  );
}

export default function RoutinesSettings({ duck, settings }: { duck: DuckState; settings: DuckSettings }) {
  return (
    <>
      <Backup duck={duck} />
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>Delete threads idle for</span>
        <select
          value={settings.deleteIdleThreadsDays}
          onChange={(e) => setDuckSettings({ deleteIdleThreadsDays: Number(e.target.value) })}
          style={input}
        >
          {DELETE_IDLE_CHOICES.map((d) => (
            <option key={d} value={d}>
              {d === 0 ? "never" : `${d} days`}
            </option>
          ))}
        </select>
        <span style={hint}>(weekly; pinned ones ● stay)</span>
      </label>
      <div style={{ ...hint, marginTop: 4 }}>Routines (ask Duck for a new one: "every weekday at 8:30, my morning briefing")</div>
      {duck.routines.map((r) => (
        <div key={r.id} style={{ borderTop: "1px solid var(--wb-border)", paddingTop: 4, lineHeight: 1.45 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ flex: 1, color: r.on ? "var(--wb-text)" : "var(--wb-textFaint)" }}>
              {r.title}
              {!r.on && " (paused)"}
            </span>
            <button type="button" style={linkBtn} onClick={() => setRoutine(r.id, "run")}>
              run now
            </button>
            <button type="button" style={linkBtn} onClick={() => setRoutine(r.id, r.on ? "pause" : "resume")}>
              {r.on ? "pause" : "resume"}
            </button>
            {!r.builtIn && (
              <button type="button" style={linkBtn} onClick={() => setRoutine(r.id, "delete")}>
                delete
              </button>
            )}
          </div>
          <div style={hint}>
            {r.when} · {r.does}
            {r.on && ` · next ${when(r.next)}`}
          </div>
          {r.last !== null && (
            <div style={{ color: r.lastResult?.startsWith("failed") ? "var(--wb-needs)" : "var(--wb-textDim2)" }}>
              last {when(r.last)}: {r.lastResult}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };

const input: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
};

const btn: React.CSSProperties = {
  background: "transparent",
  color: "var(--wb-textDim2)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
  padding: "0 6px",
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  color: "var(--wb-accent)",
  font: "inherit",
  cursor: "pointer",
};
