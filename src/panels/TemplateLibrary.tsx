// Prompt template library (step 3.4) — browse, create, edit, and insert reusable
// prompts with positional `{0}`/`{1}` fill-ins (design §7). Opened with
// Ctrl+Shift+P (or the future command palette). One modal with three modes:
//
//   • list    — global + active-project templates, grouped; insert / edit / delete.
//   • compose — create or edit a template (name, scope, body).
//   • fill    — a chosen template's placeholders → one field each, with a live
//               preview, then insert (or insert & send) into a live console.
//
// Keyboard-first (design §1, §5.y): the modal steals focus on open and traps it,
// and every action has a binding. List mode uses bare TUI keys (like the rail);
// the form modes — which contain text fields — use chords + Esc.
//
//   list     ↑/↓ or j/k select · ←/→ destination · Enter insert · Shift+Enter send
//            · e edit · d/Delete delete (y/Enter confirm, n/Esc cancel) · n new · Esc close
//   compose  Tab between fields · Ctrl+Enter save · Esc back
//   fill     Tab between fields · Ctrl+Enter insert · Ctrl+Shift+Enter send · Esc back
//
// Insertion routes a resolved prompt into the target console as a bracketed paste
// (`pasteIntoTerminal`, multi-line safe) and, for "& send", writes a trailing `\r`
// to submit it. Per the project decision, a template is authored in the composer
// (no scraping of the xterm screen), and the default action inserts without
// sending so you can review before submitting.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { GLYPH } from "../theme";
import Modal from "./InstanceManager/Modal";
import { ptyWrite } from "../ipc/pty";
import { pasteIntoTerminal } from "./terminalPool";
import { useActiveProject } from "../state/activeProject";
import { useConsoles } from "../state/consoles";
import { useRegistry } from "../state/registry";
import { registerCommand } from "../keyboard/bus";
import {
  deleteTemplate,
  extractPlaceholders,
  fillTemplate,
  loadTemplatesFor,
  saveTemplate,
  updateTemplate,
  useTemplates,
  type PromptTemplate,
  type TemplateScope,
} from "../state/templates";

/** Always-mounted host: keeps the active project's templates loaded and opens the
 *  modal on the `openTemplates` command (Ctrl+Shift+P). Mounted once from App. */
export default function TemplateLibraryHost() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useActiveProject();

  // Keep the store in sync with the project on screen so the library is ready the
  // instant it opens (and the chips reflect the right project's set).
  useEffect(() => {
    void loadTemplatesFor(activeProjectId);
  }, [activeProjectId]);

  useEffect(() => registerCommand("openTemplates", () => setOpen(true)), []);

  if (!open) return null;
  return <TemplateLibrary onClose={() => setOpen(false)} />;
}

type Mode =
  | { kind: "list" }
  | { kind: "compose"; editing: PromptTemplate | null }
  | { kind: "fill"; template: PromptTemplate };

function TemplateLibrary({ onClose }: { onClose: () => void }) {
  const { global, project } = useTemplates();
  const activeProjectId = useActiveProject();
  const { projects, instances } = useRegistry();
  const { open: consoles, activeId } = useConsoles();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const projectName = projects.find((p) => p.id === activeProjectId)?.name ?? null;

  // Only a live (running) console can receive an inserted prompt.
  const runningConsoles = useMemo(
    () => consoles.filter((c) => c.status === "running"),
    [consoles],
  );
  const targetIds = useMemo(() => runningConsoles.map((c) => c.instanceId), [runningConsoles]);

  // Default the target to the focused console when it's running, else the first.
  const [targetId, setTargetId] = useState<string | null>(null);
  const effectiveTarget =
    (targetId && targetIds.includes(targetId) && targetId) ||
    (activeId && targetIds.includes(activeId) && activeId) ||
    targetIds[0] ||
    null;

  const cycleTarget = (dir: 1 | -1) => {
    if (targetIds.length === 0) return;
    const cur = effectiveTarget ? targetIds.indexOf(effectiveTarget) : 0;
    const next = (cur + dir + targetIds.length) % targetIds.length;
    setTargetId(targetIds[next]);
  };

  const instanceTitle = (id: string) =>
    instances.find((i) => i.id === id)?.title ?? id.slice(0, 8);

  /** Land `text` in the target console; optionally submit it with a trailing CR. */
  const doInsert = (text: string, send: boolean) => {
    if (!effectiveTarget) return;
    if (!pasteIntoTerminal(effectiveTarget, text)) return;
    if (send) void ptyWrite(effectiveTarget, new TextEncoder().encode("\r"));
    onClose();
  };

  /** Insert a template directly, or open the fill-in form if it has placeholders. */
  const insert = (t: PromptTemplate, send: boolean) => {
    if (extractPlaceholders(t.body).length > 0) {
      setMode({ kind: "fill", template: t });
      return;
    }
    doInsert(t.body, send);
  };

  const title =
    mode.kind === "compose"
      ? mode.editing
        ? "edit template"
        : "new template"
      : mode.kind === "fill"
        ? `fill · ${mode.template.name}`
        : "prompt templates";

  return (
    <Modal title={title} onClose={onClose} width={mode.kind === "list" ? 560 : 520}>
      {mode.kind === "compose" ? (
        <Composer
          editing={mode.editing}
          canProject={activeProjectId !== null}
          projectName={projectName}
          onDone={() => setMode({ kind: "list" })}
        />
      ) : mode.kind === "fill" ? (
        <FillForm
          template={mode.template}
          target={effectiveTarget}
          targetTitle={effectiveTarget ? instanceTitle(effectiveTarget) : null}
          onInsert={doInsert}
          onBack={() => setMode({ kind: "list" })}
        />
      ) : (
        <List
          global={global}
          project={project}
          projectName={projectName}
          target={effectiveTarget}
          targetTitle={effectiveTarget ? instanceTitle(effectiveTarget) : null}
          targetCount={targetIds.length}
          targetIndex={effectiveTarget ? targetIds.indexOf(effectiveTarget) : -1}
          onCycleTarget={cycleTarget}
          onInsert={insert}
          onEdit={(t) => setMode({ kind: "compose", editing: t })}
          onDelete={(t) => void deleteTemplate(t.id)}
          onNew={() => setMode({ kind: "compose", editing: null })}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

// --- list mode --------------------------------------------------------------

function List({
  global,
  project,
  projectName,
  target,
  targetTitle,
  targetCount,
  targetIndex,
  onCycleTarget,
  onInsert,
  onEdit,
  onDelete,
  onNew,
  onClose,
}: {
  global: PromptTemplate[];
  project: PromptTemplate[];
  projectName: string | null;
  target: string | null;
  targetTitle: string | null;
  targetCount: number;
  targetIndex: number;
  onCycleTarget: (dir: 1 | -1) => void;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onDelete: (t: PromptTemplate) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const all = useMemo(() => [...global, ...project], [global, project]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(all[0]?.id ?? null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Steal focus into the list on open so the keyboard works immediately, and keep
  // it here after any mouse action changes selection/confirm state.
  useEffect(() => {
    rootRef.current?.focus();
  }, [selectedId, confirmId]);

  // Keep the selection valid as the set changes (e.g. after a delete): fall back to
  // the nearest still-present template.
  const selectedIndex = all.findIndex((t) => t.id === selectedId);
  useEffect(() => {
    if (all.length === 0) {
      if (selectedId !== null) setSelectedId(null);
    } else if (selectedIndex === -1) {
      setSelectedId(all[Math.min(Math.max(0, selectedIndex), all.length - 1)]?.id ?? all[0].id);
    }
  }, [all, selectedId, selectedIndex]);

  const move = (dir: 1 | -1) => {
    if (all.length === 0) return;
    const cur = selectedIndex === -1 ? 0 : selectedIndex;
    const next = Math.min(all.length - 1, Math.max(0, cur + dir));
    setSelectedId(all[next].id);
  };

  const selected = all[selectedIndex] ?? null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The destination dropdown / confirm flow aside, list keys never need a
    // modifier — but Ctrl/Alt/Meta combos belong to the global keymap, so let those
    // pass through (they're captured upstream anyway).
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;

    if (confirmId) {
      if (plain && (e.key === "y" || e.key === "Y" || e.key === "Enter")) {
        const t = all.find((x) => x.id === confirmId);
        if (t) onDelete(t);
        setConfirmId(null);
      } else if (e.key === "Escape" || (plain && (e.key === "n" || e.key === "N"))) {
        setConfirmId(null);
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "j":
      case "k":
        if (!plain) return;
        move(e.key === "j" ? 1 : -1);
        break;
      case "ArrowRight":
        onCycleTarget(1);
        break;
      case "ArrowLeft":
        onCycleTarget(-1);
        break;
      case "Enter":
        if (selected) onInsert(selected, e.shiftKey);
        else handled = false;
        break;
      case "e":
        if (!plain) return;
        if (selected) onEdit(selected);
        break;
      case "d":
      case "Delete":
        if (e.key === "d" && !plain) return;
        if (selected) setConfirmId(selected.id);
        break;
      case "n":
        if (!plain) return;
        onNew();
        break;
      case "Escape":
        onClose();
        break;
      case "Tab":
        // No text fields in list mode and the destination uses ←/→, so trap Tab
        // here rather than let focus leak to the background behind the modal.
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const empty = all.length === 0;

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: "none", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={labelStyle}>insert into</span>
        {targetCount === 0 ? (
          <span style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
            no running console — launch an agent first
          </span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 6, font: "12px var(--wb-mono)" }}>
            <Chevron dir={-1} onClick={() => onCycleTarget(-1)} disabled={targetCount < 2} />
            <span style={{ color: "var(--wb-text)" }} title="← / → to switch console">
              {targetTitle}
            </span>
            {targetCount > 1 && (
              <span style={{ color: "var(--wb-textFaint)", font: "10px var(--wb-mono)" }}>
                {targetIndex + 1}/{targetCount}
              </span>
            )}
            <Chevron dir={1} onClick={() => onCycleTarget(1)} disabled={targetCount < 2} />
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "46vh", overflowY: "auto" }}>
        {empty && (
          <div style={{ font: "11.5px var(--wb-mono)", color: "var(--wb-textFaint)", padding: "8px 2px" }}>
            no templates yet — press <Kbd>n</Kbd> to create one.
          </div>
        )}
        <Group
          label="global"
          templates={global}
          selectedId={selectedId}
          confirmId={confirmId}
          target={target}
          onSelect={setSelectedId}
          onInsert={onInsert}
          onEdit={onEdit}
          onBeginDelete={setConfirmId}
          onConfirmDelete={(t) => {
            onDelete(t);
            setConfirmId(null);
          }}
          onCancelDelete={() => setConfirmId(null)}
        />
        {projectName && (
          <Group
            label={projectName}
            templates={project}
            selectedId={selectedId}
            confirmId={confirmId}
            target={target}
            onSelect={setSelectedId}
            onInsert={onInsert}
            onEdit={onEdit}
            onBeginDelete={setConfirmId}
            onConfirmDelete={(t) => {
              onDelete(t);
              setConfirmId(null);
            }}
            onCancelDelete={() => setConfirmId(null)}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderTop: "1px solid var(--wb-border)",
          paddingTop: 10,
          font: "10px var(--wb-mono)",
          color: "var(--wb-textFaint)",
          flexWrap: "wrap",
        }}
      >
        <Hint k="↑↓ jk" v="select" />
        <Hint k="←→" v="console" />
        <Hint k="↵" v="insert" />
        <Hint k="⇧↵" v="send" />
        <Hint k="e" v="edit" />
        <Hint k="d" v="delete" />
        <Hint k="n" v="new" />
        <Hint k="esc" v="close" />
      </div>
    </div>
  );
}

function Group({
  label,
  templates,
  selectedId,
  confirmId,
  target,
  onSelect,
  onInsert,
  onEdit,
  onBeginDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  label: string;
  templates: PromptTemplate[];
  selectedId: string | null;
  confirmId: string | null;
  target: string | null;
  onSelect: (id: string) => void;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onBeginDelete: (id: string) => void;
  onConfirmDelete: (t: PromptTemplate) => void;
  onCancelDelete: () => void;
}) {
  if (templates.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ ...labelStyle, color: "var(--wb-accent)" }}>{label}</span>
      {templates.map((t) => (
        <Row
          key={t.id}
          t={t}
          selected={t.id === selectedId}
          confirming={t.id === confirmId}
          target={target}
          onSelect={() => onSelect(t.id)}
          onInsert={onInsert}
          onEdit={onEdit}
          onBeginDelete={() => onBeginDelete(t.id)}
          onConfirmDelete={() => onConfirmDelete(t)}
          onCancelDelete={onCancelDelete}
        />
      ))}
    </div>
  );
}

function Row({
  t,
  selected,
  confirming,
  target,
  onSelect,
  onInsert,
  onEdit,
  onBeginDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  t: PromptTemplate;
  selected: boolean;
  confirming: boolean;
  target: string | null;
  onSelect: () => void;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onBeginDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const placeholders = extractPlaceholders(t.body);
  const preview = t.body.replace(/\s+/g, " ").trim();
  const canInsert = target !== null;

  // Keep the selected row in view as ↑/↓ moves through a long list.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={rowRef}
      onMouseDown={(e) => {
        // Keep keyboard focus on the list root (don't let the row steal it).
        e.preventDefault();
        onSelect();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        border: `1px solid ${selected ? "var(--wb-borderActive)" : "var(--wb-border)"}`,
        borderLeft: `2px solid ${selected ? "var(--wb-selBar)" : "transparent"}`,
        background: selected ? "var(--wb-sel)" : "var(--wb-bg)",
        cursor: "pointer",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ font: "600 12.5px var(--wb-mono)", color: "var(--wb-text)" }}>{t.name}</span>
          {placeholders.length > 0 && (
            <span
              title={`${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"}`}
              style={{ font: "10px var(--wb-mono)", color: "var(--wb-accent)" }}
            >
              {`{${placeholders.join("} {")}}`}
            </span>
          )}
        </div>
        <div
          style={{
            font: "11px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 2,
          }}
        >
          {preview}
        </div>
      </div>

      {confirming ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-needs)" }}>delete?</span>
          <IconButton title="confirm (y)" onClick={onConfirmDelete} color="var(--wb-needs)">
            {GLYPH.ok}
          </IconButton>
          <IconButton title="cancel (n)" onClick={onCancelDelete}>
            {GLYPH.fail}
          </IconButton>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto" }}>
          {placeholders.length > 0 ? (
            <ActionButton enabled={canInsert} title="fill placeholders and insert" onClick={() => onInsert(t, false)}>
              {GLYPH.run} fill…
            </ActionButton>
          ) : (
            <>
              <ActionButton enabled={canInsert} title="insert (review before sending)" onClick={() => onInsert(t, false)}>
                {GLYPH.run} insert
              </ActionButton>
              <ActionButton enabled={canInsert} title="insert and submit" onClick={() => onInsert(t, true)}>
                ↵ send
              </ActionButton>
            </>
          )}
          <IconButton title="edit (e)" onClick={() => onEdit(t)}>
            ✎
          </IconButton>
          <IconButton title="delete (d)" onClick={onBeginDelete}>
            ✕
          </IconButton>
        </div>
      )}
    </div>
  );
}

// --- compose mode (create / edit) -------------------------------------------

function Composer({
  editing,
  canProject,
  projectName,
  onDone,
}: {
  editing: PromptTemplate | null;
  canProject: boolean;
  projectName: string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  // A new template defaults to project scope when a project is active (the common
  // case is a project-specific prompt), else global.
  const [scope, setScope] = useState<TemplateScope>(
    editing?.scope ?? (canProject ? "project" : "global"),
  );
  const [body, setBody] = useState(editing?.body ?? "");

  const placeholders = extractPlaceholders(body);
  const canSave = name.trim().length > 0 && body.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    if (editing) void updateTemplate(editing.id, { name, body, scope });
    else void saveTemplate({ name, body, scope });
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  };

  return (
    <div onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <Field label="name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="template name"
          spellCheck={false}
          autoFocus
          style={inputStyle}
        />
      </Field>

      <Field label="scope">
        <select value={scope} onChange={(e) => setScope(e.target.value as TemplateScope)} style={inputStyle}>
          <option value="global">global — every project</option>
          <option value="project" disabled={!canProject}>
            {projectName ? `project — ${projectName}` : "project (no project selected)"}
          </option>
        </select>
      </Field>

      <Field label="prompt">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={"the prompt body — use {0}, {1}, … for fill-ins\ne.g. Review {0} for {1} bugs and propose fixes."}
          spellCheck={false}
          rows={7}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", marginTop: 4 }}>
          {placeholders.length > 0
            ? `placeholders: ${placeholders.map((n) => `{${n}}`).join(" ")} — you'll fill these on insert`
            : "tip: add {0}, {1}, … to prompt for values when you insert this"}
        </span>
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
        <span style={{ flex: 1, font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
          <Kbd>⌃↵</Kbd> save · <Kbd>esc</Kbd> back
        </span>
        <button onClick={onDone} style={buttonStyle}>
          cancel
        </button>
        <button
          onClick={save}
          disabled={!canSave}
          style={{
            ...buttonStyle,
            borderColor: "var(--wb-borderActive)",
            color: canSave ? "var(--wb-text)" : "var(--wb-textFaint)",
            opacity: canSave ? 1 : 0.6,
          }}
        >
          {GLYPH.ok} {editing ? "save" : "create"}
        </button>
      </div>
    </div>
  );
}

// --- fill mode (resolve placeholders, then insert) --------------------------

function FillForm({
  template,
  target,
  targetTitle,
  onInsert,
  onBack,
}: {
  template: PromptTemplate;
  target: string | null;
  targetTitle: string | null;
  onInsert: (text: string, send: boolean) => void;
  onBack: () => void;
}) {
  const placeholders = useMemo(() => extractPlaceholders(template.body), [template.body]);
  const [values, setValues] = useState<Record<number, string>>({});
  const resolved = fillTemplate(template.body, values);
  const canInsert = target !== null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (canInsert) onInsert(resolved, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  return (
    <div onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {placeholders.map((n, i) => (
          <Field key={n} label={`{${n}}`}>
            <input
              value={values[n] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
              spellCheck={false}
              autoFocus={i === 0}
              placeholder={`value for {${n}}`}
              style={inputStyle}
            />
          </Field>
        ))}
      </div>

      <Field label="preview">
        <div
          style={{
            background: "var(--wb-bg)",
            border: "1px solid var(--wb-border)",
            padding: "8px 10px",
            font: "12px/1.5 var(--wb-mono)",
            color: "var(--wb-text)",
            whiteSpace: "pre-wrap",
            maxHeight: "30vh",
            overflowY: "auto",
          }}
        >
          {resolved}
        </div>
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ font: "10px var(--wb-mono)", color: "var(--wb-textFaint)", flex: 1 }}>
          {canInsert ? (
            <>
              → {targetTitle} · <Kbd>⌃↵</Kbd> insert · <Kbd>⌃⇧↵</Kbd> send
            </>
          ) : (
            "no running console to insert into"
          )}
        </span>
        <button onClick={onBack} style={buttonStyle}>
          back
        </button>
        <button onClick={() => onInsert(resolved, false)} disabled={!canInsert} style={actionButtonStyle(canInsert)}>
          {GLYPH.run} insert
        </button>
        <button
          onClick={() => onInsert(resolved, true)}
          disabled={!canInsert}
          style={{ ...actionButtonStyle(canInsert), borderColor: "var(--wb-borderActive)" }}
        >
          ↵ insert & send
        </button>
      </div>
    </div>
  );
}

// --- shared bits ------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

/** A small inline keycap, for the hint rows. */
function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--wb-accent)" }}>{children}</span>;
}

function Hint({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <Kbd>{k}</Kbd> {v}
    </span>
  );
}

/** A non-focusable chevron for the destination switcher (mouse parity with ←/→). */
function Chevron({ dir, onClick, disabled }: { dir: 1 | -1; onClick: () => void; disabled: boolean }) {
  return (
    <button
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      style={{
        ...iconButtonStyle,
        color: disabled ? "var(--wb-textFaint)" : "var(--wb-textDim2)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {dir === -1 ? "‹" : "›"}
    </button>
  );
}

/** Buttons in the list don't steal focus from the list root (preventDefault on
 *  mousedown) so the keyboard stays live after a click. */
function ActionButton({
  enabled,
  title,
  onClick,
  children,
}: {
  enabled: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      tabIndex={-1}
      disabled={!enabled}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        if (enabled) onClick();
      }}
      style={actionButtonStyle(enabled)}
    >
      {children}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  color,
  children,
}: {
  title: string;
  onClick: () => void;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      tabIndex={-1}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      style={{ ...iconButtonStyle, ...(color ? { color } : null) }}
    >
      {children}
    </button>
  );
}

const labelStyle: CSSProperties = {
  font: "600 10px var(--wb-mono)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--wb-textDim2)",
};

const inputStyle: CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 8px",
  fontFamily: "var(--wb-mono)",
  fontSize: 12.5,
};

const buttonStyle: CSSProperties = {
  background: "var(--wb-titlebar)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  padding: "6px 12px",
  fontFamily: "var(--wb-mono)",
  fontSize: 11.5,
  cursor: "pointer",
};

function actionButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...buttonStyle,
    padding: "4px 9px",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.5,
    color: enabled ? "var(--wb-text)" : "var(--wb-textFaint)",
  };
}

const iconButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wb-textFaint)",
  font: "12px var(--wb-mono)",
  cursor: "pointer",
  padding: "2px 4px",
  lineHeight: 1,
};
