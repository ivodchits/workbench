// The drawer's trust views (step T1): **Trust** (the kill switch, your rules, each
// project's mode, the floor) and **Decisions** (the log of what the trust engine
// decided, newest first, with "make a rule" / "always ask" on each row, and the
// replay of the past week's Claude Code calls through the prompt policy, T2). They take
// the place of the thread while open. Like the rest of the drawer they speak only
// the Duck Protocol, through `duckState`.

import { useEffect, useState } from "react";
import type { Mode } from "../../assistant/trust/decide";
import type { ReplayRow } from "../../assistant/trust/replay";
import { lineDiff, PROMOTE_AT, type PromotionPreview } from "../../assistant/trust/promote";
import { suggestRule, type Effect } from "../../assistant/trust/rules";
import type { DecisionRow } from "../../ipc/assistant";
import { getRegistry } from "../../state/registry";
import { formatAgo } from "../../util/format";
import {
  addTrustRule,
  closePromotionPreview,
  dismissPromotion,
  loadDecisions,
  previewPromotion,
  promote,
  removeTrustRule,
  runReplay,
  setFloorEntry,
  setTrustMode,
  setTrustPaused,
  type DuckState,
} from "./duckState";

const projectName = (id: string | null) =>
  id === null ? "all projects" : (getRegistry().projects.find((p) => p.id === id)?.name ?? id);

const EFFECT_COLOR: Record<Effect, string> = {
  allow: "var(--wb-done)",
  ask: "var(--wb-needs)",
  deny: "var(--wb-delText)",
};

export function Shell({
  title,
  onBack,
  action,
  children,
}: {
  title: string;
  onBack: () => void;
  /** A control at the header's right end. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--wb-border)",
        }}
      >
        <button type="button" style={btn} onClick={onBack}>
          ← thread
        </button>
        <span style={{ flex: 1, color: "var(--wb-textDim2)" }}>{title}</span>
        {action}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px" }}>
        {children}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ color: "var(--wb-textDim2)", marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ ...faint, marginBottom: 6 }}>{hint}</div>}
      {children}
    </div>
  );
}

export function TrustPanel({ duck, onBack }: { duck: DuckState; onBack: () => void }) {
  const t = duck.trust;
  if (!t)
    return (
      <Shell title="trust" onBack={onBack}>
        <div style={faint}>Trust didn't load, so every consequential call asks.</div>
      </Shell>
    );
  const projects = getRegistry().projects;
  return (
    <Shell title="trust" onBack={onBack}>
      <Section title="kill switch">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>
            {t.paused
              ? "Paused: everything consequential asks on a card."
              : "On: Duck acts without a card on what the rules allow."}
          </span>
          <button type="button" style={btn} onClick={() => setTrustPaused(!t.paused)}>
            {t.paused ? "resume" : "pause"}
          </button>
        </div>
        {t.tripped.length > 0 && (
          <div style={{ ...faint, marginTop: 4 }}>
            The rate guard paused {t.tripped.length} thread{t.tripped.length > 1 ? "s" : ""}; pause
            and resume to reset.
          </div>
        )}
      </Section>

      <Section
        title="rules"
        hint="Claude Code's syntax: assistant:write_note, assistant:answer_choice(question), Bash(npm test:*). Deny beats ask beats allow."
      >
        {t.rules.length === 0 && <div style={faint}>no rules: consequential calls ask</div>}
        {t.rules.map((r) => (
          <div key={r.id} style={rowStyle}>
            <span style={{ color: EFFECT_COLOR[r.effect], width: 38 }}>{r.effect}</span>
            <span style={{ flex: 1, wordBreak: "break-all" }}>{r.pattern}</span>
            <span style={faint}>{projectName(r.projectId)}</span>
            <button
              type="button"
              style={plainBtn}
              title="remove this rule"
              aria-label="remove"
              onClick={() => removeTrustRule(r.id)}
            >
              ×
            </button>
          </div>
        ))}
        <AddRule projects={projects} />
      </Section>

      <Section
        title="projects"
        hint="live: the rules decide. shadow: the decision is logged and the card shows anyway. off: every consequential call asks."
      >
        {projects.map((p) => (
          <div key={p.id} style={rowStyle}>
            <span style={{ flex: 1 }}>{p.name}</span>
            <select
              value={t.modes[p.id] ?? "live"}
              onChange={(e) => setTrustMode(p.id, e.target.value as Mode)}
              style={select}
            >
              <option value="live">live</option>
              <option value="shadow">shadow</option>
              <option value="off">off</option>
            </select>
          </div>
        ))}
      </Section>

      <Section
        title="floor"
        hint="Always asks, whatever the rules say. Turning an entry off takes a typed confirmation."
      >
        {t.floor.map((f) => (
          <FloorRow key={f.id} id={f.id} label={f.label} on={f.on} />
        ))}
      </Section>
    </Shell>
  );
}

function AddRule({ projects }: { projects: { id: string; name: string }[] }) {
  const [effect, setEffect] = useState<Effect>("allow");
  const [pattern, setPattern] = useState("");
  const [scope, setScope] = useState("");
  const add = () => {
    if (!pattern.trim()) return;
    addTrustRule(effect, pattern.trim(), scope || null);
    setPattern("");
  };
  return (
    <div style={{ ...rowStyle, marginTop: 6 }}>
      <select value={effect} onChange={(e) => setEffect(e.target.value as Effect)} style={select}>
        <option value="allow">allow</option>
        <option value="ask">ask</option>
        <option value="deny">deny</option>
      </select>
      <input
        value={pattern}
        placeholder="assistant:stop_session"
        onChange={(e) => setPattern(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        style={{ ...select, flex: 1, minWidth: 0 }}
      />
      <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ ...select, maxWidth: 110 }}>
        <option value="">all projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" style={btn} onClick={add}>
        add
      </button>
    </div>
  );
}

function FloorRow({ id, label, on }: { id: string; label: string; on: boolean }) {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={rowStyle}>
        <span style={{ flex: 1, opacity: on ? 1 : 0.55 }}>
          {label} <span style={faint}>({id})</span>
        </span>
        {on ? (
          <button type="button" style={btn} onClick={() => setTyping(!typing)}>
            turn off…
          </button>
        ) : (
          <button type="button" style={btn} onClick={() => setFloorEntry(id, true)}>
            turn on
          </button>
        )}
      </div>
      {on && typing && (
        <div style={{ ...rowStyle, paddingLeft: 12 }}>
          <span style={faint}>type {id} to confirm</span>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={{ ...select, flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            style={btn}
            disabled={typed.trim() !== id}
            onClick={() => {
              setFloorEntry(id, false);
              setTyping(false);
              setTyped("");
            }}
          >
            turn off
          </button>
        </div>
      )}
    </div>
  );
}

const LAYER_LABEL: Record<string, string> = {
  floor: "floor",
  rule: "rule",
  mandate: "your words",
  setting: "setting",
  rate: "rate guard",
  default: "no rule",
  judge: "judge",
  superseded: "answered first",
  delegated: "delegated question",
  "plan-review": "plan review",
};

export function DecisionsPanel({ duck, onBack }: { duck: DuckState; onBack: () => void }) {
  useEffect(() => loadDecisions(null), []);
  const rows = duck.decisions;
  const today = rows.filter((d) => d.decision === "allow" && d.layer !== "superseded" && !d.shadow && Date.now() - d.ts < 86_400_000).length;
  return (
    <Shell title={`decisions · auto-approved today: ${today}`} onBack={onBack}>
      {!duck.trust && <div style={faint}>Trust didn't load.</div>}
      {duck.trust && <PromotionsSection duck={duck} />}
      {duck.trust && <ReplaySection duck={duck} />}
      {rows.length === 0 && <div style={faint}>Nothing decided yet.</div>}
      {rows.map((d) => (
        <DecisionView key={d.id} d={d} />
      ))}
      {duck.decisionsMore && (
        <button
          type="button"
          style={{ ...btn, marginTop: 6 }}
          onClick={() => loadDecisions(rows[rows.length - 1]?.id ?? null)}
        >
          older
        </button>
      )}
    </Shell>
  );
}

/**
 * Promotion (step T3): patterns Duck approved often in a project, offered for the
 * project's own Claude Code allow list (a diff of `.claude/settings.local.json`
 * first) or as a Duck rule.
 */
function PromotionsSection({ duck }: { duck: DuckState }) {
  const list = duck.promotions;
  const preview = duck.promotionPreview;
  if (list.length === 0 && !duck.promoted) return null;
  return (
    <Section
      title={`suggested: approved ${PROMOTE_AT}+ times`}
      hint="On Claude Code's allow list, the session stops asking at all; as a Duck rule, Duck answers it without the judge."
    >
      {duck.promoted && <div style={{ ...faint, marginBottom: 4 }}>done: {duck.promoted.text}</div>}
      {list.map((p) => (
        <div key={p.key} style={{ padding: "4px 0", borderBottom: "1px solid var(--wb-border)" }}>
          <div style={{ wordBreak: "break-word" }}>
            <span style={{ color: EFFECT_COLOR.allow, marginRight: 6 }}>{p.pattern}</span>
            <span style={faint}>
              {projectName(p.projectId)} · {p.count} times{p.shadow ? ` (${p.shadow} in shadow, answered by you)` : ""} ·
              last {formatAgo(Math.floor(p.last / 1000))}
            </span>
          </div>
          <div style={{ ...faint, wordBreak: "break-word" }}>e.g. {p.example}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
            <button type="button" style={linkBtn} onClick={() => previewPromotion(p.key)}>
              add to Claude Code's allow list…
            </button>
            {!p.ruled && (
              <button type="button" style={linkBtn} onClick={() => promote(p.key, "rule")}>
                make it a Duck rule
              </button>
            )}
            <button type="button" style={linkBtn} onClick={() => dismissPromotion(p.key)}>
              dismiss
            </button>
          </div>
          {preview?.key === p.key && <PromotionDiff preview={preview} />}
        </div>
      ))}
    </Section>
  );
}

function PromotionDiff({ preview }: { preview: PromotionPreview }) {
  const lines = lineDiff(preview.before ?? "", preview.after);
  return (
    <div style={{ marginTop: 4, padding: 6, border: "1px solid var(--wb-border)" }}>
      <div style={{ ...faint, wordBreak: "break-all" }}>
        {preview.path}
        {preview.before === null && " (new file)"}
      </div>
      {preview.already ? (
        <div style={faint}>It's on the list already.</div>
      ) : (
        <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-all", font: "11px var(--wb-mono)" }}>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{
                color: l.op === "+" ? "var(--wb-done)" : l.op === "-" ? "var(--wb-delText)" : "var(--wb-textFaint)",
              }}
            >
              {l.op} {l.text}
            </div>
          ))}
        </pre>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={btn} onClick={() => promote(preview.key, "claude", preview.before)}>
          {preview.already ? "mark as done" : "write it"}
        </button>
        <button type="button" style={btn} onClick={closePromotionPreview}>
          cancel
        </button>
      </div>
    </div>
  );
}

/** Each judged call costs about this on Haiku (a second opinion, rarer, more). */
const JUDGE_COST_USD = 0.0005;

/**
 * The replay (step T2): the past week's Claude Code tool calls through the
 * prompt policy, against what happened to them. A transcript records the calls
 * you rejected, not the ones that prompted and you allowed, so the report is:
 * the rejected calls the policy would allow (the disagreements), and how the rest
 * would go.
 */
function ReplaySection({ duck }: { duck: DuckState }) {
  const [open, setOpen] = useState(false);
  const [judgeMax, setJudgeMax] = useState(40);
  const r = duck.replay;
  if (!open)
    return (
      <div style={{ marginBottom: 8 }}>
        <button type="button" style={linkBtn} onClick={() => setOpen(true)}>
          replay the past week…
        </button>
      </div>
    );
  const report = r?.report ?? null;
  return (
    <div style={{ padding: "4px 0 8px", borderBottom: "1px solid var(--wb-border)", marginBottom: 6 }}>
      <div style={faint}>
        The past week's Claude Code tool calls through the prompt policy, against what happened to them. The judge
        reads every call you rejected and a sample of the rest.
      </div>
      <div style={{ ...rowStyle, marginTop: 4 }}>
        <span>judge up to</span>
        <input
          type="number"
          min={0}
          max={500}
          value={judgeMax}
          onChange={(e) => setJudgeMax(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
          style={{ ...select, width: 56 }}
        />
        <span style={faint}>calls (about ${(judgeMax * JUDGE_COST_USD).toFixed(2)})</span>
        <button type="button" style={btn} disabled={r?.running} onClick={() => runReplay(7, judgeMax)}>
          {r?.running ? (r.of ? `judging ${r.done}/${r.of}…` : "reading…") : "run"}
        </button>
      </div>
      {report && (
        <div style={{ marginTop: 6 }}>
          <div>
            {report.calls} calls · judged {report.judged}. Ran: {report.counts.ran.allow} allow ·{" "}
            {report.counts.ran.ask} ask · {report.counts.ran.deny} deny · {report.counts.ran.unjudged} unjudged.
            Rejected by you: {report.counts.rejected.allow} allow · {report.counts.rejected.ask} ask ·{" "}
            {report.counts.rejected.deny} deny · {report.counts.rejected.unjudged} unjudged.
          </div>
          <ReplayList title="disagreements: you rejected these, the policy would allow them" rows={report.disagreements} />
          <ReplayList title="you let these run, a rule would refuse them" rows={report.refusedRan} />
          <ReplayList title="every call you rejected" rows={report.rejected} />
          <ReplayList title="calls that ran which would still ask you (a sample)" rows={report.stillAsks} />
        </div>
      )}
    </div>
  );
}

function ReplayList({ title, rows }: { title: string; rows: ReplayRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details style={{ marginTop: 4 }}>
      <summary>
        {title} ({rows.length})
      </summary>
      {rows.map((row, i) => (
        <div key={i} style={{ padding: "3px 0 3px 12px", borderBottom: "1px solid var(--wb-border)" }}>
          <div style={{ wordBreak: "break-word" }}>
            <span style={{ color: row.verdict === "unjudged" ? undefined : EFFECT_COLOR[row.verdict], marginRight: 6 }}>
              {row.verdict}
            </span>
            {row.call.tool}: {replayDetail(row.call.input)}
          </div>
          <div style={faint}>
            {LAYER_LABEL[row.layer] ?? row.layer}: {row.reason} · {row.project ?? row.call.cwd}
            {row.call.mode ? ` · ${row.call.mode} mode` : ""}
          </div>
        </div>
      ))}
    </details>
  );
}

function replayDetail(input: Record<string, unknown>): string {
  const v = ["command", "file_path", "notebook_path", "path", "url", "pattern"].map((k) => input[k]).find((x) => typeof x === "string");
  const s = typeof v === "string" ? v : JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

function DecisionView({ d }: { d: DecisionRow }) {
  const [done, setDone] = useState<string | null>(null);
  // A Claude Code prompt's rule covers its command's first words, its folder or
  // its host, not just the tool.
  const pattern = suggestRule(d.tool, d.input);
  const rule = (effect: Effect) => {
    addTrustRule(effect, pattern, d.projectId);
    setDone(`${effect} ${pattern} for ${projectName(d.projectId)}`);
  };
  // The floor can't be overridden by a rule, so offering one would mislead.
  const canAllow = d.decision !== "allow" && d.layer !== "floor" && d.layer !== "superseded";
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid var(--wb-border)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: EFFECT_COLOR[d.decision], width: 38 }}>{d.decision}</span>
        <span style={{ flex: 1, wordBreak: "break-word" }}>{d.summary}</span>
        <span style={faint}>{formatAgo(Math.floor(d.ts / 1000))}</span>
      </div>
      <div style={{ ...faint, paddingLeft: 46 }}>
        {LAYER_LABEL[d.layer] ?? d.layer}: {d.reason}
        {d.shadow && " · shadow: the card showed anyway"}
        {d.projectId && ` · ${projectName(d.projectId)}`}
      </div>
      <div style={{ display: "flex", gap: 10, paddingLeft: 46, marginTop: 2 }}>
        {done ? (
          <span style={faint}>added: {done}</span>
        ) : (
          <>
            {canAllow && (
              <button type="button" style={linkBtn} title={`allow ${pattern}`} onClick={() => rule("allow")}>
                make a rule
              </button>
            )}
            {d.decision === "allow" && d.layer !== "superseded" && (
              <button type="button" style={linkBtn} title={`ask ${pattern}`} onClick={() => rule("ask")}>
                always ask for this
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const faint: React.CSSProperties = { color: "var(--wb-textFaint)" };

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "2px 0",
};

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-text)",
  font: "11px var(--wb-mono)",
  padding: "2px 8px",
  cursor: "pointer",
};

const plainBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wb-text)",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: 11,
  color: "var(--wb-textDim2)",
  textDecoration: "underline",
  cursor: "pointer",
};

const select: React.CSSProperties = {
  background: "var(--wb-bg)",
  color: "var(--wb-text)",
  border: "1px solid var(--wb-border)",
  font: "inherit",
};
