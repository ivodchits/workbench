// The drawer's Memory view (step L1): Duck's long-term memory by topic, a search
// (which finds project notes too), and per entry a way to open its file in the
// editor or forget it. "Don't remember this conversation" turns `remember` off for
// the thread you're in. Takes the place of the thread while open. Step L2: the
// last tidy and what it changed, "tidy now", and automatic recall's hit rate.

import { useCallback, useEffect, useState } from "react";

import { lastTidy, tidyMemory } from "../../assistant";
import { memoryOff, type TidyReport } from "../../assistant/memory";
import { localPort } from "../../assistant/port.local";
import { workspacePrepare } from "../../ipc/assistant";
import {
  memoryForget,
  memoryList,
  memorySearch,
  recallStats,
  type MemoryEntry,
  type MemoryHit,
  type RecallStats,
} from "../../ipc/memory";
import { setActiveProject } from "../../state/activeProject";
import { openProjectFile } from "../../state/editors";
import { setThreadMemory, type DuckState } from "./duckState";
import { Shell } from "./TrustViews";

/** Open a memory file (relative to the workspace) in the Duck project's editor. */
async function openMemoryFile(workspace: string | null, file: string): Promise<void> {
  const dir = await workspacePrepare(workspace);
  const p = await localPort.ensureProject("Duck", dir);
  setActiveProject(p.id);
  const sep = dir.includes("\\") ? "\\" : "/";
  openProjectFile({ projectId: p.id, rootPath: p.rootPath, label: p.name }, { path: `${dir}${sep}${file.replace(/\//g, sep)}` });
}

function EntryRow({
  e,
  workspace,
  onGone,
}: {
  e: MemoryEntry;
  workspace: string | null;
  onGone: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const fail = (x: unknown) => setNote(x instanceof Error ? x.message : String(x));
  return (
    <div style={{ padding: "4px 0", borderBottom: "1px solid var(--wb-border)" }}>
      <div style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap" }}>{e.text}</div>
      <div style={{ marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap", color: "var(--wb-textFaint)" }}>
        {e.date && <span>{e.date}</span>}
        {e.conf && <span>conf {e.conf}</span>}
        {e.tags && <span title="what recall finds it by">{e.tags}</span>}
        <button type="button" style={link} onClick={() => openMemoryFile(workspace, e.file).catch(fail)}>
          edit
        </button>
        <button
          type="button"
          style={link}
          onClick={() =>
            memoryForget(workspace, [{ file: e.file, raw: e.raw }], `memory: forgot ${e.text.slice(0, 72)}`)
              .then(onGone)
              .catch(fail)
          }
        >
          forget
        </button>
      </div>
      {note && <div style={{ color: "var(--wb-needs)" }}>{note}</div>}
    </div>
  );
}

function HitRow({ h }: { h: MemoryHit }) {
  return (
    <div style={{ padding: "4px 0", borderBottom: "1px solid var(--wb-border)" }}>
      <div style={{ color: "var(--wb-textFaint)" }}>
        {h.label} · {h.matched}/{h.terms} words
      </div>
      <div style={{ color: "var(--wb-text)", whiteSpace: "pre-wrap" }}>{h.text}</div>
    </div>
  );
}

/** The hit rate over this many days. */
const STATS_DAYS = 14;

function TidyBox({ onTidied }: { onTidied: () => void }) {
  const [last, setLast] = useState<{ date: string; report: TidyReport } | null>(null);
  const [stats, setStats] = useState<RecallStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    lastTidy().then(setLast).catch(() => {});
    recallStats(Date.now() - STATS_DAYS * 86_400_000).then(setStats).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const tidy = () => {
    setBusy(true);
    setNote(null);
    tidyMemory()
      .then((r) => {
        if (!r.ran) setNote("Nothing new since the last tidy.");
        load();
        onTidied();
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const r = last?.report;
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  return (
    <div style={{ marginBottom: 8, color: "var(--wb-textFaint)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span>
          {last
            ? `tidied ${last.date}${r?.ran ? `: ${r.added} new, ${r.merged} merged, ${r.retired} retired${r.questions ? `, ${r.questions} to ask` : ""}` : ", nothing new"}`
            : "not tidied yet"}
        </span>
        {!!r?.log.length && (
          <button type="button" style={link} onClick={() => setOpen(!open)}>
            {open ? "hide" : "what changed"}
          </button>
        )}
        <button type="button" style={link} disabled={busy} onClick={tidy}>
          {busy ? "tidying…" : "tidy now"}
        </button>
      </div>
      {open && r && (
        <div style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{[...r.log, ...r.skipped.map((s) => `skipped: ${s}`)].join("\n")}</div>
      )}
      {note && <div style={{ color: "var(--wb-needs)" }}>{note}</div>}
      {stats && stats.searched > 0 && (
        <div title="Automatic recall over the last 14 days: a hit counts as used when the reply says its words">
          recall, {STATS_DAYS} days: {stats.searched} messages, {stats.withHits} with hits, {stats.shown} shown, {stats.used} used (
          {pct(stats.used, stats.shown)}); Duck searched itself {stats.selfRecall} times, {stats.missed} after nothing was shown
        </div>
      )}
    </div>
  );
}

export function MemoryPanel({ duck, onBack }: { duck: DuckState; onBack: () => void }) {
  const workspace = duck.settings?.workspace ?? null;
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    memoryList(workspace)
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)));
  }, [workspace]);
  useEffect(load, [load]);

  const search = () => {
    if (!query.trim()) return setHits(null);
    memorySearch(workspace, query, 20)
      .then(setHits)
      .catch((e: unknown) => setError(String(e)));
  };

  const current = duck.current;
  const off = current ? memoryOff(duck.messages[current] ?? []) : false;
  const topics = new Map<string, MemoryEntry[]>();
  for (const e of entries ?? []) topics.set(e.topic, [...(topics.get(e.topic) ?? []), e]);

  return (
    <Shell title="memory" onBack={onBack}>
      {current && (
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--wb-textFaint)", marginBottom: 6 }}>
          <input type="checkbox" checked={off} onChange={(e) => setThreadMemory(current, e.target.checked)} />
          don't remember this conversation
        </label>
      )}
      <TidyBox onTidied={load} />
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          value={query}
          placeholder="search memory and notes"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          style={{
            flex: 1,
            font: "inherit",
            color: "var(--wb-text)",
            background: "var(--wb-bg)",
            border: "1px solid var(--wb-border)",
            padding: "2px 6px",
          }}
        />
        <button type="button" style={link} onClick={search}>
          search
        </button>
      </div>
      {error && <div style={{ color: "var(--wb-needs)" }}>{error}</div>}
      {hits !== null ? (
        <>
          {hits.length === 0 && <div style={{ color: "var(--wb-textFaint)" }}>Nothing matches.</div>}
          {hits.map((h) => (
            <HitRow key={`${h.kind}:${h.file}:${h.line}`} h={h} />
          ))}
        </>
      ) : (
        <>
          {entries !== null && entries.length === 0 && (
            <div style={{ color: "var(--wb-textFaint)" }}>Duck hasn't remembered anything yet.</div>
          )}
          {[...topics].map(([topic, es]) => (
            <div key={topic} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{topic}</span>
                <button
                  type="button"
                  style={link}
                  onClick={() => openMemoryFile(workspace, es[0].file).catch((e: unknown) => setError(String(e)))}
                >
                  open file
                </button>
              </div>
              {es.map((e) => (
                <EntryRow key={`${e.file}:${e.line}`} e={e} workspace={workspace} onGone={load} />
              ))}
            </div>
          ))}
        </>
      )}
    </Shell>
  );
}

const link: React.CSSProperties = {
  padding: 0,
  font: "inherit",
  color: "var(--wb-accent)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};
