// Prompt template library (step 3.4) — browse, create, edit, and insert reusable
// prompts with positional `{0}`/`{1}` fill-ins (design §7). Opened with
// Ctrl+Shift+P (or the future command palette). One modal with three modes:
//
//   • list    — global + active-project templates, grouped; insert / edit / delete.
//   • compose — create or edit a template (name, scope, body).
//   • fill    — a chosen template's placeholders → one field each, with a live
//               preview, then insert (or insert & send) into a live console.
//
// Insertion routes a resolved prompt into the target console as a bracketed paste
// (`pasteIntoTerminal`, multi-line safe) and, for "& send", writes a trailing `\r`
// to submit it. Per the project decision, a template is authored in the composer
// (no scraping of the xterm screen), and the default action inserts without
// sending so you can review before submitting.

import { useEffect, useMemo, useState, type CSSProperties } from "react";

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

  // Only a live (running) console can receive an inserted prompt. Default the
  // target to the focused console when it's running, else the first running one.
  const runningConsoles = useMemo(
    () => consoles.filter((c) => c.status === "running"),
    [consoles],
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const effectiveTarget =
    (targetId && runningConsoles.some((c) => c.instanceId === targetId) && targetId) ||
    (activeId && runningConsoles.some((c) => c.instanceId === activeId) && activeId) ||
    runningConsoles[0]?.instanceId ||
    null;

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
    <Modal title={title} onClose={onClose} width={mode.kind === "compose" ? 520 : 560}>
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
          runningConsoles={runningConsoles.map((c) => ({
            id: c.instanceId,
            title: instanceTitle(c.instanceId),
          }))}
          target={effectiveTarget}
          onTargetChange={setTargetId}
          onInsert={insert}
          onEdit={(t) => setMode({ kind: "compose", editing: t })}
          onDelete={(t) => void deleteTemplate(t.id)}
          onNew={() => setMode({ kind: "compose", editing: null })}
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
  runningConsoles,
  target,
  onTargetChange,
  onInsert,
  onEdit,
  onDelete,
  onNew,
}: {
  global: PromptTemplate[];
  project: PromptTemplate[];
  projectName: string | null;
  runningConsoles: { id: string; title: string }[];
  target: string | null;
  onTargetChange: (id: string) => void;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onDelete: (t: PromptTemplate) => void;
  onNew: () => void;
}) {
  const empty = global.length === 0 && project.length === 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={labelStyle}>insert into</span>
        {runningConsoles.length === 0 ? (
          <span style={{ font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
            no running console — launch an agent first
          </span>
        ) : (
          <select
            value={target ?? ""}
            onChange={(e) => onTargetChange(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          >
            {runningConsoles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxHeight: "46vh",
          overflowY: "auto",
        }}
      >
        {empty && (
          <div style={{ font: "11.5px var(--wb-mono)", color: "var(--wb-textFaint)", padding: "8px 2px" }}>
            no templates yet — create one with ＋ below.
          </div>
        )}
        <Group label="global" templates={global} target={target} onInsert={onInsert} onEdit={onEdit} onDelete={onDelete} />
        {projectName && (
          <Group
            label={projectName}
            templates={project}
            target={target}
            onInsert={onInsert}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid var(--wb-border)", paddingTop: 12 }}>
        <button onClick={onNew} style={{ ...buttonStyle, borderColor: "var(--wb-borderActive)" }}>
          ＋ new template
        </button>
      </div>
    </div>
  );
}

function Group({
  label,
  templates,
  target,
  onInsert,
  onEdit,
  onDelete,
}: {
  label: string;
  templates: PromptTemplate[];
  target: string | null;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onDelete: (t: PromptTemplate) => void;
}) {
  if (templates.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ ...labelStyle, color: "var(--wb-accent)" }}>{label}</span>
      {templates.map((t) => (
        <Row key={t.id} t={t} target={target} onInsert={onInsert} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}

function Row({
  t,
  target,
  onInsert,
  onEdit,
  onDelete,
}: {
  t: PromptTemplate;
  target: string | null;
  onInsert: (t: PromptTemplate, send: boolean) => void;
  onEdit: (t: PromptTemplate) => void;
  onDelete: (t: PromptTemplate) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const placeholders = extractPlaceholders(t.body);
  const preview = t.body.replace(/\s+/g, " ").trim();
  const canInsert = target !== null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        border: "1px solid var(--wb-border)",
        background: "var(--wb-bg)",
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

      {confirmDelete ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-needs)" }}>delete?</span>
          <button onClick={() => onDelete(t)} style={{ ...iconButtonStyle, color: "var(--wb-needs)" }}>
            {GLYPH.ok}
          </button>
          <button onClick={() => setConfirmDelete(false)} style={iconButtonStyle}>
            {GLYPH.fail}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto" }}>
          {placeholders.length > 0 ? (
            <button
              onClick={() => onInsert(t, false)}
              disabled={!canInsert}
              title="fill placeholders and insert"
              style={actionButtonStyle(canInsert)}
            >
              {GLYPH.run} fill…
            </button>
          ) : (
            <>
              <button
                onClick={() => onInsert(t, false)}
                disabled={!canInsert}
                title="insert into the target console (review before sending)"
                style={actionButtonStyle(canInsert)}
              >
                {GLYPH.run} insert
              </button>
              <button
                onClick={() => onInsert(t, true)}
                disabled={!canInsert}
                title="insert and submit immediately"
                style={actionButtonStyle(canInsert)}
              >
                ↵ send
              </button>
            </>
          )}
          <button onClick={() => onEdit(t)} title="edit" style={iconButtonStyle}>
            ✎
          </button>
          <button onClick={() => setConfirmDelete(true)} title="delete" style={iconButtonStyle}>
            ✕
          </button>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
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
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as TemplateScope)}
          style={inputStyle}
        >
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

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
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
        <span style={{ font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)", flex: 1 }}>
          {canInsert ? `→ ${targetTitle}` : "no running console to insert into"}
        </span>
        <button onClick={onBack} style={buttonStyle}>
          back
        </button>
        <button
          onClick={() => onInsert(resolved, false)}
          disabled={!canInsert}
          style={actionButtonStyle(canInsert)}
        >
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
