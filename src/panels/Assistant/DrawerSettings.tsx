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
// The categories are a column on the left when the popover is wide, a strip that
// scrolls sideways when it's not; each category's settings sit in titled cards
// (`.wb-settings-*` in assistant.css).
// Duck's own settings go to the engine over the protocol. The login entry is the
// OS's own (`tauri-plugin-autostart`), so its state is read back from the OS rather
// than kept in prefs. A dev build can't set it: the entry would point at the debug
// binary.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** The settings' categories, in tab order, with what each holds. */
const TABS = [
  { id: "drawer", label: "Drawer", about: "How the drawer behaves and looks" },
  { id: "sessions", label: "Sessions", about: "Duck's prompts, plans and models for your sessions" },
  { id: "workers", label: "Workers", about: "The worker sessions Duck runs for tasks" },
  { id: "routines", label: "Routines", about: "Schedules, backup and clean-up" },
  { id: "skills", label: "Skills", about: "Duck's skills, modes and MCP servers" },
  { id: "voice", label: "Voice", about: "Push-to-talk, speech to text and Duck's voice" },
  { id: "announcements", label: "Announce", about: "When Duck speaks up about news" },
  { id: "google auth", label: "Google", about: "Google sign-in and the speech key" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** The tab last shown, kept while the app runs. */
let lastTab: Tab = "drawer";

/** Wider than this, the categories are a column on the left; narrower, a strip
 *  across the top. Either scrolls when the categories don't fit. */
const SIDEBAR_AT = 440;

export default function DrawerSettings({ duck }: { duck: DuckState }) {
  const [tab, setTab] = useState<Tab>(lastTab);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [sidebar, setSidebar] = useState(false);

  useEffect(() => {
    void isEnabled()
      .then(setAutostart)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setSidebar(el.getBoundingClientRect().width >= SIDEBAR_AT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div
      ref={rootRef}
      className="wb-settings"
      style={{ display: "flex", flexDirection: sidebar ? "row" : "column", minHeight: 0, flex: "1 1 auto" }}
    >
      <TabList tab={tab} onShow={show} vertical={sidebar} />
      <div
        role="tabpanel"
        aria-label={current.label}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "10px 12px 12px",
          overflowY: "auto",
          minHeight: 0,
          minWidth: 0,
          flex: "1 1 auto",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ color: "var(--wb-text)", fontWeight: 600, fontSize: 13 }}>{current.label}</span>
          <span style={note}>{current.about}</span>
        </div>
        {tab === "drawer" && (
          <>
            <Group title="Conversation">
              <Check
                checked={duck.prefs.interrupt}
                onChange={setInterrupt}
                label="A message sent while Duck replies interrupts the reply"
                hint="Off: it waits its turn"
              />
            </Group>
            <Group title="The duck">
              <Avatar duck={duck} />
            </Group>
            <Group title="System">
              <Check
                checked={!!autostart}
                disabled={import.meta.env.DEV || autostart === null}
                onChange={(on) => void toggleAutostart(on)}
                label="Start Workbench at login, minimized to the tray"
                hint={import.meta.env.DEV ? "Installed builds only" : "Keeps Duck there whenever the PC is on"}
              />
              {duck.settings && <Home settings={duck.settings} />}
            </Group>
          </>
        )}
        {tab === "sessions" &&
          (duck.settings ? (
            <>
              <Group title="Prompts and permissions">
                <Check
                  checked={duck.settings.confirmPrompts}
                  onChange={(on) => setDuckSettings({ confirmPrompts: on })}
                  label="Ask before every prompt Duck sends to a session"
                  hint="Off: prompts follow the trust rules"
                />
                <Check
                  checked={duck.settings.answerSessionPrompts}
                  onChange={(on) => setDuckSettings({ answerSessionPrompts: on })}
                  label="Answer sessions' permission prompts under the trust rules"
                  hint="Off: Duck only logs what it would do; run the replay in decisions first"
                />
                <Check
                  checked={duck.settings.summaryOnDone}
                  onChange={(on) => setDuckSettings({ summaryOnDone: on })}
                  label="Summarize a session when it finishes, for the done alert"
                  hint="A Haiku call per alert, about $0.002"
                />
                <Field label="Sessions' plans" hint="Reviewed against what the session is for; edits still ask">
                  <select
                    value={duck.settings.planApproval}
                    onChange={(e) => setDuckSettings({ planApproval: e.target.value as DuckSettings["planApproval"] })}
                    style={select}
                  >
                    <option value="show">show me the plan with Duck's review</option>
                    <option value="approve">approve if Duck's review passes</option>
                  </select>
                </Field>
              </Group>
              <Group title="Duck's threads">
                <Field label="Compact a thread past" hint="Older turns become a summary; every message stays here">
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
                </Field>
                <Field label="Duck answers on">
                  <select
                    value={duck.settings.brainPolicy}
                    onChange={(e) => setDuckSettings({ brainPolicy: e.target.value as DuckSettings["brainPolicy"] })}
                    style={select}
                  >
                    <option value="auto">the API, your subscription when credits run low</option>
                    <option value="api">the API only</option>
                    <option value="subscription">your subscription only</option>
                  </select>
                </Field>
                <SessionModes duck={duck} />
              </Group>
              <Group title="Coding sessions Duck starts">
                <Field label="Model">
                  <select
                    value={duck.settings.codingModel}
                    onChange={(e) =>
                      setDuckSettings({ codingModel: e.target.value as (typeof SESSION_MODELS)[number] })
                    }
                    style={select}
                  >
                    {SESSION_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Permission mode">
                  <select
                    value={duck.settings.codingPermissionMode ?? ""}
                    onChange={(e) =>
                      setDuckSettings({
                        codingPermissionMode: (e.target.value || null) as
                          | (typeof DUCK_PERMISSION_MODES)[number]
                          | null,
                      })
                    }
                    style={select}
                  >
                    <option value="">the project's default</option>
                    {DUCK_PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
              </Group>
            </>
          ) : (
            <Waiting />
          ))}
        {tab === "workers" && (duck.settings ? <Workers settings={duck.settings} /> : <Waiting />)}
        {tab === "routines" &&
          (duck.settings ? (
            <Group>
              <RoutinesSettings duck={duck} settings={duck.settings} />
            </Group>
          ) : (
            <Waiting />
          ))}
        {tab === "skills" &&
          (duck.settings ? (
            <Group>
              <SkillsSettings duck={duck} settings={duck.settings} />
            </Group>
          ) : (
            <Waiting />
          ))}
        {tab === "voice" && (
          <>
            <Group title="Listening">
              <VoiceSettings />
            </Group>
            <Group title="Speaking">
              <SpeechSettings />
            </Group>
          </>
        )}
        {tab === "announcements" &&
          (duck.settings ? (
            <Group>
              <AnnounceSettings settings={duck.settings} />
            </Group>
          ) : (
            <Waiting />
          ))}
        {tab === "google auth" &&
          (duck.settings ? (
            <Group>
              <GoogleSettings settings={duck.settings} />
            </Group>
          ) : (
            <Waiting />
          ))}
        {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
      </div>
    </div>
  );
}

/** The categories: a column, or a strip that scrolls sideways (the wheel scrolls
 *  it too), with arrows while some are out of sight. The shown one is kept in view. */
function TabList({ tab, onShow, vertical }: { tab: Tab; onShow: (t: Tab) => void; vertical: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el || vertical) return setEdges({ start: false, end: false });
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, [vertical]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A vertical wheel moves the strip sideways.
    const onWheel = (e: WheelEvent) => {
      if (vertical || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [measure, vertical]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, vertical]);

  const nudge = (dir: 1 | -1) => {
    const el = listRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: "smooth" });
  };

  // Arrow keys move between the categories, as in any tab list.
  const onKey = (e: React.KeyboardEvent) => {
    const [prev, next] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    const i = TABS.findIndex((t) => t.id === tab);
    const to =
      e.key === prev ? (i - 1 + TABS.length) % TABS.length
      : e.key === next ? (i + 1) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    onShow(TABS[to].id);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <div
      style={{
        position: "relative",
        flex: "0 0 auto",
        display: "flex",
        minHeight: 0,
        ...(vertical
          ? { width: 116, borderRight: "1px solid var(--wb-border)" }
          : { borderBottom: "1px solid var(--wb-border)" }),
      }}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        className={vertical ? "wb-settings-tabs" : "wb-settings-tabs wb-settings-strip"}
        onScroll={measure}
        onKeyDown={onKey}
        style={{
          display: "flex",
          flexDirection: vertical ? "column" : "row",
          gap: vertical ? 1 : 4,
          padding: vertical ? "4px 6px" : "2px 10px 8px",
          overflowX: vertical ? "hidden" : "auto",
          overflowY: vertical ? "auto" : "hidden",
          flex: "1 1 auto",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            title={t.about}
            onClick={() => onShow(t.id)}
            className="wb-settings-tab"
            data-vertical={vertical || undefined}
          >
            {t.label}
          </button>
        ))}
      </div>
      {edges.start && (
        <button
          type="button"
          aria-label="earlier categories"
          className="wb-settings-arrow"
          data-side="start"
          tabIndex={-1}
          onClick={() => nudge(-1)}
        >
          ‹
        </button>
      )}
      {edges.end && (
        <button
          type="button"
          aria-label="later categories"
          className="wb-settings-arrow"
          data-side="end"
          tabIndex={-1}
          onClick={() => nudge(1)}
        >
          ›
        </button>
      )}
    </div>
  );
}

/** A card of related settings, titled. */
function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="wb-settings-group">
      {title && <div className="wb-settings-group-title">{title}</div>}
      {children}
    </section>
  );
}

/** A checkbox setting, its note under it. */
function Check({
  checked,
  disabled,
  onChange,
  label,
  hint: about,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <label style={{ ...row, opacity: disabled ? 0.55 : 1, cursor: disabled ? "default" : "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flex: "0 0 auto" }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span>{label}</span>
        {about && <span style={note}>{about}</span>}
      </span>
    </label>
  );
}

/** A setting with a control: the label on the left, the control on the right
 *  (under it when there's no room), the note below. */
function Field({ label, hint: about, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, cursor: "pointer", lineHeight: 1.45 }}>
      <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px" }}>
        <span style={{ flex: "1 1 auto" }}>{label}</span>
        <span className="wb-settings-control">{children}</span>
      </span>
      {about && <span style={note}>{about}</span>}
    </label>
  );
}

/** Where the user lives: the weather's place when none is named (H2). */
function Home({ settings }: { settings: DuckSettings }) {
  const [home, setHome] = useState(settings.home ?? "");
  useEffect(() => setHome(settings.home ?? ""), [settings.home]);
  return (
    <Field label="Home" hint="The weather's place when you don't name one">
      <input
        value={home}
        placeholder="a city"
        onChange={(e) => setHome(e.target.value)}
        onBlur={() => {
          if (home.trim() !== (settings.home ?? "")) setDuckSettings({ home: home.trim() || null });
        }}
        style={{ ...select, width: 180, minWidth: 0 }}
      />
    </Field>
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
      <Check checked={a.show} onChange={(show) => setAvatar({ show })} label="Show the duck above the thread" />
      {a.show && (
        <>
          <Field label="Ink">
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
          </Field>
          <Slider label="Columns" min={40} max={130} step={2} value={a.cols} shown={String(a.cols)} onChange={(cols) => setAvatar({ cols })} />
          <Slider label="Frames" min={8} max={60} value={a.fps} shown={`${a.fps} fps`} onChange={(fps) => setAvatar({ fps })} />
        </>
      )}
    </>
  );
}

/** A slider with its label before it and its value after. */
function Slider({
  label,
  min,
  max,
  step,
  value,
  shown,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  shown: string;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ ...row, alignItems: "center" }}>
      <span style={{ width: 64, flex: "0 0 auto" }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span style={{ width: 48, textAlign: "right", color: "var(--wb-textDim2)" }}>{shown}</span>
    </label>
  );
}

/** The core memory (W4): what every thread starts with, opened in the editor. */
function CoreMemoryRow({ workspace }: { workspace: string | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, lineHeight: 1.45 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 auto" }}>Core memory</span>
        <button
          type="button"
          style={{ ...select, cursor: "pointer" }}
          onClick={() => {
            setError(null);
            openCoreMemory(workspace).catch((e: unknown) => setError(String(e)));
          }}
        >
          Edit core.md
        </button>
      </div>
      <span style={error ? { ...note, color: "var(--wb-needs)" } : note}>{error ?? "What every thread starts with"}</span>
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
      <Group title="Running">
        <Field label="Worker sessions at once" hint="More tasks wait their turn">
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
        </Field>
        <Check
          checked={settings.headlessWorkers}
          onChange={(on) => setDuckSettings({ headlessWorkers: on })}
          label="Run workers headless"
          hint={'No terminal: their console is the transcript, with "take over" for one'}
        />
        <Field label="Stop a finished worker idle for" hint="A follow-up resumes it">
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
        </Field>
        <Field label="Close a finished task after" hint="Its session leaves the rail; files stay">
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
        </Field>
      </Group>
      <Group title="Workspace">
        <label style={{ display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}>
          <span>Folder</span>
          <input
            value={workspace}
            placeholder={import.meta.env.DEV ? "~/repos/Duck.dev" : "~/repos/Duck"}
            onChange={(e) => setWorkspace(e.target.value)}
            onBlur={() => {
              if (workspace.trim() !== (settings.workspace ?? "")) setDuckSettings({ workspace: workspace.trim() || null });
            }}
            style={{ ...select, width: "100%" }}
          />
        </label>
        <CoreMemoryRow workspace={settings.workspace} />
      </Group>
      <Group title="Each tier's worker">
        {TIERS.map((tier) => (
          <Field key={tier} label={tier}>
            <select
              value={settings.tiers[tier].model}
              onChange={(e) => setTier(tier, { model: e.target.value as (typeof SESSION_MODELS)[number] })}
              style={select}
              aria-label={`${tier} model`}
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
              aria-label={`${tier} effort`}
            >
              {EFFORTS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </Group>
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

const hint: React.CSSProperties = { color: "var(--wb-textDim2)" };

/** A setting's note, on its own line under it. */
const note: React.CSSProperties = { color: "var(--wb-textDim2)", fontSize: 11, lineHeight: 1.4 };

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
    <div style={{ display: "flex", flexDirection: "column", gap: 4, lineHeight: 1.45 }}>
      <span>
        Think on your subscription <span style={hint}>(experiment)</span>
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: "4px 12px", flexWrap: "wrap" }}>
        {(["duck", "chat"] as const).map((m) => (
          <label key={m} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={settings.sessionModes.includes(m)} onChange={(e) => toggle(m, e.target.checked)} />
            <span>{m === "duck" ? "rubber duck" : "chat"}</span>
          </label>
        ))}
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", cursor: "pointer" }}>
          <span>on</span>
          <select
            value={settings.sessionModel}
            onChange={(e) => setDuckSettings({ sessionModel: e.target.value as DuckSettings["sessionModel"] })}
            style={select}
          >
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </label>
      </div>
      <span style={note}>No API credits; back on the API while the subscription is busy</span>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        <button
          type="button"
          onClick={() => {
            setShown(true);
            loadTimings();
          }}
          style={{ ...select, cursor: "pointer" }}
        >
          how they compare
        </button>
        {shown &&
          (duck.timings === null ? (
            <span style={note}>reading…</span>
          ) : duck.timings.length === 0 ? (
            <span style={note}>No turns timed yet.</span>
          ) : (
            duck.timings.map((l) => (
              <span key={l} style={note}>
                {l}
              </span>
            ))
          ))}
      </div>
    </div>
  );
}
