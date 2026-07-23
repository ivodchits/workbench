// The branch tab (G4), lifted out of `index.tsx` on the way through — the
// file-decomposition note asks each step to extract the tab it already has open
// rather than spend a session on pure motion.
//
// Step 3.11 left this as a flat list of names: every local branch, then every
// remote branch under one "remote" heading, with checkout / rename / delete on
// hover. That's fine for five branches and unusable for fifty, and it said
// nothing about *what* a branch holds. G4 gives it a filter, a sort, per-remote
// grouping, each branch's tip subject and age, and — the correctness fix — a mark
// on branches another worktree has checked out, which git refuses to hand over
// and which the panel used to surface as a raw error after the click.
//
// The integration operations themselves (merge / rebase / fast-forward / set
// upstream / delete on the remote) live in the row's right-click menu, built by
// `menus.ts` and confirmed by the panel shell. Nothing here runs git directly.

import { useMemo, useState } from "react";

import { GLYPH } from "../../theme";
import type { Branch, Branches } from "../../ipc/git";
import ContextMenu from "../../components/ContextMenu";
import { useContextMenu } from "../../components/useContextMenu";
import { localBranchMenu, remoteBranchMenu, type BranchActions } from "./menus";
import { inputStyle, miniActionStyle, relativeDate } from "./format";
import { HeaderButton, RowAction, SectionHead } from "./rows";
import { readSection, writeSection } from "./layout";

/** Remote branches that matched no configured remote. Shouldn't happen, but a
 *  branch that quietly vanished from the list would be worse than an odd heading. */
const OTHER = "other";

export default function BranchesTab({
  branches,
  actions,
  onNewBranch,
}: {
  branches: Branches;
  actions: BranchActions;
  onNewBranch: () => void;
}) {
  const { anchor, openMenu, closeMenu } = useContextMenu();
  const [filter, setFilter] = useState("");
  // Two orderings, so one boolean carries it — `layout.ts` stores section flags
  // and this is the same kind of sticky, low-stakes preference.
  const [byName, setByName] = useState(() => readSection("branches.sortName", false));
  const toggleSort = () => {
    setByName(!byName);
    writeSection("branches.sortName", !byName);
  };

  const q = filter.trim().toLowerCase();

  const local = useMemo(() => {
    // The filter reads the tip subject as well as the name: half the time you
    // know what a branch was for and not what it was called.
    const kept = branches.local.filter(
      (b) => q === "" || b.name.toLowerCase().includes(q) || b.subject.toLowerCase().includes(q),
    );
    return kept.sort((a, b) =>
      byName ? a.name.localeCompare(b.name) : b.date - a.date || a.name.localeCompare(b.name),
    );
  }, [branches.local, byName, q]);

  // Group remote-tracking branches under the remote they belong to, matching the
  // longest configured remote name first so `origin` can't claim `origin2/x`.
  const remoteGroups = useMemo(() => {
    const names = [...branches.remotes].sort((a, b) => b.length - a.length);
    const groups = new Map<string, string[]>();
    for (const ref of branches.remote) {
      if (q !== "" && !ref.toLowerCase().includes(q)) continue;
      const remote = names.find((r) => ref.startsWith(`${r}/`)) ?? OTHER;
      const list = groups.get(remote);
      if (list) list.push(ref);
      else groups.set(remote, [ref]);
    }
    for (const list of groups.values()) list.sort((a, b) => a.localeCompare(b));
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [branches.remote, branches.remotes, q]);

  const hidden =
    branches.local.length - local.length + (branches.remote.length - remoteGroups.reduce((n, [, l]) => n + l.length, 0));

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          borderBottom: "1px solid var(--wb-border)",
          background: "var(--wb-titlebar)",
        }}
      >
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.stopPropagation();
              setFilter("");
            }
          }}
          placeholder="filter branches"
          spellCheck={false}
          style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "3px 7px", fontSize: 11 }}
        />
        <HeaderButton
          onClick={toggleSort}
          title={byName ? "sorted by name — switch to most recent first" : "sorted by most recent commit — switch to name order"}
        >
          {byName ? "↓ name" : "↓ recent"}
        </HeaderButton>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <SectionHead>
          local <span style={{ color: "var(--wb-textFaint)" }}>{local.length}</span>
          <button onClick={onNewBranch} disabled={actions.busy} style={miniActionStyle}>
            + new branch
          </button>
        </SectionHead>
        {local.length === 0 ? (
          <EmptyLine>{q ? "no local branch matches" : "no local branches"}</EmptyLine>
        ) : (
          local.map((b) => (
            <LocalBranchRow
              key={b.name}
              branch={b}
              busy={actions.busy}
              onCheckout={() => actions.checkout(b.name)}
              onRename={() => actions.rename(b)}
              onDelete={() => actions.deleteBranch(b.name)}
              onMenu={(e) => openMenu(e, localBranchMenu(b, actions))}
            />
          ))
        )}

        {remoteGroups.map(([remote, refs]) => (
          <RemoteGroup
            key={remote}
            remote={remote}
            refs={refs}
            actions={actions}
            onMenu={(name, e) => openMenu(e, remoteBranchMenu(name, actions))}
          />
        ))}

        {q !== "" && hidden > 0 && (
          <EmptyLine>
            {hidden} branch{hidden === 1 ? "" : "es"} hidden by the filter
          </EmptyLine>
        )}
      </div>

      {anchor && <ContextMenu {...anchor} onClose={closeMenu} />}
    </div>
  );
}

/** One remote's branches, collapsible and remembered per remote — a fork remote
 *  you rarely read shouldn't cost you a screen of scrolling every time. */
function RemoteGroup({
  remote,
  refs,
  actions,
  onMenu,
}: {
  remote: string;
  refs: string[];
  actions: BranchActions;
  onMenu: (name: string, e: React.MouseEvent) => void;
}) {
  const key = `branches.remote.${remote}`;
  const [open, setOpen] = useState(() => readSection(key, true));
  const toggle = () => {
    setOpen(!open);
    writeSection(key, !open);
  };
  return (
    <>
      <SectionHead open={open} onToggle={toggle}>
        {remote} <span style={{ color: "var(--wb-textFaint)" }}>{refs.length}</span>
      </SectionHead>
      {open &&
        refs.map((r) => (
          <RemoteBranchRow
            key={r}
            name={r}
            remote={remote}
            busy={actions.busy}
            onCheckout={() => actions.checkout(r)}
            onMenu={(e) => onMenu(r, e)}
          />
        ))}
    </>
  );
}

function LocalBranchRow({
  branch,
  busy,
  onCheckout,
  onRename,
  onDelete,
  onMenu,
}: {
  branch: Branch;
  busy: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  // Held by another worktree: git won't check it out or delete it here, so the
  // row says so and the two actions that would fail are withheld rather than
  // offered and then rejected.
  const held = branch.worktree;
  const canCheckout = !branch.isHead && !held;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => canCheckout && !busy && onCheckout()}
      onContextMenu={onMenu}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 14px", font: "12px var(--wb-mono)" }}
    >
      <span style={{ flex: "0 0 auto", width: 10, color: branch.isHead ? "var(--wb-done)" : "transparent" }}>●</span>
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <span
            style={{
              color: branch.isHead ? "var(--wb-text)" : "var(--wb-textDim2)",
              fontWeight: branch.isHead ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {branch.name}
          </span>
          {branch.ahead > 0 && <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-done)" }}>↑{branch.ahead}</span>}
          {branch.behind > 0 && <span style={{ font: "9.5px var(--wb-mono)", color: "var(--wb-working)" }}>↓{branch.behind}</span>}
          {held && (
            <span
              title={`checked out in ${held} — git won't hand it to this working tree`}
              style={{ flex: "0 0 auto", font: "9.5px var(--wb-mono)", color: "var(--wb-working)" }}
            >
              ⧉ worktree
            </span>
          )}
        </span>
        {/* One dim line for everything the name doesn't say: what it tracks, how
            old the tip is, and what that tip was. */}
        <span
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 7,
            minWidth: 0,
            font: "9.5px var(--wb-mono)",
            color: "var(--wb-textFaint)",
          }}
        >
          {branch.upstream && <span style={{ flex: "0 0 auto" }}>→ {branch.upstream}</span>}
          {branch.date > 0 && <span style={{ flex: "0 0 auto" }}>{relativeDate(branch.date)}</span>}
          <span
            title={branch.subject}
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {branch.subject}
          </span>
        </span>
      </span>
      <span style={{ flex: "0 0 auto", font: "9.5px var(--wb-mono)", color: "var(--wb-textFaint)" }}>{branch.short}</span>
      <span style={{ flex: "0 0 auto", display: "flex", gap: 9, visibility: hover ? "visible" : "hidden" }}>
        {canCheckout && (
          <RowAction onClick={onCheckout} label="checkout" disabled={busy}>
            ⇄
          </RowAction>
        )}
        <RowAction onClick={onRename} label="rename branch" disabled={busy}>
          ✎
        </RowAction>
        {!branch.isHead && !held && (
          <RowAction onClick={onDelete} label="delete branch" disabled={busy} danger>
            {GLYPH.fail}
          </RowAction>
        )}
      </span>
    </div>
  );
}

function RemoteBranchRow({
  name,
  remote,
  busy,
  onCheckout,
  onMenu,
}: {
  name: string;
  /** The group heading already says which remote — the row drops the prefix. */
  remote: string;
  busy: boolean;
  onCheckout: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const short = name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => !busy && onCheckout()}
      onContextMenu={onMenu}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 14px 4px 24px", font: "12px var(--wb-mono)" }}
    >
      <span
        title={name}
        style={{ minWidth: 0, flex: 1, color: "var(--wb-textDim2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {short}
      </span>
      <span style={{ flex: "0 0 auto", visibility: hover ? "visible" : "hidden" }}>
        <RowAction onClick={onCheckout} label="checkout (detached / tracking)" disabled={busy}>
          ⇄
        </RowAction>
      </span>
    </div>
  );
}

/** A dim one-liner where a list would be — an empty filter result reads as a
 *  broken panel without it. */
function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "3px 14px 8px", font: "10px var(--wb-mono)", color: "var(--wb-textFaint)" }}>
      {children}
    </div>
  );
}
