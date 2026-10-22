// Project toolbar (step K1) — the active project's plugins, in the title bar left
// of palette / templates / layout. Each plugin is a group of its fields (select,
// text, checkbox) and buttons; a button runs its action in a task panel and shows
// how the run is going: a spinner while it runs (■ stop for a long action), then
// ✓ or ✗ with the exit code for a minute. Groups that don't fit fold into "▾ more".
// A file with problems shows a single "⚠ plugins" item instead.
//
// What's drawn comes from the project's `plugins.json` as the backend parsed it,
// re-read whenever the file changes. Nothing here runs a command: a button names
// its action and the fields' values, and the backend does the rest.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { GLYPH, Spinner } from "../theme";
import Modal from "./InstanceManager/Modal";
import { registerCommand } from "../keyboard/bus";
import type { Control, Plugin, PluginAction, PluginsView } from "../ipc/plugins";
import { useActiveProject } from "../state/activeProject";
import { loadPlugins, setFieldValue, storedValues, usePluginsState } from "../state/plugins";
import {
  blockingFields,
  fieldValue,
  itemsOf,
  patternOk,
  taskIdFor,
  type FieldValue,
} from "../state/pluginModel";
import { isLive, useTasks, type TaskSession } from "../state/tasks";
import { answerQuestion, editPlugins, runPluginAction, stopTask, useQuestion } from "./pluginRun";

/** How long a finished run's ✓ / ✗ stays on its button. */
const RESULT_MS = 60_000;

/** Room the centered project name keeps when the toolbar grows. */
const CONTEXT_MIN = 120;

/** Width reserved for the "▾ more" button and the separator. */
const MORE_W = 74;
const SEP_W = 17;

/** The space between groups. */
const GROUP_GAP = 10;

export default function ProjectToolbar() {
  const projectId = useActiveProject();
  const { views, values } = usePluginsState();
  const view = projectId ? views[projectId] : undefined;

  useEffect(() => {
    if (projectId) void loadPlugins(projectId);
  }, [projectId]);

  useEffect(
    () =>
      registerCommand("pluginsReload", () => {
        if (projectId) void loadPlugins(projectId);
      }),
    [projectId],
  );
  useEffect(
    () =>
      registerCommand("pluginsEdit", () => {
        if (projectId) void editPlugins(projectId);
      }),
    [projectId],
  );

  let body: ReactNode = null;
  if (projectId && view) {
    if (view.problems.length > 0) {
      body = (
        <>
          <ProblemsButton projectId={projectId} view={view} />
          <Separator />
        </>
      );
    } else if (view.file && view.file.plugins.length > 0) {
      body = <Groups projectId={projectId} plugins={view.file.plugins} values={values[projectId] ?? {}} />;
    }
  }
  return (
    <>
      {body}
      <ConfirmHost />
    </>
  );
}

/**
 * The groups that fit, then "▾ more" with the rest. Every group is also drawn in an
 * invisible row to measure it; the room there is is the title bar's width less its
 * other items and what the project name keeps.
 */
function Groups({
  projectId,
  plugins,
  values,
}: {
  projectId: string;
  plugins: Plugin[];
  values: Record<string, FieldValue>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(plugins.length);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const bar = root?.parentElement;
    if (!root || !bar) return;
    const measure = () => {
      let others = 0;
      for (const child of Array.from(bar.children) as HTMLElement[]) {
        if (child === root || child.dataset.wbTitlebarFlex !== undefined) continue;
        const cs = getComputedStyle(child);
        others += child.offsetWidth + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
      }
      const budget = bar.clientWidth - others - CONTEXT_MIN;
      const widths = Array.from(measureRef.current?.children ?? []).map(
        (el) => (el as HTMLElement).offsetWidth + GROUP_GAP,
      );
      const total = widths.reduce((a, b) => a + b, 0) + SEP_W;
      if (total <= budget) {
        setFit(widths.length);
        return;
      }
      let used = SEP_W + MORE_W;
      let n = 0;
      while (n < widths.length && used + widths[n] <= budget) used += widths[n++];
      setFit(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => ro.disconnect();
  }, [plugins, values]);

  const group = (p: Plugin) => (
    <Group key={p.id} projectId={projectId} plugin={p} values={storedValues(projectId, p.id)} />
  );
  const shown = plugins.slice(0, fit);
  const folded = plugins.slice(fit);
  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "center", flex: "0 0 auto", marginRight: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: GROUP_GAP }}>{shown.map(group)}</div>
      {folded.length > 0 && <MoreMenu>{folded.map(group)}</MoreMenu>}
      <Separator />
      <div
        ref={measureRef}
        aria-hidden
        inert
        // Off screen and inert, but laid out at full size.
        style={{ position: "fixed", left: -10000, top: 0, visibility: "hidden", pointerEvents: "none", display: "flex", gap: 0 }}
      >
        {plugins.map(group)}
      </div>
    </div>
  );
}

function Separator() {
  return <span style={{ color: "var(--wb-textFaint)", fontSize: 11, padding: "0 8px 0 4px" }}>│</span>;
}

function Group({ projectId, plugin, values }: { projectId: string; plugin: Plugin; values: Record<string, FieldValue> }) {
  const blocked = blockingFields(plugin, values);
  const items = itemsOf(plugin);
  // Enter in a text field runs the plugin's first action.
  const firstAction = plugin.actions[0];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "0 0 auto", whiteSpace: "nowrap" }}>
      {plugin.label && (
        <span style={{ color: "var(--wb-textFaint)", font: "10.5px var(--wb-mono)", marginRight: 2 }}>{plugin.label}</span>
      )}
      {items.map((item) =>
        item.kind === "field" ? (
          <Field
            key={`f:${item.control.id}`}
            control={item.control}
            value={fieldValue(item.control, values[item.control.id])}
            onChange={(v) => setFieldValue(projectId, plugin.id, item.control.id, v)}
            onEnter={() => {
              if (firstAction && blocked.length === 0) void runPluginAction(projectId, plugin.id, firstAction.id);
            }}
          />
        ) : (
          <ActionButton
            key={`a:${item.action.id}`}
            projectId={projectId}
            plugin={plugin}
            action={item.action}
            blocked={blocked}
          />
        ),
      )}
    </div>
  );
}

const fieldBase: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "2px 5px",
  outline: "none",
  height: 22,
  boxSizing: "border-box",
};

function Field({
  control,
  value,
  onChange,
  onEnter,
}: {
  control: Exclude<Control, { type: "button" }>;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  onEnter: () => void;
}) {
  const label = control.label ?? control.id;
  switch (control.type) {
    case "select":
      return (
        <select
          aria-label={label}
          title={label}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...fieldBase, background: "var(--wb-titlebar)", cursor: "pointer" }}
        >
          {control.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "text": {
      const ok = patternOk(control.pattern, String(value));
      const width = Math.min(160, Math.max(64, ((control.placeholder ?? label).length + 2) * 7));
      return (
        <input
          aria-label={label}
          title={control.pattern ? `${label} — must match ${control.pattern}` : label}
          value={String(value)}
          placeholder={control.placeholder ?? label}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
          }}
          style={{ ...fieldBase, width, borderColor: ok ? "var(--wb-border)" : "var(--wb-needs)" }}
        />
      );
    }
    case "checkbox":
      return (
        <label
          title={label}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, font: "11px var(--wb-mono)", color: "var(--wb-textDim2)", cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            style={{ margin: 0, accentColor: "var(--wb-accent)" }}
          />
          {label}
        </label>
      );
  }
}

/** Re-render every few seconds while some run's result is on show, so it clears
 *  after a minute. */
function useResultClock(tasks: TaskSession[]): number {
  const [now, setNow] = useState(() => Date.now());
  const showing = tasks.some((t) => t.endedAt !== null && now - t.endedAt < RESULT_MS);
  useEffect(() => {
    if (!showing) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [showing]);
  // A run that just ended must show at once, before the next tick.
  return Math.max(now, ...tasks.map((t) => t.endedAt ?? 0));
}

function ActionButton({
  projectId,
  plugin,
  action,
  blocked,
}: {
  projectId: string;
  plugin: Plugin;
  action: PluginAction;
  blocked: string[];
}) {
  const { open } = useTasks();
  const task = open.find((t) => t.taskId === taskIdFor(projectId, plugin.id, action.id));
  const now = useResultClock(task ? [task] : []);
  const [hover, setHover] = useState(false);

  const live = isLive(task);
  const recent = task?.endedAt != null && now - task.endedAt < RESULT_MS;
  const disabled = blocked.length > 0 && !live;

  let glyph: ReactNode = <span style={{ color: "var(--wb-accent)" }}>{GLYPH.run}</span>;
  let text = action.label;
  let state = "";
  if (live && action.long) {
    glyph = <span style={{ color: "var(--wb-needs)" }}>■</span>;
    text = `stop ${action.label}`;
    state = "running — click to stop";
  } else if (live) {
    glyph = <Spinner size={10} />;
    state = "running";
  } else if (recent && task?.status === "exited") {
    glyph =
      task.code === 0 ? (
        <span style={{ color: "var(--wb-done)" }}>{GLYPH.ok}</span>
      ) : (
        <span style={{ color: "var(--wb-needs)" }}>
          {GLYPH.fail} {task.code}
        </span>
      );
    state = `exited ${task.code}`;
  } else if (recent && task?.status === "error") {
    glyph = <span style={{ color: "var(--wb-needs)" }}>{GLYPH.fail}</span>;
    state = task.error ?? "could not start";
  }

  const title = disabled
    ? `${blocked.join(", ")}: the value doesn't match its pattern`
    : [action.run.join(" "), state].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (live && action.long && task) stopTask(task.taskId);
        else void runPluginAction(projectId, plugin.id, action.id);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={text}
      title={title}
      style={{
        ...toolbarButton,
        background: hover && !disabled ? "var(--wb-sel)" : "transparent",
        color: disabled ? "var(--wb-textFaint)" : hover ? "var(--wb-accent)" : "var(--wb-textDim2)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {glyph}
      {text}
    </button>
  );
}

/** The groups that didn't fit, in a menu under the button. */
function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
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
  const r = buttonRef.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="more plugins"
        style={{ ...toolbarButton, marginLeft: GROUP_GAP, background: open ? "var(--wb-sel)" : "transparent" }}
      >
        ▾ more
      </button>
      {open && r && (
        <div
          ref={menuRef}
          style={{
            ...popover,
            top: r.bottom + 4,
            right: Math.max(8, window.innerWidth - r.right),
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          {children}
        </div>
      )}
    </>
  );
}

/** A broken file: one item that opens the file and lists what's wrong. */
function ProblemsButton({ projectId, view }: { projectId: string; view: PluginsView }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const r = buttonRef.current?.getBoundingClientRect();
  const n = view.problems.length;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen(true);
          void editPlugins(projectId);
        }}
        title={`${n} ${n === 1 ? "problem" : "problems"} in ${view.path}`}
        style={{ ...toolbarButton, marginRight: 6, color: "var(--wb-needs)" }}
      >
        {GLYPH.warn} plugins
      </button>
      {open && r && (
        <div ref={menuRef} style={{ ...popover, top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right), maxWidth: 560 }}>
          <div style={{ color: "var(--wb-textDim2)", marginBottom: 6 }}>
            {n} {n === 1 ? "problem" : "problems"} in plugins.json — the toolbar is off until they're fixed
          </div>
          {view.problems.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
              <span style={{ color: "var(--wb-accent)", flex: "0 0 auto" }}>{p.path || "(file)"}</span>
              <span style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap" }}>{p.message}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Answers the questions `askConfirm` asks (a `confirm` action, a re-run). */
function ConfirmHost() {
  const q = useQuestion();
  if (!q) return null;
  return (
    <Modal title="run" onClose={() => answerQuestion(false)} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, font: "12px var(--wb-mono)" }}>
        <div style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap" }}>{q.text}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={() => answerQuestion(false)} style={dialogButton}>
            cancel
          </button>
          <button
            type="button"
            onClick={() => answerQuestion(true)}
            style={{ ...dialogButton, color: "var(--wb-accent)", borderColor: "var(--wb-borderActive)" }}
          >
            {GLYPH.run} {q.yes}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const toolbarButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-textDim2)",
  font: "11px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 8px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const popover: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  background: "var(--wb-panel)",
  border: "1px solid var(--wb-borderActive)",
  padding: "10px 12px",
  font: "11px var(--wb-mono)",
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
};

const dialogButton: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "5px 12px",
  font: "11.5px var(--wb-mono)",
  cursor: "pointer",
};
