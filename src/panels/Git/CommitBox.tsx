// The commit composer (G1) — subject + body, amend, and the commit / commit all /
// commit & push actions. Before this the panel could stage files and then had to
// send you to the Project Shell to finish, which is the panel's biggest usability
// hole: committing is the operation you're already standing next to.
//
// It owns no git calls of its own. It composes a `CommitRequest` and hands it up
// to the panel shell, which owns the confirm plumbing (amending an already-pushed
// commit) and the refresh cycle. Its only side effect is the per-repo draft, which
// it persists itself so no parent has to babysit a half-written message.

import { useEffect, useRef, useState } from "react";

import { GLYPH } from "../../theme";
import type { HeadCommit } from "../../ipc/git";
import { CheckLabel, HeaderButton, SectionHead } from "./rows";
import { clearDraft, hydrateDrafts, readDraft, writeDraft } from "./draft";

/** What the composer asks the panel shell to run. */
export interface CommitRequest {
  /** The full message: subject, blank line, body. */
  message: string;
  /** Rewrite HEAD instead of adding a commit. */
  amend: boolean;
  /** `commit -a` — also take tracked modifications that weren't staged. */
  stageAll: boolean;
  /** Push straight after the commit lands. Always an explicit gesture (§5: never
   *  auto-push), never implied by committing. */
  push: boolean;
}

/** The soft subject-length guide, in columns — a ruler, not a limit. */
const SUBJECT_GUIDE = 72;

export default function CommitBox({
  repoRoot,
  stagedCount,
  trackedDirtyCount,
  head,
  hasUpstream,
  busy,
  committedAt,
  onCommit,
}: {
  repoRoot: string;
  /** Files with a staged change — what a plain `commit` would take. */
  stagedCount: number;
  /** Tracked files modified but not staged — what `commit all` would add. */
  trackedDirtyCount: number;
  /** HEAD's commit, for the amend prefill + published warning; null in a fresh repo. */
  head: HeadCommit | null;
  /** The current branch tracks a remote branch — otherwise pushing *publishes*. */
  hasUpstream: boolean;
  busy: boolean;
  /** Bumped by the shell each time a commit lands, which resets the composer. */
  committedAt: number;
  onCommit: (req: CommitRequest) => void;
}) {
  const [subject, setSubject] = useState(() => readDraft(repoRoot).subject);
  const [body, setBody] = useState(() => readDraft(repoRoot).body);
  const [amend, setAmend] = useState(false);
  // True while the fields hold a message we filled in from HEAD — so unticking
  // amend can take it back out again, but never eats something you typed.
  const [prefilled, setPrefilled] = useState(false);

  // The persisted drafts land a beat after the session's first mount; adopt one
  // only if the box is still untouched (later mounts read the cache synchronously
  // above and skip this entirely).
  useEffect(() => {
    let alive = true;
    void hydrateDrafts().then(() => {
      if (!alive) return;
      const stored = readDraft(repoRoot);
      setSubject((s) => (s === "" ? stored.subject : s));
      setBody((b) => (b === "" ? stored.body : b));
    });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => {
    writeDraft(repoRoot, { subject, body });
  }, [repoRoot, subject, body]);

  // A landed commit empties the composer — including the draft, so reopening the
  // panel doesn't offer back a message that's already in the log.
  const lastCommitted = useRef(committedAt);
  useEffect(() => {
    if (committedAt === lastCommitted.current) return;
    lastCommitted.current = committedAt;
    setSubject("");
    setBody("");
    setAmend(false);
    setPrefilled(false);
    clearDraft(repoRoot);
  }, [committedAt, repoRoot]);

  const toggleAmend = (next: boolean) => {
    setAmend(next);
    if (next) {
      if (head && subject.trim() === "" && body.trim() === "") {
        setSubject(head.subject);
        setBody(head.body);
        setPrefilled(true);
      }
    } else if (prefilled && head && subject === head.subject && body === head.body) {
      setSubject("");
      setBody("");
      setPrefilled(false);
    }
  };

  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();
  const message = trimmedBody ? `${trimmedSubject}\n\n${trimmedBody}` : trimmedSubject;

  // Why each button is off, in words. A greyed control with no reason is exactly
  // the sort of thing the panel is meant to stop doing.
  const commitReason = busy
    ? "a git command is running"
    : !trimmedSubject
      ? "write a subject line first"
      : stagedCount === 0 && !amend
        ? "nothing staged — stage files, or use “commit all”"
        : null;
  const commitAllReason = busy
    ? "a git command is running"
    : !trimmedSubject
      ? "write a subject line first"
      : stagedCount === 0 && trackedDirtyCount === 0 && !amend
        ? "no tracked changes to commit"
        : null;

  const submit = (req: Omit<CommitRequest, "message">) => {
    if (req.stageAll ? commitAllReason : commitReason) return;
    onCommit({ ...req, message });
  };

  // Ctrl+Enter from either field is the commit gesture (⇧ isn't needed — nothing
  // else in the box wants the chord).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    submit({ amend, stageAll: false, push: false });
  };

  const willCommit = amend
    ? `amending ${head?.short ?? "HEAD"}${stagedCount > 0 ? ` + ${countLabel(stagedCount, "staged file")}` : ""}`
    : stagedCount > 0
      ? countLabel(stagedCount, "staged file")
      : "nothing staged";

  const overGuide = subject.length > SUBJECT_GUIDE;

  return (
    <div
      style={{
        flex: "0 0 auto",
        borderTop: "1px solid var(--wb-border)",
        background: "var(--wb-panel)",
        display: "flex",
        flexDirection: "column",
        padding: "0 0 8px",
      }}
    >
      <SectionHead>
        commit
        <span style={{ marginLeft: "auto", font: "9.5px var(--wb-mono)", textTransform: "none", letterSpacing: 0, color: stagedCount > 0 || amend ? "var(--wb-textDim2)" : "var(--wb-textFaint)" }}>
          {willCommit}
        </span>
      </SectionHead>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 14px 0" }}>
        {/* The subject, with a column ruler at the soft 72-col mark. */}
        <div style={{ position: "relative", overflow: "hidden", font: `12.5px var(--wb-mono)` }}>
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 1,
              bottom: 1,
              left: `calc(9px + ${SUBJECT_GUIDE}ch)`,
              width: 0,
              borderLeft: `1px dashed ${overGuide ? "var(--wb-working)" : "var(--wb-border)"}`,
              pointerEvents: "none",
            }}
          />
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={onKeyDown}
            placeholder="subject"
            spellCheck={false}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--wb-bg)",
              color: "var(--wb-text)",
              border: "1px solid var(--wb-border)",
              padding: "5px 9px",
              fontFamily: "var(--wb-mono)",
              fontSize: 12.5,
              outline: "none",
            }}
          />
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="body (optional) — ctrl+enter to commit"
          spellCheck={false}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--wb-bg)",
            color: "var(--wb-text)",
            border: "1px solid var(--wb-border)",
            padding: "5px 9px",
            fontFamily: "var(--wb-mono)",
            fontSize: 12,
            lineHeight: 1.45,
            outline: "none",
            resize: "vertical",
          }}
        />

        {amend && head?.pushed && (
          <div style={{ font: "10px var(--wb-mono)", color: "var(--wb-working)" }}>
            {GLYPH.warn} {head.short} is already on {head.upstream} — amending rewrites published history.
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <CheckLabel
            checked={amend}
            onChange={toggleAmend}
            disabled={busy || !head}
            title={head ? "replace the previous commit (prefills its message)" : "no commit to amend yet"}
          >
            amend
          </CheckLabel>
          <span
            style={{
              font: "9.5px var(--wb-mono)",
              color: overGuide ? "var(--wb-working)" : "var(--wb-textFaint)",
            }}
            title={`subject length — ${SUBJECT_GUIDE} columns is the conventional soft limit`}
          >
            {subject.length}/{SUBJECT_GUIDE}
          </span>

          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <HeaderButton
              onClick={() => submit({ amend, stageAll: true, push: false })}
              disabled={commitAllReason != null}
              title={commitAllReason ?? "commit staged changes plus every tracked modification (never untracked files)"}
            >
              commit all
            </HeaderButton>
            <HeaderButton
              onClick={() => submit({ amend, stageAll: false, push: true })}
              disabled={commitReason != null}
              title={
                commitReason ??
                (hasUpstream ? "commit, then push to the upstream" : "commit, then publish this branch")
              }
            >
              {hasUpstream ? "commit & push" : "commit & publish"}
            </HeaderButton>
            <HeaderButton
              onClick={() => submit({ amend, stageAll: false, push: false })}
              disabled={commitReason != null}
              accent
              title={commitReason ?? "commit the staged changes (ctrl+enter)"}
            >
              {amend ? "⌦ amend" : "✓ commit"}
            </HeaderButton>
          </span>
        </div>
      </div>
    </div>
  );
}

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
