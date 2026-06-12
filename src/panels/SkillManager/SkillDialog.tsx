// New-skill dialog (step 3.7b — design §7). Scaffolds `<scope>/skills/<name>/
// SKILL.md` with valid frontmatter via `skill_create`, then hands the created path
// back so the panel can open it in the editor to flesh out. Pure create — editing
// an existing skill happens in the file editor, not here.
//
// The two fields map 1:1 to the frontmatter the backend writes: a kebab-case
// `name` (also the folder + invocation id) and a non-empty `description` (how
// Claude decides to use the skill). Both are validated client-side for instant
// feedback; the backend re-validates authoritatively.

import { useMemo, useState, type CSSProperties } from "react";

import { GLYPH } from "../../theme";
import { skillCreate, type SkillScope } from "../../ipc/skills";
import Modal from "../InstanceManager/Modal";

interface SkillDialogProps {
  projectRoot: string;
  onClose: () => void;
  /** Called after a successful create with the new SKILL.md path (to open it). */
  onCreated: (skillPath: string) => void;
}

const SCOPES: { value: Exclude<SkillScope, "plugin">; label: string; hint: string }[] = [
  { value: "project", label: "project", hint: "this repo — .claude/skills (shareable)" },
  { value: "user", label: "user", hint: "global — ~/.claude/skills (every project)" },
];

/** Mirror of the backend's kebab rule, for live validation. */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function SkillDialog({ projectRoot, onClose, onCreated }: SkillDialogProps) {
  const [scope, setScope] = useState<Exclude<SkillScope, "plugin">>("project");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = KEBAB.test(name.trim());
  const canSave = useMemo(
    () => !busy && nameOk && description.trim().length > 0,
    [busy, nameOk, description],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await skillCreate({
        projectRoot,
        scope,
        name: name.trim(),
        description: description.trim(),
      });
      onCreated(path);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (canSave) void save();
    }
  };

  const scopeHint = SCOPES.find((s) => s.value === scope)?.hint ?? "";

  return (
    <Modal title="new skill" onClose={onClose} width={480}>
      <div onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <Field label="scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Exclude<SkillScope, "plugin">)}
            style={inputStyle}
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span style={hintStyle}>{scopeHint}</span>
        </Field>

        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="invoice-fixer"
            spellCheck={false}
            autoFocus
            style={inputStyle}
          />
          <span style={hintStyle}>
            {name.trim().length === 0
              ? "kebab-case — the folder name and how you invoke it (/name)"
              : nameOk
                ? `invoke with /${name.trim()}`
                : "must be kebab-case: lowercase a-z, 0-9, single hyphens"}
          </span>
        </Field>

        <Field label="description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the skill does and when Claude should use it — e.g. 'Generate release notes from the git log. Use when cutting a release.'"
            spellCheck={false}
            rows={4}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
          <span style={hintStyle}>
            this is what Claude matches on to decide whether to load the skill — be specific
          </span>
        </Field>

        {error && (
          <div style={{ color: "var(--wb-needs)", font: "11.5px var(--wb-mono)", whiteSpace: "pre-wrap" }}>
            {GLYPH.fail} {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button onClick={onClose} style={buttonStyle}>
            cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave}
            style={{
              ...buttonStyle,
              borderColor: "var(--wb-borderActive)",
              color: canSave ? "var(--wb-text)" : "var(--wb-textFaint)",
              opacity: canSave ? 1 : 0.6,
            }}
          >
            {busy ? "working…" : `${GLYPH.ok} create & edit`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          font: "600 10px var(--wb-mono)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--wb-textDim2)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

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

const hintStyle: CSSProperties = {
  font: "10px var(--wb-mono)",
  color: "var(--wb-textFaint)",
  marginTop: 3,
};

export default SkillDialog;
