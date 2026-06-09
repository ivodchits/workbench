// File tree for the Editor (step 1.8) — a lazy, collapsible directory listing
// scoped to the editor's root dir (design §5 Editor). Each folder loads its
// children from the backend (`fs::read_dir`) on first expand, so opening the
// panel on a deep repo never blocks on a full recursive walk. Files are clickable
// rows; the active file is highlighted. Pure presentation + IO per node — buffer
// state lives in the editors store.

import { useEffect, useState, type CSSProperties } from "react";
import { readDir, type DirEntry } from "../../ipc/fs";
import { GLYPH } from "../../theme";

interface FileTreeProps {
  /** Directory the tree is rooted at (the project working dir). */
  rootPath: string;
  /** Path of the file open in the active tab (highlighted), or null. */
  activePath: string | null;
  /** Open a file (clicked in the tree). */
  onOpenFile: (entry: DirEntry) => void;
}

function FileTree({ rootPath, activePath, onOpenFile }: FileTreeProps) {
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "6px 0",
        font: "11.5px var(--wb-mono)",
        background: "var(--wb-bg)",
      }}
    >
      <DirChildren path={rootPath} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
    </div>
  );
}

/** Loads and renders the children of one directory. Shared by the root and every
 *  expanded folder, so the loading/empty/error states live in one place. */
function DirChildren({
  path,
  depth,
  activePath,
  onOpenFile,
}: {
  path: string;
  depth: number;
  activePath: string | null;
  onOpenFile: (entry: DirEntry) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readDir(path)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <Leaf depth={depth} color="var(--wb-needs)">{GLYPH.warn} {error}</Leaf>;
  if (!entries) return <Leaf depth={depth} color="var(--wb-textFaint)">…</Leaf>;
  if (entries.length === 0) return <Leaf depth={depth} color="var(--wb-textFaint)">empty</Leaf>;

  return (
    <>
      {entries.map((entry) =>
        entry.isDir ? (
          <DirNode
            key={entry.path}
            entry={entry}
            depth={depth}
            activePath={activePath}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileNode
            key={entry.path}
            entry={entry}
            depth={depth}
            active={entry.path === activePath}
            onOpenFile={onOpenFile}
          />
        ),
      )}
    </>
  );
}

function DirNode({
  entry,
  depth,
  activePath,
  onOpenFile,
}: {
  entry: DirEntry;
  depth: number;
  activePath: string | null;
  onOpenFile: (entry: DirEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row depth={depth} onClick={() => setOpen((o) => !o)}>
        <span style={{ color: "var(--wb-textFaint)", width: 10, flex: "0 0 10px" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ color: "var(--wb-accent)" }}>{entry.name}</span>
      </Row>
      {open && (
        <DirChildren
          path={entry.path}
          depth={depth + 1}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
}

function FileNode({
  entry,
  depth,
  active,
  onOpenFile,
}: {
  entry: DirEntry;
  depth: number;
  active: boolean;
  onOpenFile: (entry: DirEntry) => void;
}) {
  return (
    <Row depth={depth} active={active} onClick={() => onOpenFile(entry)}>
      {/* Spacer aligning file names under the caret column of sibling folders. */}
      <span style={{ width: 10, flex: "0 0 10px" }} />
      <span
        style={{
          color: active ? "var(--wb-text)" : "var(--wb-textDim2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
      </span>
    </Row>
  );
}

function Row({
  depth,
  active,
  onClick,
  children,
}: {
  depth: number;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 10px 2px 0",
        paddingLeft: 10 + depth * 13,
        cursor: "pointer",
        background: active ? "var(--wb-sel)" : hover ? "var(--wb-titlebar)" : "transparent",
        borderLeft: `2px solid ${active ? "var(--wb-selBar)" : "transparent"}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

function Leaf({
  depth,
  color,
  children,
}: {
  depth: number;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ ...leafStyle, paddingLeft: 12 + depth * 13, color }}>{children}</div>
  );
}

const leafStyle: CSSProperties = {
  padding: "2px 10px",
  font: "11px var(--wb-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export default FileTree;
