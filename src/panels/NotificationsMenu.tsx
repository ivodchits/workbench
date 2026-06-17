// Notifications menu (step 4.6, design §7) — the status-bar control for where
// "needs you" alerts go and when a waiting/working card escalates. Mirrors the
// RemoteAccessMenu's upward popover so it sits naturally in the status bar.
//
// The engine + persistence live in `state/notifications.ts`; this is purely the
// control surface over its config store. A webhook route (Discord/Slack/ntfy) is a
// planned addition — when it lands it becomes a third toggle + a URL field here.

import { useEffect, useRef, useState } from "react";
import {
  setNotificationConfig,
  useNotificationConfig,
} from "../state/notifications";

function NotificationsMenu() {
  const config = useNotificationConfig();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const routeCount = (config.desktop ? 1 : 0) + (config.phone ? 1 : 0);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="notification routing & escalation"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          font: "10.5px var(--wb-mono)",
          color: routeCount > 0 ? "var(--wb-textDim2)" : "var(--wb-textFaint)",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{ color: routeCount > 0 ? "var(--wb-accent)" : "var(--wb-textFaint)" }}>
          ◔
        </span>
        alerts {routeCount > 0 ? `${config.escalateAfterMin}m` : "off"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 22,
            left: 0,
            zIndex: 200,
            width: 300,
            background: "var(--wb-panel)",
            border: "1px solid var(--wb-border)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55)",
            padding: "10px 0",
            font: "11px var(--wb-mono)",
          }}
        >
          <SectionLabel>notification routing</SectionLabel>
          <Toggle
            label="desktop"
            hint="OS toast on needs-you + escalation"
            on={config.desktop}
            onToggle={() => void setNotificationConfig({ desktop: !config.desktop })}
          />
          <Toggle
            label="phone dashboard"
            hint="escalation cues on the tailnet companion"
            on={config.phone}
            onToggle={() => void setNotificationConfig({ phone: !config.phone })}
          />

          <Divider />
          <SectionLabel>escalation</SectionLabel>
          <NumberRow
            label="needs-you after"
            suffix="min → louder re-ping"
            value={config.escalateAfterMin}
            onChange={(n) => void setNotificationConfig({ escalateAfterMin: n })}
          />
          <NumberRow
            label="working after"
            suffix="min → flag possibly stuck"
            value={config.stuckAfterMin}
            onChange={(n) => void setNotificationConfig({ stuckAfterMin: n })}
          />
          <Note>
            “Stuck” uses a fixed threshold, not a learned per-agent baseline. Desktop
            alerts need OS notification permission for Workbench.
          </Note>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Row>
      <span style={{ display: "flex", flexDirection: "column", flex: 1, gap: 1 }}>
        <span style={{ color: "var(--wb-text)" }}>{label}</span>
        <span style={{ color: "var(--wb-textFaint)", fontSize: 9.5 }}>{hint}</span>
      </span>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: "transparent",
          border: "1px solid var(--wb-border)",
          color: on ? "var(--wb-accent)" : "var(--wb-textFaint)",
          font: "10.5px var(--wb-mono)",
          cursor: "pointer",
          padding: "2px 10px",
          minWidth: 42,
        }}
      >
        {on ? "on" : "off"}
      </button>
    </Row>
  );
}

function NumberRow({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Row>
      <span style={{ color: "var(--wb-text)", flex: 1 }}>{label}</span>
      <input
        type="number"
        min={1}
        max={999}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n) && n >= 1) onChange(Math.min(999, n));
        }}
        style={{
          width: 46,
          background: "var(--wb-bg)",
          border: "1px solid var(--wb-border)",
          color: "var(--wb-text)",
          font: "10.5px var(--wb-mono)",
          padding: "2px 6px",
          textAlign: "right",
        }}
      />
      <span style={{ color: "var(--wb-textFaint)", fontSize: 9.5, width: 118 }}>{suffix}</span>
    </Row>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "var(--wb-textFaint)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontSize: 9.5,
        padding: "2px 12px 4px",
      }}
    >
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px" }}>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "var(--wb-textFaint)",
        padding: "4px 12px 2px",
        fontSize: 10,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid var(--wb-border)", margin: "6px 0" }} />;
}

export default NotificationsMenu;
