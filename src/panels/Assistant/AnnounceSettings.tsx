// Duck settings → announcements (step V5): when Duck speaks up about news, and the
// Speak switch. Every rule of the design's etiquette table is here.

import type { AnnounceSettings as Settings, Level } from "../../assistant/announce";
import type { DuckSettings } from "../../assistant/settings";
import { setDuckSettings } from "./duckState";
import { setSpeakOn, useSpeechState } from "./replySpeech";

const LEVELS: [Level, string][] = [
  ["info", "small things (housekeeping, Duck settling a worker's question)"],
  ["report", "reports (a task done, a session you asked about)"],
  ["needs_you", "what needs you (a decision, a card, an autopilot stop)"],
];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export default function AnnounceSettings({ settings }: { settings: DuckSettings }) {
  const a = settings.announce;
  const speech = useSpeechState();
  const set = (patch: Partial<Settings>) => setDuckSettings({ announce: { ...a, ...patch } });
  return (
    <>
      <label style={row}>
        <input type="checkbox" checked={speech.prefs.on} onChange={(e) => setSpeakOn(e.target.checked)} />
        <span>
          Speak: Duck uses its voice on this PC (replies, reading aloud, announcements)
          <div style={hint}>Also the speaker by the Duck button. Ctrl+Shift+L speaks a selection either way.</div>
        </span>
      </label>
      <div style={{ ...hint, marginTop: 4 }}>Say out loud, when you're around:</div>
      {LEVELS.map(([level, label]) => (
        <label key={level} style={row}>
          <input
            type="checkbox"
            checked={a.speak[level] === "around"}
            onChange={(e) => set({ speak: { ...a.speak, [level]: e.target.checked ? "around" : "never" } })}
          />
          <span>{label}</span>
        </label>
      ))}
      <label style={row}>
        <input type="checkbox" checked={a.pushWhenAway} onChange={(e) => set({ pushWhenAway: e.target.checked })} />
        <span>Push to the phone when you're not around (and what needs you, during Do Not Disturb)</span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span>"Around" means input within</span>
        <select value={a.aroundMinutes} onChange={(e) => set({ aroundMinutes: Number(e.target.value) })} style={select}>
          {[1, 2, 5, 10, 15].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
      </label>
      <label style={row}>
        <input type="checkbox" checked={a.waitForGap} onChange={(e) => set({ waitForGap: e.target.checked })} />
        <span>Wait for a pause in your typing before speaking</span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span>Updates arriving together are said together, at most one announcement per</span>
        <select value={a.batchSeconds} onChange={(e) => set({ batchSeconds: Number(e.target.value) })} style={select}>
          {[0, 10, 20, 30, 60].map((s) => (
            <option key={s} value={s}>
              {s} s
            </option>
          ))}
        </select>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <span>Repeat what needs you, once, if unanswered after</span>
        <select value={a.repeatMinutes} onChange={(e) => set({ repeatMinutes: Number(e.target.value) })} style={select}>
          {[0, 5, 10, 20, 30].map((m) => (
            <option key={m} value={m}>
              {m ? `${m} min` : "never"}
            </option>
          ))}
        </select>
      </label>
      <div style={{ ...hint, marginTop: 4 }}>Quiet (held back, then one short catch-up):</div>
      <label style={row}>
        <input type="checkbox" checked={a.followFocus} onChange={(e) => set({ followFocus: e.target.checked })} />
        <span>While Windows' Focus / Do Not Disturb is on</span>
      </label>
      <label style={row}>
        <input type="checkbox" checked={a.fullScreenQuiet} onChange={(e) => set({ fullScreenQuiet: e.target.checked })} />
        <span>Over a full-screen app or a presentation, except what needs you</span>
      </label>
      <label style={{ ...row, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={a.quietHours.on}
          onChange={(e) => set({ quietHours: { ...a.quietHours, on: e.target.checked } })}
        />
        <span>Quiet hours from</span>
        <input
          type="time"
          value={hhmm(a.quietHours.from)}
          disabled={!a.quietHours.on}
          onChange={(e) => set({ quietHours: { ...a.quietHours, from: minutes(e.target.value) } })}
          style={select}
        />
        <span>to</span>
        <input
          type="time"
          value={hhmm(a.quietHours.to)}
          disabled={!a.quietHours.on}
          onChange={(e) => set({ quietHours: { ...a.quietHours, to: minutes(e.target.value) } })}
          style={select}
        />
      </label>
      <div style={hint}>Duck's own Do Not Disturb: right-click the Duck button, or say "Duck, quiet for an hour".</div>
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
