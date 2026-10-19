// The drawer's settings (step A3): what a message typed mid-reply does, and
// "Start Workbench at login, minimized to tray", which keeps Duck there whenever
// the PC is on. Duck's own settings (W2: confirm every prompt, the coding model)
// go to the engine over the protocol. The login entry is the OS's own (`tauri-plugin-autostart`), so its
// state is read back from the OS rather than kept in prefs. A dev build can't set
// it: the entry would point at the debug binary.

import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { SESSION_MODELS } from "../../util/models";
import { setDuckSettings, setInterrupt, type DuckState } from "./duckState";

export default function DrawerSettings({ duck }: { duck: DuckState }) {
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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "4px 12px",
      }}
    >
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
      {duck.settings && (
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
                (off: only answering prompts, interrupting, stopping and note
                rewrites ask)
              </span>
            </span>
          </label>
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
        </>
      )}
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
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
    </div>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  cursor: "pointer",
  lineHeight: 1.45,
};

const hint: React.CSSProperties = { color: "var(--wb-textFaint)" };
