// The History tab (G7), extracted from `index.tsx` on its way through — until now
// it was a fixed list of the last 200 subjects with a file list under it, and no
// way to look past, into, or between them.
//
// What changed, and why each part is where it is:
//
//   * **The tab owns its own log read.** The shell's `load()` used to fetch the
//     log alongside branches, status and stashes, which meant staging one file
//     re-read 200 commits. Query, paging and refresh all belong to whoever is
//     looking at history, so they live here; the shell bumps `reloadKey` after a
//     write and this re-reads page one. (G8 generalises that to every slice.)
//   * **Filtering happens in git**, not over the fetched page. Searching the 200
//     commits you happen to hold is a search of the window, not of the repo —
//     `LogQuery` maps straight onto `git log` arguments.
//   * **The graph gutter** finally uses `Commit.parents`, fetched for exactly this
//     since step 3.11 and unused ever since. Lane assignment is in `lanes.ts`,
//     drawing in `Graph.tsx`; both are deliberately small (§5: "where it helps").
//   * **Row zero is the working tree**, so status and history read as one
//     timeline. It's a jump to the other tab, not a diff — the working tree
//     already has a whole tab that does this better.
//   * **Compare mode** replaces the commit's own file list with a range's, and
//     hides the detail pane: there's no single commit to describe when you're
//     looking at the distance between two.

import { useCallback, useEffect, useMemo, useState } from "react";

import { GLYPH } from "../../theme";
import {
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommitFiles,
  gitFileHistory,
  gitLog,
  gitRangeFileDiff,
  gitRangeFiles,
  type Branches,
  type Commit,
  type CommitDetail,
  type DiffFile,
  type LogQuery,
  type Tag,
} from "../../ipc/git";
import ContextMenu from "../../components/ContextMenu";
import { useContextMenu } from "../../components/useContextMenu";
import UnifiedDiff from "../Diff/UnifiedDiff";
import Graph from "./Graph";
import { buildGraph, LANE_W, ROW_H } from "./lanes";
import { commitFileRowMenu, commitRowMenu, tagMenu, type ShellHistoryActions } from "./menus";
import {
  inputStyle,
  relativeDate,
  absoluteDate,
  statusColor,
  STATUS_GLYPH,
} from "./format";
import { Empty, HeaderButton, SectionHead } from "./rows";
import Splitter from "./Splitter";
import type { Orientation } from "./useOrientation";

/** Commits per page. The same number the panel always fetched — now the *first*
 *  page rather than the whole of history. */
const PAGE = 200;

/** A one-shot instruction arriving from another tab (G7): a file's history, or a
 *  comparison. Carried as a nonce so the same request twice runs twice. */
export interface HistoryCommand {
  kind: "fileHistory" | "compare";
  /** `fileHistory`: the repo-relative path. */
  path?: string;
  /** `compare`: the two ends. `to: null` means the working tree. */
  from?: string;
  to?: string | null;
  n: number;
}

/** What the log list is showing. */
type Mode =
  | { kind: "log" }
  /** One path's history, `--follow`ed through renames. */
  | { kind: "file"; path: string };

/** The pair being compared, or null. `to === null` is the working tree. */
interface Compare {
  from: string;
  fromLabel: string;
  to: string | null;
  toLabel: string;
}

export default function HistoryTab({
  repoRoot,
  orientation,
  actions,
  branches,
  tags,
  dirtyCount,
  onWorkingTree,
  reloadKey,
  command,
  onCommandDone,
}: {
  repoRoot: string;
  orientation: Orientation;
  actions: ShellHistoryActions;
  /** Branch names for the ref selector — what to walk instead of HEAD. */
  branches: Branches;
  tags: Tag[];
  /** Files with uncommitted changes — the count on row zero. */
  dirtyCount: number;
  onWorkingTree: () => void;
  /** Bumped by the shell after every write, so history follows a commit or a revert. */
  reloadKey: number;
  command: HistoryCommand | null;
  onCommandDone: () => void;
}) {
  const { anchor: menu, openMenu, closeMenu } = useContextMenu();

  // --- what to read ---------------------------------------------------------
  const [mode, setMode] = useState<Mode>({ kind: "log" });
  const [search, setSearch] = useState("");
  const [author, setAuthor] = useState("");
  const [path, setPath] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [reference, setReference] = useState("");
  const [advanced, setAdvanced] = useState(false);

  // Typing shouldn't spawn a `git log` per keystroke. 300ms is long enough to
  // finish a word and short enough that the list feels attached to the box.
  const [debounced, setDebounced] = useState({ search, author, path, since, until });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ search, author, path, since, until }), 300);
    return () => clearTimeout(t);
  }, [search, author, path, since, until]);

  const query: LogQuery = useMemo(
    () => ({
      limit: PAGE,
      reference: reference || null,
      search: debounced.search || null,
      author: debounced.author || null,
      path: debounced.path || null,
      since: debounced.since || null,
      until: debounced.until || null,
    }),
    [reference, debounced],
  );
  const filtering =
    reference !== "" ||
    [debounced.search, debounced.author, debounced.path, debounced.since, debounced.until].some(
      (v) => v !== "",
    );

  // --- the log itself -------------------------------------------------------
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const modeKey = mode.kind === "file" ? `file:${mode.path}` : "log";
  useEffect(() => {
    let alive = true;
    setCommits(null);
    setExhausted(false);
    setLogError(null);
    const read =
      mode.kind === "file"
        ? gitFileHistory(repoRoot, mode.path, PAGE)
        : gitLog(repoRoot, query);
    void read
      .then((list) => {
        if (!alive) return;
        setCommits(list);
        setExhausted(list.length < PAGE);
      })
      .catch((err) => {
        if (!alive) return;
        setCommits([]);
        setLogError(String(err instanceof Error ? err.message : err));
      });
    return () => {
      alive = false;
    };
    // `modeKey` stands in for `mode`, whose identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, query, modeKey, reloadKey]);

  const loadMore = () => {
    if (loadingMore || exhausted || mode.kind === "file") return;
    setLoadingMore(true);
    void gitLog(repoRoot, { ...query, skip: commits?.length ?? 0 })
      .then((more) => {
        setCommits((prev) => [...(prev ?? []), ...more]);
        setExhausted(more.length < PAGE);
      })
      .catch((err) => setLogError(String(err instanceof Error ? err.message : err)))
      .finally(() => setLoadingMore(false));
  };

  // --- selection, detail, files, diff ---------------------------------------
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  // Keep a valid selection as the log changes under us.
  useEffect(() => {
    if (!commits) return;
    setSelected((prev) => (prev && commits.some((c) => c.sha === prev) ? prev : commits[0]?.sha ?? null));
  }, [commits]);

  const selectedCommit = commits?.find((c) => c.sha === selected) ?? null;

  // The commit's own story. Skipped in compare mode — a range has no single one.
  useEffect(() => {
    if (!selected || compare) {
      setDetail(null);
      return;
    }
    let alive = true;
    void gitCommitDetail(repoRoot, selected)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [repoRoot, selected, compare]);

  // The changed-file list: a commit's, or a range's.
  useEffect(() => {
    if (!compare && !selected) {
      setFiles(null);
      setSelectedFile(null);
      return;
    }
    let alive = true;
    const read = compare
      ? gitRangeFiles(repoRoot, compare.from, compare.to)
      : gitCommitFiles(repoRoot, selected as string);
    void read
      .then((f) => {
        if (!alive) return;
        setFiles(f);
        setSelectedFile(f[0]?.path ?? null);
      })
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [repoRoot, selected, compare, reloadKey]);

  // The selected file's diff, within the commit or across the range.
  useEffect(() => {
    if (!selectedFile || (!compare && !selected)) {
      setDiff(null);
      return;
    }
    let alive = true;
    const read = compare
      ? gitRangeFileDiff(repoRoot, compare.from, compare.to, selectedFile)
      : gitCommitFileDiff(repoRoot, selected as string, selectedFile);
    void read
      .then((d) => alive && setDiff(d.binary ? "" : d.text))
      .catch((err) => alive && setDiff(String(err)));
    return () => {
      alive = false;
    };
  }, [repoRoot, selected, compare, selectedFile, reloadKey]);

  // --- instructions from elsewhere ------------------------------------------
  useEffect(() => {
    if (!command) return;
    if (command.kind === "fileHistory" && command.path) {
      setCompare(null);
      setMode({ kind: "file", path: command.path });
    } else if (command.kind === "compare" && command.from) {
      setCompare({
        from: command.from,
        fromLabel: command.from,
        to: command.to ?? null,
        toLabel: command.to ?? "working tree",
      });
    }
    onCommandDone();
  }, [command, onCommandDone]);

  const startCompare = useCallback((from: Commit, to: Commit | null) => {
    setCompare({
      from: from.sha,
      fromLabel: from.short,
      to: to?.sha ?? null,
      toLabel: to?.short ?? "working tree",
    });
  }, []);

  const graph = useMemo(() => buildGraph(commits ?? []), [commits]);
  const narrow = orientation === "narrow";

  /** The menu for a commit row — the local compare items plus the shell's. */
  const rowMenu = (c: Commit) => {
    const base = selectedCommit && selectedCommit.sha !== c.sha ? selectedCommit : null;
    return commitRowMenu(c, {
      ...actions,
      compareBase: base,
      compareWorkingTree: () => startCompare(c, null),
      compareWith: () => base && startCompare(base, c),
    });
  };

  return (
    <>
      <Splitter
        id="history.log"
        orientation={orientation}
        direction={narrow ? "column" : "row"}
        defaultSize={narrow ? 220 : 320}
        minFirst={narrow ? 90 : 200}
        minSecond={narrow ? 120 : 240}
        first={
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            <SearchBar
              search={search}
              onSearch={setSearch}
              author={author}
              onAuthor={setAuthor}
              path={path}
              onPath={setPath}
              since={since}
              onSince={setSince}
              until={until}
              onUntil={setUntil}
              reference={reference}
              onReference={setReference}
              branches={branches}
              tags={tags}
              advanced={advanced}
              onAdvanced={() => setAdvanced((v) => !v)}
              filtering={filtering}
              onClear={() => {
                setSearch("");
                setAuthor("");
                setPath("");
                setSince("");
                setUntil("");
                setReference("");
              }}
              mode={mode}
              onExitFile={() => setMode({ kind: "log" })}
            />
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--wb-panel)" }}>
              {/* Row zero. Hidden while a filter is on: the working tree isn't a
                  commit, so it can't honestly claim to match one. */}
              {dirtyCount > 0 && mode.kind === "log" && !filtering && (
                <WorkingTreeRow count={dirtyCount} onClick={onWorkingTree} width={graph.width} />
              )}
              {commits === null ? (
                <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
                  reading history…
                </div>
              ) : logError ? (
                <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-needs)" }}>
                  {GLYPH.warn} {logError}
                </div>
              ) : commits.length === 0 ? (
                <div style={{ padding: "10px 12px", font: "11px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
                  {mode.kind === "file"
                    ? `no commits touch ${mode.path}`
                    : filtering
                      ? "no commit matches those filters"
                      : "no commits yet"}
                </div>
              ) : (
                commits.map((c, i) => (
                  <CommitRow
                    key={c.sha}
                    commit={c}
                    row={graph.rows[i]}
                    width={graph.width}
                    active={c.sha === selected}
                    pinned={compare?.from === c.sha || compare?.to === c.sha}
                    onSelect={() => setSelected(c.sha)}
                    // Right-click selects too: the menu's checkout / branch-from
                    // read better next to the commit's own file list than against
                    // whatever was selected before. Except when the item is
                    // "compare with selected" — so the pivot is captured first.
                    onMenu={(e) => {
                      const items = rowMenu(c);
                      setSelected(c.sha);
                      openMenu(e, items);
                    }}
                  />
                ))
              )}
              {commits !== null && commits.length > 0 && mode.kind === "log" && !exhausted && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "7px 12px",
                    background: "transparent",
                    border: "none",
                    borderTop: "1px solid var(--wb-border)",
                    color: loadingMore ? "var(--wb-textFaint)" : "var(--wb-accent)",
                    font: "11px var(--wb-mono)",
                    cursor: loadingMore ? "default" : "pointer",
                  }}
                >
                  {loadingMore ? "reading…" : `↓ load more (${commits.length} so far)`}
                </button>
              )}
            </div>
          </div>
        }
        second={
          // The commit's story and its files share one scroll box above the diff:
          // they're the same question ("what is this commit"), and a third
          // splitter to separate them would cost more than it explains.
          <Splitter
            id="history.files"
            orientation={orientation}
            direction="column"
            defaultSize={180}
            minFirst={52}
            minSecond={90}
            collapsible
            secondLabel="diff"
            first={
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--wb-titlebar)" }}>
                {compare ? (
                  <CompareBar compare={compare} onClear={() => setCompare(null)} />
                ) : detail ? (
                  <Detail
                    detail={detail}
                    onGo={(sha) => {
                      // A parent inside the fetched page can just be selected;
                      // one past the end needs a page that holds it, and the
                      // honest move is to say so rather than select nothing.
                      if (commits?.some((c) => c.sha === sha)) setSelected(sha);
                      else actions.copy(sha, "parent sha — it's past the loaded page");
                    }}
                    actions={actions}
                    onTagMenu={(name, e) => openMenu(e, tagMenu(name, actions))}
                  />
                ) : null}
                <CommitFileList
                  files={files}
                  selected={selectedFile}
                  onSelect={setSelectedFile}
                  onMenu={(p, e) => openMenu(e, commitFileRowMenu(p, actions))}
                />
              </div>
            }
            second={
              !selectedFile ? (
                <Empty>select a file</Empty>
              ) : diff === null ? (
                <Empty>reading diff…</Empty>
              ) : diff.trim() === "" ? (
                <Empty>{GLYPH.warn} binary file — no textual diff</Empty>
              ) : (
                <UnifiedDiff text={diff} />
              )
            }
          />
        }
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </>
  );
}

// --- the search bar ---------------------------------------------------------

/** Message search plus, behind a toggle, the filters that need their own field.
 *  Everything here becomes a `git log` argument — see `LogQuery`. */
function SearchBar({
  search,
  onSearch,
  author,
  onAuthor,
  path,
  onPath,
  since,
  onSince,
  until,
  onUntil,
  reference,
  onReference,
  branches,
  tags,
  advanced,
  onAdvanced,
  filtering,
  onClear,
  mode,
  onExitFile,
}: {
  search: string;
  onSearch: (v: string) => void;
  author: string;
  onAuthor: (v: string) => void;
  path: string;
  onPath: (v: string) => void;
  since: string;
  onSince: (v: string) => void;
  until: string;
  onUntil: (v: string) => void;
  reference: string;
  onReference: (v: string) => void;
  branches: Branches;
  tags: Tag[];
  advanced: boolean;
  onAdvanced: () => void;
  filtering: boolean;
  onClear: () => void;
  mode: Mode;
  onExitFile: () => void;
}) {
  const field = { ...inputStyle, flex: 1, minWidth: 0, padding: "2px 6px", fontSize: 11 };
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "5px 12px",
        borderBottom: "1px solid var(--wb-border)",
        background: "var(--wb-titlebar)",
      }}
    >
      {mode.kind === "file" ? (
        // File history is its own read (`--follow`, so it survives renames) and
        // ignores the filters, which is why it replaces the box rather than
        // sitting beside it.
        <div style={{ display: "flex", alignItems: "center", gap: 8, font: "11px var(--wb-mono)" }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              color: "var(--wb-accent)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={mode.path}
          >
            ≡ history of {mode.path}
          </span>
          <HeaderButton onClick={onExitFile} title="back to the whole log">
            ⨯
          </HeaderButton>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && search !== "") {
                  e.stopPropagation();
                  onSearch("");
                }
              }}
              placeholder="search messages…"
              spellCheck={false}
              style={field}
            />
            {filtering && (
              <HeaderButton onClick={onClear} title="clear every filter">
                ⨯
              </HeaderButton>
            )}
            <HeaderButton
              onClick={onAdvanced}
              accent={advanced || filtering}
              title="author, path, dates, and which ref to walk"
            >
              ⌸
            </HeaderButton>
          </div>
          {advanced && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  value={author}
                  onChange={(e) => onAuthor(e.target.value)}
                  placeholder="author"
                  spellCheck={false}
                  style={field}
                />
                <input
                  value={path}
                  onChange={(e) => onPath(e.target.value)}
                  placeholder="path"
                  spellCheck={false}
                  style={field}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {/* git parses these itself, so `2 weeks ago` works as well as a
                    date — a date picker would take that away. */}
                <input
                  value={since}
                  onChange={(e) => onSince(e.target.value)}
                  placeholder="since (2 weeks ago)"
                  spellCheck={false}
                  style={field}
                />
                <input
                  value={until}
                  onChange={(e) => onUntil(e.target.value)}
                  placeholder="until"
                  spellCheck={false}
                  style={field}
                />
              </div>
              <select
                value={reference}
                onChange={(e) => onReference(e.target.value)}
                style={{ ...field, flex: "0 0 auto", cursor: "pointer" }}
              >
                <option value="">{branches.current ?? "HEAD"} (current)</option>
                <option value="--all">every branch and tag</option>
                {branches.local.map((b) => (
                  <option key={`l:${b.name}`} value={b.name}>
                    {b.name}
                  </option>
                ))}
                {branches.remote.map((r) => (
                  <option key={`r:${r}`} value={r}>
                    {r}
                  </option>
                ))}
                {tags.map((t) => (
                  <option key={`t:${t.name}`} value={t.name}>
                    ⌂ {t.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- rows -------------------------------------------------------------------

/** Row zero: the uncommitted changes, so the log and the working tree read as one
 *  timeline. Clicking it goes to the tab that can actually act on them. */
function WorkingTreeRow({
  count,
  onClick,
  width,
}: {
  count: number;
  onClick: () => void;
  width: number;
}) {
  return (
    <button
      onClick={onClick}
      title="show the working tree"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        height: ROW_H,
        boxSizing: "border-box",
        textAlign: "left",
        padding: "0 11px 0 0",
        border: "none",
        borderBottom: "1px solid var(--wb-border)",
        borderLeft: "2px solid transparent",
        background: "transparent",
        cursor: "pointer",
      }}
    >
      {/* An empty gutter cell of the same width, so the subject column starts
          where every other row's does. */}
      <span style={{ flex: "0 0 auto", width: width * LANE_W, marginLeft: 9 }} />
      <span style={{ flex: 1, minWidth: 0, font: "11.5px var(--wb-mono)", color: "var(--wb-working)" }}>
        ± uncommitted changes
      </span>
      <span style={{ flex: "0 0 auto", font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
        {count} {count === 1 ? "file" : "files"}
      </span>
    </button>
  );
}

function CommitRow({
  commit,
  row,
  width,
  active,
  pinned,
  onSelect,
  onMenu,
}: {
  commit: Commit;
  row: ReturnType<typeof buildGraph>["rows"][number] | undefined;
  width: number;
  active: boolean;
  /** One end of the current comparison — marked so the pair is visible in the list. */
  pinned: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onSelect}
      onContextMenu={onMenu}
      title={commit.sha}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        height: ROW_H,
        boxSizing: "border-box",
        textAlign: "left",
        padding: "0 11px 0 0",
        border: "none",
        borderLeft: `2px solid ${active ? "var(--wb-selBar)" : pinned ? "var(--wb-working)" : "transparent"}`,
        background: active ? "var(--wb-sel)" : "transparent",
        cursor: "pointer",
      }}
    >
      <span style={{ flex: "0 0 auto", marginLeft: 9, display: "flex" }}>
        {row ? <Graph row={row} width={width} /> : <span style={{ width: width * LANE_W }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              font: "11.5px var(--wb-mono)",
              color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {commit.subject}
          </span>
          {/* Inline, never wrapped: the graph gutter joins row to row edge-to-edge,
              so a row that grew a third line would break the lines it draws. */}
          {commit.refs.slice(0, 2).map((r) => (
            <span
              key={r}
              title={r}
              style={{
                flex: "0 0 auto",
                maxWidth: 92,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                font: "9px var(--wb-mono)",
                color: r.startsWith("tag: ") ? "var(--wb-working)" : "var(--wb-accent)",
                border: "1px solid var(--wb-border)",
                borderRadius: 3,
                padding: "0 4px",
              }}
            >
              {r.replace(/^HEAD -> /, "").replace(/^tag: /, "⌂")}
            </span>
          ))}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            font: "9.5px var(--wb-mono)",
            color: "var(--wb-textFaint)",
          }}
        >
          <span style={{ color: "var(--wb-accent)", flex: "0 0 auto" }}>{commit.short}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {commit.author}
          </span>
          <span style={{ flex: "0 0 auto" }}>{relativeDate(commit.date)}</span>
        </span>
      </span>
    </button>
  );
}

// --- the detail pane --------------------------------------------------------

/** Everything about the selected commit that doesn't fit on its row: the body,
 *  both identities with their dates, the parents, and its decorations. */
function Detail({
  detail,
  onGo,
  actions,
  onTagMenu,
}: {
  detail: CommitDetail;
  /** Navigate to a parent. */
  onGo: (sha: string) => void;
  actions: ShellHistoryActions;
  onTagMenu: (name: string, e: React.MouseEvent) => void;
}) {
  // Only worth showing both when they differ — a rebase or an amend moves the
  // committer date and leaves the author date alone, and that gap *is* the news.
  const moved = Math.abs(detail.committerDate - detail.authorDate) > 60;
  return (
    <div style={{ borderBottom: "1px solid var(--wb-border)", padding: "6px 12px 8px" }}>
      <div style={{ font: "11.5px var(--wb-mono)", color: "var(--wb-text)", lineHeight: 1.45 }}>
        {detail.subject}
      </div>
      {detail.body.trim() !== "" && (
        <div
          style={{
            marginTop: 5,
            font: "11px var(--wb-mono)",
            color: "var(--wb-textDim2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.5,
          }}
        >
          {detail.body}
        </div>
      )}
      <div
        style={{
          marginTop: 6,
          display: "flex",
          flexWrap: "wrap",
          gap: "2px 10px",
          font: "9.5px var(--wb-mono)",
          color: "var(--wb-textFaint)",
        }}
      >
        <button
          onClick={() => actions.copy(detail.sha, "sha")}
          title={`${detail.sha} — click to copy`}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "9.5px var(--wb-mono)",
            color: "var(--wb-accent)",
          }}
        >
          ⎘ {detail.short}
        </button>
        <span title={detail.authorEmail}>
          {detail.author} · authored {absoluteDate(detail.authorDate)}
        </span>
        {moved && (
          <span title={detail.committerEmail}>
            {detail.committer} · committed {absoluteDate(detail.committerDate)}
          </span>
        )}
      </div>
      {(detail.parents.length > 0 || detail.refs.length > 0) && (
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
          {detail.parents.map((p, i) => (
            <button
              key={p}
              onClick={() => onGo(p)}
              title={`parent ${i + 1}: ${p}`}
              style={{
                background: "transparent",
                border: "1px solid var(--wb-border)",
                borderRadius: 3,
                padding: "0 4px",
                cursor: "pointer",
                font: "9px var(--wb-mono)",
                color: "var(--wb-textDim2)",
              }}
            >
              ↑ {p.slice(0, 7)}
            </button>
          ))}
          {detail.refs.map((r) => {
            const tag = r.startsWith("tag: ");
            const name = r.replace(/^tag: /, "").replace(/^HEAD -> /, "");
            return (
              <span
                key={r}
                // Tags are the one decoration with an action behind them — the
                // panel can create and delete them now, and this is where the
                // one you're looking at is.
                onContextMenu={tag ? (e) => onTagMenu(name, e) : undefined}
                title={tag ? `${name} — right-click for tag actions` : name}
                style={{
                  font: "9px var(--wb-mono)",
                  color: tag ? "var(--wb-working)" : "var(--wb-accent)",
                  border: "1px solid var(--wb-border)",
                  borderRadius: 3,
                  padding: "0 4px",
                  cursor: tag ? "context-menu" : "default",
                }}
              >
                {tag ? `⌂ ${name}` : name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** What's being compared, and the way out of it. */
function CompareBar({ compare, onClear }: { compare: Compare; onClear: () => void }) {
  return (
    <div style={{ borderBottom: "1px solid var(--wb-border)", padding: "6px 12px" }}>
      <SectionHead>comparing</SectionHead>
      <div style={{ display: "flex", alignItems: "center", gap: 8, font: "11px var(--wb-mono)" }}>
        <span style={{ flex: 1, minWidth: 0, color: "var(--wb-text)", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color: "var(--wb-accent)" }}>{compare.fromLabel}</span>
          {" → "}
          <span style={{ color: "var(--wb-accent)" }}>{compare.toLabel}</span>
        </span>
        <HeaderButton onClick={onClear} title="back to the selected commit">
          ⨯
        </HeaderButton>
      </div>
    </div>
  );
}

function CommitFileList({
  files,
  selected,
  onSelect,
  onMenu,
}: {
  files: DiffFile[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
  onMenu: (path: string, e: React.MouseEvent) => void;
}) {
  if (files == null) {
    return (
      <div style={{ padding: "6px 12px", font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
        reading…
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div style={{ padding: "6px 12px", font: "10.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
        no file changes
      </div>
    );
  }
  return (
    <>
      {files.map((f) => {
        const active = f.path === selected;
        return (
          <button
            key={f.path}
            onClick={() => onSelect(f.path)}
            onContextMenu={(e) => {
              onSelect(f.path);
              onMenu(f.path, e);
            }}
            title={f.path}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              width: "100%",
              textAlign: "left",
              padding: "3px 12px",
              border: "none",
              background: active ? "var(--wb-sel)" : "transparent",
              cursor: "pointer",
              font: "10.5px var(--wb-mono)",
            }}
          >
            <span style={{ color: statusColor(f.status), flex: "0 0 auto", width: 9 }}>
              {STATUS_GLYPH[f.status] ?? "•"}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
              }}
            >
              {f.path}
            </span>
            <span style={{ flex: "0 0 auto", font: "9.5px var(--wb-mono)" }}>
              {f.insertions > 0 && <span style={{ color: "var(--wb-done)" }}>+{f.insertions} </span>}
              {f.deletions > 0 && <span style={{ color: "var(--wb-needs)" }}>−{f.deletions}</span>}
            </span>
          </button>
        );
      })}
    </>
  );
}
