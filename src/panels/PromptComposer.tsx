// Prompt composer (step T4) — the input docked under a console's transcript, so a
// prompt → answer → follow-up loop never needs the terminal.
//
// It does not talk to Claude itself. Sending is the same paste-and-submit into
// the session's PTY that the prompt queue and the template library use
// (`promptDelivery`): the terminal stays the one way the session is driven, and
// the prompt shows up in the transcript because Claude wrote it there.
//
// The mic button records a voice message (`voiceNote`): its transcript lands in
// the field, to read over and send with ↵ — never sent unseen, since a
// misheard word in a prompt costs a turn.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { GLYPH } from "../theme";
import { submitPrompt } from "./terminalPool";
import { deliverQueued, sendOrQueue, starting as sessionStarting } from "./promptDelivery";
import { savePastedImage } from "../ipc/os";
import {
  COMPOSER_ATTR,
  imageToken,
  insertReferences,
  promptHistory,
  rememberSent,
  sentPrompts,
  setDraft,
  spliceText,
  terminalCommand,
  useDraft,
} from "../state/composer";
import { atRest, cancelQueued, useQueued } from "../state/queue";
import type { LiveStatus } from "../state/status";
import { isHeadless } from "../state/headless";
import { interruptSession } from "../state/remoteActions";
import { useTemplates, type PromptTemplate } from "../state/templates";
import { clock } from "../util/dictation";
import { flash } from "../util/flash";
import { cancelNote, dismissNoteError, NOTE_MAX_S, startNote, stopNote, useNoteState } from "./voiceNote";

interface PromptComposerProps {
  instanceId: string;
  live: LiveStatus | null;
  /** What the user typed in the conversation, newest first (from its transcript). */
  typed: readonly string[];
  /** Switch the console to its terminal (for a command that answers there). */
  onShowTerminal: () => void;
  /** A prompt left the composer — the view follows the conversation's end again. */
  onSent: () => void;
}

/** The field grows with its text up to this height, then scrolls — unless the
 *  user has dragged it to a size of their own (the grip on its top edge). */
const MAX_FIELD_PX = 190;
/** The smallest a dragged field gets, and the room it always leaves the transcript. */
const MIN_FIELD_PX = 40;
const TRANSCRIPT_ROOM_PX = 80;
/** A dragged size is kept for every console and across restarts. */
const SIZE_KEY = "wb.composer.fieldPx";

function loadFieldPx(): number | null {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return Number.isFinite(n) && n >= MIN_FIELD_PX ? n : null;
  } catch {
    return null;
  }
}

function saveFieldPx(px: number | null) {
  try {
    if (px === null) localStorage.removeItem(SIZE_KEY);
    else localStorage.setItem(SIZE_KEY, String(Math.round(px)));
  } catch {
    // Not kept — it still applies until the window closes.
  }
}
/** How often a console with no hook signal yet is checked for having started. */
const STARTING_POLL_MS = 500;

/** True while the console hasn't started its session (`promptDelivery.starting`):
 *  claude is showing a dialog in its terminal. Looked at only while no hook has
 *  come from it — the first one means it has started. */
function useStarting(instanceId: string, live: LiveStatus | null): boolean {
  const [starting, setStarting] = useState(() => !live && sessionStarting(instanceId));
  useEffect(() => {
    if (live) {
      setStarting(false);
      return;
    }
    const check = () => setStarting(sessionStarting(instanceId));
    check();
    const timer = setInterval(check, STARTING_POLL_MS);
    return () => clearInterval(timer);
  }, [instanceId, live]);
  return starting;
}

function PromptComposer({ instanceId, live, typed, onShowTerminal, onSent }: PromptComposerProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The height the user dragged the field to, or null to fit its text. */
  const [fieldPx, setFieldPx] = useState<number | null>(loadFieldPx);
  const draft = useDraft(instanceId);
  const queued = useQueued().get(instanceId) ?? null;
  const [picking, setPicking] = useState(false);
  /** Where the caret goes once an inserted template has rendered. */
  const pendingSelection = useRef<[number, number] | null>(null);
  /** The past prompt ↑/↓ put in the field (its index in `promptHistory`), or -1. */
  const recalled = useRef(-1);

  const startingUp = useStarting(instanceId, live);
  const resting = atRest(live) && !startingUp;
  const working = live?.phase === "working" && !live.compacting;
  const canSend = draft.trim().length > 0;

  const note = useNoteState();
  const noteHere = note.instanceId === instanceId ? note.phase : "idle";
  const noteElsewhere = note.phase !== "idle" && note.instanceId !== instanceId;
  const noteError = note.error?.instanceId === instanceId ? note.error.text : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (noteHere !== "recording") return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [noteHere]);
  const noteSeconds = noteHere === "recording" ? Math.floor((Date.now() - note.since) / 1000) : 0;
  // A transcript that just landed: the caret goes to its end, ready for ↵.
  const wasTranscribing = useRef(false);
  useEffect(() => {
    if (wasTranscribing.current && noteHere === "idle" && !noteError) {
      const field = fieldRef.current;
      if (field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
    wasTranscribing.current = noteHere === "transcribing";
  }, [noteHere, noteError]);

  const toggleNote = () => {
    if (noteHere === "recording") void stopNote();
    else if (noteHere === "idle") void startNote(instanceId);
  };

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    // `scrollHeight` leaves out the border, which the border-box height includes.
    const wanted = field.scrollHeight + (field.offsetHeight - field.clientHeight);
    const height = fieldPx === null ? Math.min(wanted, MAX_FIELD_PX) : Math.min(fieldPx, largestFieldPx());
    field.style.height = `${height}px`;
    field.style.overflowY = wanted > height ? "auto" : "hidden";
    if (pendingSelection.current) {
      field.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [draft, fieldPx]);

  /** The tallest the field may be dragged: the transcript above keeps some room. */
  const largestFieldPx = (): number => {
    const root = rootRef.current;
    const field = fieldRef.current;
    const host = root?.parentElement;
    if (!root || !field || !host) return Infinity;
    const chrome = root.offsetHeight - field.offsetHeight;
    return Math.max(MIN_FIELD_PX, host.clientHeight - chrome - TRANSCRIPT_ROOM_PX);
  };

  /** Dragging the grip up makes the field taller, down shorter. */
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const field = fieldRef.current;
    if (!field || e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startPx = field.offsetHeight;
    const most = largestFieldPx();
    let px = startPx;
    const onMove = (ev: PointerEvent) => {
      px = Math.max(MIN_FIELD_PX, Math.min(most, startPx + (startY - ev.clientY)));
      setFieldPx(px);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      saveFieldPx(px);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  };

  /** Double-clicking the grip goes back to fitting the text. */
  const resetFieldPx = () => {
    setFieldPx(null);
    saveFieldPx(null);
    fieldRef.current?.focus();
  };

  const send = () => {
    if (!canSend) return;
    const command = terminalCommand(draft);
    if (command) {
      // Its menu (or its output) only exists in the TUI, which a headless worker
      // (D4) doesn't have.
      if (isHeadless(instanceId)) {
        flash(`/${command} needs a terminal — take the worker over first`);
        return;
      }
      if (startingUp) {
        flash(`claude hasn't started — answer its dialog in the terminal, then send /${command}`);
        onShowTerminal();
        return;
      }
      if (!resting) {
        flash(`/${command} answers in the terminal — send it when this turn has finished`);
        return;
      }
      submitPrompt(instanceId, draft.trim());
      rememberSent(instanceId, draft);
      recalled.current = -1;
      setDraft(instanceId, "");
      flash(`/${command} answers in the terminal`);
      onShowTerminal();
      return;
    }
    if (sendOrQueue(instanceId, draft) === "queued" && startingUp)
      flash("claude hasn't started — answer its dialog in the terminal; this goes in once its prompt box shows");
    rememberSent(instanceId, draft);
    recalled.current = -1;
    setDraft(instanceId, "");
    onSent();
  };

  const interrupt = () => {
    interruptSession(instanceId);
    fieldRef.current?.focus();
  };

  /** Take the queued prompt back into the field to change it. */
  const editQueued = () => {
    if (!queued) return;
    setDraft(instanceId, draft.trim() ? `${queued.text}\n${draft}` : queued.text);
    cancelQueued(instanceId);
    fieldRef.current?.focus();
  };

  const insertTemplate = (template: PromptTemplate) => {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? draft.length;
    const next = spliceText(draft, start, end, template.body);
    pendingSelection.current = next.selection;
    setDraft(instanceId, next.text);
    setPicking(false);
    field?.focus();
  };

  /** An image on the clipboard is saved to a temp file and put at the caret as an
   *  `[image …]` token, which becomes an attachment when the prompt is sent
   *  (`terminalPool`). Text pastes are left to the field. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    void Promise.all(
      images.map(async (f) =>
        savePastedImage(new Uint8Array(await f.arrayBuffer()), f.type.slice("image/".length)),
      ),
    )
      .then((names) => insertReferences(instanceId, names.map((n) => `${imageToken(n)} `).join("")))
      .catch((err) => flash(`couldn't paste the image: ${String(err)}`));
  };

  /** ↑ in an empty field (or on the first line of a prompt it recalled) puts the
   *  previous prompt in it, ↓ on its last line the next one — and past the
   *  newest, an empty field again. Once the text is edited it is a draft like any
   *  other, and the arrows just move the caret. */
  const recall = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const field = e.currentTarget;
    const sent = promptHistory(sentPrompts(instanceId), typed);
    const at = recalled.current;
    if (at >= 0 ? draft !== sent[at] : draft !== "") return false;
    if (field.selectionStart !== field.selectionEnd) return false;
    const caret = field.selectionStart;
    if (e.key === "ArrowUp") {
      if (draft.lastIndexOf("\n", caret - 1) >= 0 || at + 1 >= sent.length) return false;
      recalled.current = at + 1;
    } else {
      if (at < 0 || draft.indexOf("\n", caret) >= 0) return false;
      recalled.current = at - 1;
    }
    const text = recalled.current >= 0 ? sent[recalled.current] : "";
    pendingSelection.current = [text.length, text.length];
    setDraft(instanceId, text);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      recall(e)
    ) {
      e.preventDefault();
      return;
    }
    // Esc in an empty field takes the queued prompt back into it, or else stops
    // the agent, as Esc does in the terminal. With text in the field it does nothing.
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      // Esc drops a voice message that's recording, before anything else.
      if (noteHere === "recording" || noteHere === "starting") {
        cancelNote();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (draft) return;
      if (queued) editQueued();
      else if (working) interrupt();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Enter sends, Shift+Enter is a line break — as in the terminal (step C1).
    // Not while an input method is composing: there Enter confirms the word.
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // Ctrl+Enter in an empty field force-sends the queued prompt, like its button.
    if (e.ctrlKey && !canSend) {
      if (queued && live?.phase !== "needs_you") deliverQueued(instanceId);
      return;
    }
    send();
  };

  return (
    <div className="wb-cmp" ref={rootRef}>
      <div
        className={fieldPx === null ? "wb-cmp-grip" : "wb-cmp-grip wb-cmp-grip-set"}
        role="separator"
        aria-orientation="horizontal"
        aria-label="resize the prompt field"
        title="drag to resize the prompt field · double-click to fit the text again"
        onPointerDown={onGripDown}
        onDoubleClick={resetFieldPx}
      />
      {picking && (
        <TemplateMenu
          onPick={insertTemplate}
          onClose={() => {
            setPicking(false);
            fieldRef.current?.focus();
          }}
        />
      )}
      {queued && (
        <div className="wb-cmp-queued">
          <span className="wb-cmp-queued-label">{GLYPH.queue} queued</span>
          <span className="wb-cmp-queued-text" title={queued.text}>
            {queued.text.replace(/\s+/g, " ").trim()}
          </span>
          <button
            type="button"
            onClick={() => deliverQueued(instanceId)}
            disabled={live?.phase === "needs_you"}
            title={
              live?.phase === "needs_you"
                ? "can't send while claude is waiting on you — it could answer the prompt"
                : "send it now, without waiting for the turn to end (Ctrl+↵ in an empty field)"
            }
          >
            force send
          </button>
          <button type="button" onClick={editQueued} title="take it back into the field (Esc in an empty field)">
            edit
          </button>
          <button
            type="button"
            onClick={() => cancelQueued(instanceId)}
            title="drop the queued prompt"
          >
            cancel
          </button>
        </div>
      )}
      <textarea
        ref={fieldRef}
        className="wb-cmp-field"
        {...{ [COMPOSER_ATTR]: instanceId }}
        value={draft}
        rows={1}
        spellCheck={false}
        placeholder="prompt claude…"
        aria-label="prompt"
        onChange={(e) => {
          recalled.current = -1;
          setDraft(instanceId, e.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="wb-cmp-bar">
        {noteHere !== "idle" || noteError ? (
          <span className={noteError ? "wb-cmp-hint wb-cmp-voice-error" : "wb-cmp-hint wb-cmp-voice"} role="status">
            {noteHere === "starting" ? (
              "opening the microphone…"
            ) : noteHere === "recording" ? (
              <>
                <span className="wb-cmp-voice-dot">●</span> recording {clock(noteSeconds)}
                {noteSeconds >= NOTE_MAX_S - 10 && ` (stops at ${clock(NOTE_MAX_S)})`} — <b>■</b> puts the text in
                the field · <b>Esc</b> drops it
              </>
            ) : noteHere === "transcribing" ? (
              "transcribing…"
            ) : (
              <>
                {noteError}{" "}
                <button type="button" onClick={() => dismissNoteError(instanceId)} title="dismiss">
                  ✕
                </button>
              </>
            )}
          </span>
        ) : (
        <span className="wb-cmp-hint">
          {startingUp ? (
            <>
              claude hasn't started — answer its dialog in the terminal; <b>↵</b> holds this
              until it has
            </>
          ) : resting ? (
            <>
              <b>↵</b> send · <b>⇧↵</b> new line
              {!draft && promptHistory(sentPrompts(instanceId), typed).length > 0 && (
                <>
                  {" "}
                  · <b>↑</b> past prompts
                </>
              )}
            </>
          ) : live?.phase === "needs_you" ? (
            <>
              waiting on you — <b>↵</b> holds this until the turn is over
            </>
          ) : (
            <>
              {live?.compacting ? "compacting" : "working"} — <b>↵</b> queues this for the end of
              the turn
              {queued && !canSend && (
                <>
                  {" "}
                  · <b>Ctrl+↵</b> force send
                </>
              )}
            </>
          )}
        </span>
        )}
        {(noteHere === "recording" || noteHere === "starting") && (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancelNote} title="drop the recording (Esc)">
            cancel
          </button>
        )}
        <button
          type="button"
          className={noteHere === "recording" ? "wb-cmp-mic wb-cmp-mic-on" : "wb-cmp-mic"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleNote}
          disabled={noteElsewhere || noteHere === "starting" || noteHere === "transcribing"}
          aria-label={noteHere === "recording" ? "stop recording and transcribe" : "record a voice message"}
          title={
            noteElsewhere
              ? "the microphone is recording for another session"
              : noteHere === "recording"
                ? "stop; the text goes into the field to check and send"
                : "record a voice message — transcribed on this PC into the field (English, Russian, Spanish…)"
          }
        >
          {noteHere === "recording" ? "■ stop" : noteHere === "transcribing" ? "…" : "🎤"}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPicking((p) => !p)}
          title="insert a prompt template"
        >
          templates
        </button>
        {working && (
          <button
            type="button"
            className="wb-cmp-stop"
            onClick={interrupt}
            title="interrupt the agent (Esc in an empty field)"
          >
            ■ stop
          </button>
        )}
        <button type="button" className="wb-cmp-send" disabled={!canSend} onClick={send}>
          {resting ? "send" : queued ? "replace queued" : "queue"}
        </button>
      </div>
    </div>
  );
}

/** The template library's templates as a pick list over the composer. Picking
 *  inserts the body at the caret; placeholders (`{0}`) stay as text to type over.
 *  Creating and editing templates stays in the library (Ctrl+Shift+P). */
function TemplateMenu({
  onPick,
  onClose,
}: {
  onPick: (t: PromptTemplate) => void;
  onClose: () => void;
}) {
  const { global, project } = useTemplates();
  const all = [...project, ...global];
  const rootRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Clicking anywhere else dismisses it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setIndex((i) => Math.min(all.length - 1, i + 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && all[index]) onPick(all[index]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={rootRef} className="wb-cmp-menu" tabIndex={-1} role="listbox" onKeyDown={onKeyDown}>
      {all.length === 0 && (
        <div className="wb-cmp-menu-empty">no templates yet — the library makes them</div>
      )}
      {all.map((t, i) => (
        <div
          key={t.id}
          role="option"
          aria-selected={i === index}
          className={i === index ? "wb-cmp-menu-item wb-cmp-menu-current" : "wb-cmp-menu-item"}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(t);
          }}
        >
          <span className="wb-cmp-menu-name">{t.name}</span>
          <span className="wb-cmp-menu-body">{t.body.replace(/\s+/g, " ").trim()}</span>
        </div>
      ))}
    </div>
  );
}

export default PromptComposer;
