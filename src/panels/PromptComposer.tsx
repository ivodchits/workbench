// Prompt composer (step T4) — the input docked under a console's transcript, so a
// prompt → answer → follow-up loop never needs the terminal.
//
// It does not talk to Claude itself. Sending is the same paste-and-submit into
// the session's PTY that the prompt queue and the template library use
// (`promptDelivery`): the terminal stays the one way the session is driven, and
// the prompt shows up in the transcript because Claude wrote it there.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { GLYPH } from "../theme";
import { INTERRUPT_KEY, ptyWrite } from "../ipc/pty";
import { submitPrompt } from "./terminalPool";
import { sendOrQueue } from "./promptDelivery";
import { COMPOSER_ATTR, setDraft, spliceText, terminalCommand, useDraft } from "../state/composer";
import { atRest, cancelQueued, useQueued } from "../state/queue";
import { markInterrupted, type LiveStatus } from "../state/status";
import { useTemplates, type PromptTemplate } from "../state/templates";
import { flash } from "../util/flash";

interface PromptComposerProps {
  instanceId: string;
  live: LiveStatus | null;
  /** Switch the console to its terminal (for a command that answers there). */
  onShowTerminal: () => void;
  /** A prompt left the composer — the view follows the conversation's end again. */
  onSent: () => void;
}

/** The field grows with its text up to this height, then scrolls. */
const MAX_FIELD_PX = 190;

function PromptComposer({ instanceId, live, onShowTerminal, onSent }: PromptComposerProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const draft = useDraft(instanceId);
  const queued = useQueued().get(instanceId) ?? null;
  const [picking, setPicking] = useState(false);
  /** Where the caret goes once an inserted template has rendered. */
  const pendingSelection = useRef<[number, number] | null>(null);

  const resting = atRest(live);
  const working = live?.phase === "working" && !live.compacting;
  const canSend = draft.trim().length > 0;

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    // `scrollHeight` leaves out the border, which the border-box height includes.
    const wanted = field.scrollHeight + (field.offsetHeight - field.clientHeight);
    field.style.height = `${Math.min(wanted, MAX_FIELD_PX)}px`;
    field.style.overflowY = wanted > MAX_FIELD_PX ? "auto" : "hidden";
    if (pendingSelection.current) {
      field.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [draft]);

  const send = () => {
    if (!canSend) return;
    const command = terminalCommand(draft);
    if (command) {
      // Its menu (or its output) only exists in the TUI.
      if (!resting) {
        flash(`/${command} answers in the terminal — send it when this turn has finished`);
        return;
      }
      submitPrompt(instanceId, draft.trim());
      setDraft(instanceId, "");
      flash(`/${command} answers in the terminal`);
      onShowTerminal();
      return;
    }
    sendOrQueue(instanceId, draft);
    setDraft(instanceId, "");
    onSent();
  };

  const interrupt = () => {
    void ptyWrite(instanceId, INTERRUPT_KEY);
    markInterrupted(instanceId); // interrupting fires no hook — update the dot ourselves
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a line break — as in the terminal (step C1).
    // Not while an input method is composing: there Enter confirms the word.
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  return (
    <div className="wb-cmp">
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
          <button type="button" onClick={editQueued} title="take it back into the field">
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
        onChange={(e) => setDraft(instanceId, e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="wb-cmp-bar">
        <span className="wb-cmp-hint">
          {resting ? (
            <>
              <b>↵</b> send · <b>⇧↵</b> new line
            </>
          ) : live?.phase === "needs_you" ? (
            <>
              waiting on you — <b>↵</b> holds this until the turn is over
            </>
          ) : (
            <>
              {live?.compacting ? "compacting" : "working"} — <b>↵</b> queues this for the end of
              the turn
            </>
          )}
        </span>
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
            title="interrupt the agent (Esc in the terminal)"
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
