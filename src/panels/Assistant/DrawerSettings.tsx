// The drawer's settings (step A3), in tabs that scroll on their own:
// - drawer: what a message typed mid-reply does, the ASCII duck's look, "Start
//   Workbench at login, minimized to tray", which keeps Duck there whenever the PC
//   is on, and Home, the weather's place (H2);
// - sessions: Duck's prompts and permission answers, summaries, the coding model
//   (W2, T2, W3, M4);
// - workers: D1's worker sessions;
// - routines: what Duck does on a schedule, the backup of its data, and the
//   clean-up of idle threads (L4);
// - skills: Duck's skills and modes as files, and the MCP servers it may use (S2:
//   its capabilities in one place);
// - voice: push-to-talk and speech to text (V1);
// - announcements: Speak, and when Duck speaks up about news (V5);
// - google auth: Duck's Google sign-in (Drive and Sheets) and the speech key.
// Duck's own settings go to the engine over the protocol. The login entry is the
// OS's own (`tauri-plugin-autostart`), so its state is read back from the OS rather
// than kept in prefs. A dev build can't set it: the entry would point at the debug
// binary.

import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { CLOSE_CHOICES, COMPACT_CHOICES, IDLE_STOP_CHOICES, MAX_WORKERS, TIERS, type DuckSettings } from "../../assistant/settings";
import { DUCK_PERMISSION_MODES, EFFORTS, SESSION_MODELS } from "../../util/models";
import { loadTimings, setAvatar, setDuckSettings, setInterrupt, type DuckState } from "./duckState";
import VoiceSettings from "./VoiceSettings";
import SpeechSettings from "./SpeechSettings";
import AnnounceSettings from "./AnnounceSettings";
import GoogleSettings from "./GoogleSettings";
import { openCoreMemory } from "./openCore";
import RoutinesSettings from "./RoutinesSettings";
import SkillsSettings from "./SkillsSettings";

/** The settings' categories, in tab order. */
const TABS = ["drawer", "sessions", "workers", "routines", "skills", "voice", "announcements", "google auth"] as const;
type Tab = (typeof TABS)[number];

/** The tab last shown, kept while the app runs. */
let lastTab: Tab = "drawer";

export default function DrawerSettings({ duck }: { duck: DuckState }) {
  const [tab, setTab] = useState<Tab>(lastTab);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void isEnabled()
      .then(setAutostart)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const toggleAutostart = async (on: boolean) => {
    setError(null);
    try {
      await (on ? enable() : disable());
      setAutostart(await isEnabled());
    } catch (e) {
      setError(String(e));
    }
  };

  const show = (t: Tab) => {
    lastTab = t;
    setTab(t);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
      <div role="tablist" style={{ display: "flex", gap: 2, padding: "0 8px 6px", borderBottom: "1px solid var(--wb-border)" }}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => show(t)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${tab === t ? "var(--wb-accent)" : "transparent"}`,
              color: tab === t ? "var(--wb-text)" : "var(--wb-textDim2)",
              font: "11px var(--wb-mono)",
              padding: "3px 6px",
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "8px 12px 4px",
          overflowY: "auto",
          minHeight: 0,
          flex: "1 1 auto",
        }}
      >
        {tab === "drawer" && (
          <>
            <label style={row}>
              <input
                type="checkbox"
                checked={duck.prefs.interrupt}
                onChange={(e) => setInterrupt(e.target.checked)}
              />
              <span>
                A message sent while Duck replies interrupts the reply
                <span style={hint}> (off: it waits its turn)</span>
              </span>
            </label>
            <Avatar duck={duck} />
            <label style={{ ...row, opacity: import.meta.env.DEV ? 0.55 : 1 }}>
              <input
                type="checkbox"
                disabled={import.meta.env.DEV || autostart === null}
                checked={!!autostart}
                onChange={(e) => void toggleAutostart(e.target.checked)}
              />
              <span>
                Start Workbench at login, minimized to the tray
                {import.meta.env.DEV && (
                  <span style={hint}> (installed builds only)</span>
                )}
              </span>
            </label>
            {duck.settings && <Home settings={duck.settings} />}
          </>
        )}
        {tab === "sessions" &&
          (duck.settings ? (
            <>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={duck.settings.confirmPrompts}
                  onChange={(e) =>
                    setDuckSettings({ confirmPrompts: e.target.checked })
                  }
                />
                <span>
                  Ask before every prompt Duck sends to a session
                  <span style={hint}>
                    {" "}
                    (off: prompts follow the trust rules)
                  </span>
                </span>
              </label>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={duck.settings.answerSessionPrompts}
                  onChange={(e) =>
                    setDuckSettings({ answerSessionPrompts: e.target.checked })
                  }
                />
                <span>
                  Answer sessions' permission prompts under the trust rules
                  <span style={hint}>
                    {" "}
                    (off: Duck only logs what it would do; run the replay in
                    decisions first)
                  </span>
                </span>
              </label>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={duck.settings.summaryOnDone}
                  onChange={(e) =>
                    setDuckSettings({ summaryOnDone: e.target.checked })
                  }
                />
                <span>
                  Summarize a session when it finishes, for the done alert
                  <span style={hint}>
                    {" "}
                    (a Haiku call per alert, about $0.002)
                  </span>
                </span>
              </label>
              <label style={{ ...row, alignItems: "center" }}>
                <span>Sessions' plans:</span>
                <select
                  value={duck.settings.planApproval}
                  onChange={(e) => setDuckSettings({ planApproval: e.target.value as DuckSettings["planApproval"] })}
                  style={select}
                >
                  <option value="show">show me the plan with Duck's review</option>
                  <option value="approve">approve if Duck's review passes</option>
                </select>
                <span style={hint}>(reviewed against what the session is for; edits still ask)</span>
              </label>
              <label style={{ ...row, alignItems: "center" }}>
                <span>Compact a thread past</span>
                <select
                  value={duck.settings.compactAt}
                  onChange={(e) => setDuckSettings({ compactAt: Number(e.target.value) })}
                  style={select}
                >
                  {COMPACT_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "never" : `${n / 1000}k tokens`}
                    </option>
                  ))}
                </select>
                <span style={hint}>(older turns become a summary; every message stays here)</span>
              </label>
              <label style={{ ...row, alignItems: "center" }}>
                <span>Duck answers on</span>
                <select
                  value={duck.settings.brainPolicy}
                  onChange={(e) => setDuckSettings({ brainPolicy: e.target.value as DuckSettings["brainPolicy"] })}
                  style={select}
                >
                  <option value="auto">the API, your subscription when credits run low</option>
                  <option value="api">the API only</option>
                  <option value="subscription">your subscription only</option>
                </select>
              </label>
              <SessionModes duck={duck} />
              <label style={{ ...row, alignItems: "center" }}>
                <span>Sessions Duck starts for coding run on</span>
                <select
                  value={duck.settings.codingModel}
                  onChange={(e) =>
                    setDuckSettings({
                      codingModel: e.target
                        .value as (typeof SESSION_MODELS)[number],
                    })
                  }
                  style={{
                    background: "var(--wb-bg)",
                    color: "var(--wb-text)",
                    border: "1px solid var(--wb-border)",
                    font: "inherit",
                  }}
                >
                  {SESSION_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ ...row, alignItems: "center" }}>
                <span>…in permission mode</span>
                <select
                  value={duck.settings.codingPermissionMode ?? ""}
                  onChange={(e) =>
                    setDuckSettings({
                      codingPermissionMode: (e.target.value ||
                        null) as (typeof DUCK_PERMISSION_MODES)[number] | null,
                    })
                  }
                  style={{
                    background: "var(--wb-bg)",
                    color: "var(--wb-text)",
                    border: "1px solid var(--wb-border)",
                    font: "inherit",
                  }}
                >
                  <option value="">the project's default</option>
                  {DUCK_PERMISSION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <Waiting />
          ))}
        {tab === "workers" && (duck.settings ? <Workers settings={duck.settings} /> : <Waiting />)}
        {tab === "routines" && (duck.settings ? <RoutinesSettings duck={duck} settings={duck.settings} /> : <Waiting />)}
        {tab === "skills" && (duck.settings ? <SkillsSettings duck={duck} settings={duck.settings} /> : <Waiting />)}
        {tab === "voice" && (
          <>
            <VoiceSettings />
            <SpeechSettings />
          </>
        )}
        {tab === "announcements" && (duck.settings ? <AnnounceSettings settings={duck.settings} /> : <Waiting />)}
        {tab === "google auth" && (duck.settings ? <GoogleSettings settings={duck.settings} /> : <Waiting />)}
        {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
      </div>
    </div>
  );
}

/** Where the user lives: the weather's place when none is named (H2). */
function Home({ settings }: { settings: DuckSettings }) {
  const [home, setHome] = useState(settings.home ?? "");
  useEffect(() => setHome(settings.home ?? ""), [settings.home]);
  return (
    <label style={{ ...row, alignItems: "center" }}>
      <span style={{ flex: "0 0 auto" }}>Home</span>
      <input
        value={home}
        placeholder="a city, for the weather"
        onChange={(e) => setHome(e.target.value)}
        onBlur={() => {
          if (home.trim() !== (settings.home ?? "")) setDuckSettings({ home: home.trim() || null });
        }}
        style={{ ...select, flex: 1, minWidth: 0, padding: "1px 4px" }}
      />
    </label>
  );
}

/** Duck's own settings come from the engine once it's connected. */
function Waiting() {
  return <div style={hint}>Duck is starting…</div>;
}

/** The ASCII duck above the thread: shown or not, and how it's drawn. */
function Avatar({ duck }: { duck: DuckState }) {
  const a = duck.prefs.avatar;
  return (
    <>
      <label style={row}>
        <input type="checkbox" checked={a.show} onChange={(e) => setAvatar({ show: e.target.checked })} />
        <span>Show the duck above the thread</span>
      </label>
      {a.show && (
        <>
          <label style={{ ...row, alignItems: "center" }}>
            <span style={{ width: 64 }}>Ink</span>
            <select
              value={a.ink}
              onChange={(e) => setAvatar({ ink: e.target.value as typeof a.ink })}
              style={select}
            >
              <option value="color">duck yellow</option>
              <option value="mono">console</option>
            </select>
            <select
              value={a.chars}
              onChange={(e) => setAvatar({ chars: e.target.value as typeof a.chars })}
              style={select}
            >
              <option value="classic">.:-=+*#%@</option>
              <option value="blocks">░▒▓█</option>
            </select>
          </label>
          <label style={{ ...row, alignItems: "center" }}>
            <span style={{ width: 64 }}>Columns</span>
            <input
              type="range"
              min={40}
              max={130}
              step={2}
              value={a.cols}
              onChange={(e) => setAvatar({ cols: Number(e.target.value) })}
              style={{ flex: 1, minWidth: 0 }}
            />
            <span style={{ width: 44, textAlign: "right" }}>{a.cols}</span>
          </label>
          <label style={{ ...row, alignItems: "center" }}>
            <span style={{ width: 64 }}>Frames</span>
            <input
              type="range"
              min={8}
              max={60}
              value={a.fps}
              onChange={(e) => setAvatar({ fps: Number(e.target.value) })}
              style={{ flex: 1, minWidth: 0 }}
            />
            <span style={{ width: 44, textAlign: "right" }}>{a.fps} fps</span>
          </label>
        </>
      )}
    </>
  );
}

/** The core memory (W4): what every thread starts with, opened in the editor. */
function CoreMemoryRow({ workspace }: { workspace: string | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ ...row, alignItems: "center" }}>
      <span>Core memory</span>
      <button
        type="button"
        style={select}
        onClick={() => {
          setError(null);
          openCoreMemory(workspace).catch((e: unknown) => setError(String(e)));
        }}
      >
        Edit core.md
      </button>
      <span style={hint}>{error ?? "(what every thread starts with)"}</span>
    </div>
  );
}

/** Duck's worker sessions (D1): how many at once, where, and each tier's worker. */
function Workers({ settings }: { settings: DuckSettings }) {
  const [workspace, setWorkspace] = useState(settings.workspace ?? "");
  useEffect(() => setWorkspace(settings.workspace ?? ""), [settings.workspace]);
  const setTier = (tier: (typeof TIERS)[number], patch: Partial<DuckSettings["tiers"]["standard"]>) =>
    setDuckSettings({ tiers: { ...settings.tiers, [tier]: { ...settings.tiers[tier], ...patch } } });
  return (
    <>
      <label style={{ ...row, alignItems: "center" }}>
        <span>Worker sessions at once</span>
        <select
          value={settings.maxWorkers}
          onChange={(e) => setDuckSettings({ maxWorkers: Number(e.target.value) })}
          style={select}
        >
          {Array.from({ length: MAX_WORKERS }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span style={hint}>(more tasks wait)</span>
      </label>
      <label style={row}>
        <input
          type="checkbox"
          checked={settings.headlessWorkers}
          onChange={(e) => setDuckSettings({ headlessWorkers: e.target.checked })}
        />
        <span>
          Run workers headless
          <span style={hint}> (no terminal: their console is the transcript, with "take over" for one)</span>
        </span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span>Stop a finished worker after</span>
        <select
          value={settings.workerIdleStopMinutes}
          onChange={(e) => setDuckSettings({ workerIdleStopMinutes: Number(e.target.value) })}
          style={select}
        >
          {IDLE_STOP_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "never" : m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
        </select>
        <span style={hint}>idle (a follow-up resumes it)</span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span>Close a finished task after</span>
        <select
          value={settings.closeFinishedHours}
          onChange={(e) => setDuckSettings({ closeFinishedHours: Number(e.target.value) })}
          style={select}
        >
          {CLOSE_CHOICES.map((h) => (
            <option key={h} value={h}>
              {h === 0 ? "never" : h < 24 ? `${h} h` : h === 168 ? "a week" : `${h / 24} d`}
            </option>
          ))}
        </select>
        <span style={hint}>(its session leaves the rail; files stay)</span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span style={{ flex: "0 0 auto" }}>Workspace</span>
        <input
          value={workspace}
          placeholder={import.meta.env.DEV ? "~/repos/Duck.dev" : "~/repos/Duck"}
          onChange={(e) => setWorkspace(e.target.value)}
          onBlur={() => {
            if (workspace.trim() !== (settings.workspace ?? "")) setDuckSettings({ workspace: workspace.trim() || null });
          }}
          style={{ ...select, flex: 1, minWidth: 0, padding: "1px 4px" }}
        />
      </label>
      <CoreMemoryRow workspace={settings.workspace} />
      {TIERS.map((tier) => (
        <label key={tier} style={{ ...row, alignItems: "center" }}>
          <span style={{ width: 64 }}>{tier}</span>
          <select
            value={settings.tiers[tier].model}
            onChange={(e) => setTier(tier, { model: e.target.value as (typeof SESSION_MODELS)[number] })}
            style={select}
          >
            {SESSION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={settings.tiers[tier].effort}
            onChange={(e) => setTier(tier, { effort: e.target.value as (typeof EFFORTS)[number] })}
            style={select}
          >
            {EFFORTS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}

const select: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
};

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  cursor: "pointer",
  lineHeight: 1.45,
};

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };

/** The modes that think on the subscription (step D3, an experiment), and how
 *  their turns compare with the API's. */
function SessionModes({ duck }: { duck: DuckState }) {
  const settings = duck.settings!;
  const [shown, setShown] = useState(false);
  const toggle = (mode: string, on: boolean) =>
    setDuckSettings({
      sessionModes: on ? [...settings.sessionModes, mode] : settings.sessionModes.filter((m) => m !== mode),
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ ...row, alignItems: "center", flexWrap: "wrap" }}>
        <span>Think on your subscription (experiment):</span>
        {(["duck", "chat"] as const).map((m) => (
          <label key={m} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={settings.sessionModes.includes(m)} onChange={(e) => toggle(m, e.target.checked)} />
            <span>{m === "duck" ? "rubber duck" : "chat"}</span>
          </label>
        ))}
        <span>on</span>
        <select
          value={settings.sessionModel}
          onChange={(e) => setDuckSettings({ sessionModel: e.target.value as DuckSettings["sessionModel"] })}
          style={select}
        >
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
        <span style={hint}>(no API credits; back on the API while the subscription is busy)</span>
      </div>
      <div style={{ ...row, alignItems: "flex-start", flexDirection: "column", gap: 2 }}>
        <button
          type="button"
          onClick={() => {
            setShown(true);
            loadTimings();
          }}
          style={{ ...select, cursor: "pointer", padding: "1px 8px" }}
        >
          how they compare
        </button>
        {shown &&
          (duck.timings === null ? (
            <span style={hint}>reading…</span>
          ) : duck.timings.length === 0 ? (
            <span style={hint}>No turns timed yet.</span>
          ) : (
            duck.timings.map((l) => (
              <span key={l} style={hint}>
                {l}
              </span>
            ))
          ))}
      </div>
    </div>
  );
}
