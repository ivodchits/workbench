// Choice card (step T5) — what a "needs you" agent is asking, shown over the
// composer, with a button per answer.
//
// It never answers for the session: a button sends the same key you would press
// in the terminal (`answerChoice`, the one keystroke mapping), and the card only
// goes away when the prompt is seen to close (`state/pendingChoice`). Prompts the
// card can't answer safely — several questions, multi-select, free text — show
// what is asked and send you to the terminal.

import { useEffect, useRef, useState } from "react";

import { readScreen } from "./terminalPool";
import { getDraft } from "../state/composer";
import {
  markChoiceSent,
  parseOptionRows,
  READ_AT_MS,
  setTerminalOptions,
  type ChoiceOption,
  type PendingChoice,
} from "../state/pendingChoice";
import { answerChoice } from "../state/remoteActions";
import { useChoiceAdvice } from "../state/choiceAdvice";
import { renderPendingTool } from "../transcript/render";
import { planRef } from "../transcript/feed";
import { openPlan } from "./openPlan";

interface ChoiceCardProps {
  instanceId: string;
  choice: PendingChoice;
  /** Switch the console to its terminal, where the prompt itself is. */
  onShowTerminal: () => void;
}

/** With no sign of the prompt closing this long after an answer was sent, stop
 *  waiting and point at the terminal (never re-send: the key may have landed). */
const STALLED_MS = 4000;

const TITLE: Record<PendingChoice["kind"], string> = {
  permission: "permission",
  question: "question",
  plan: "plan ready",
};

function ChoiceCard({ instanceId, choice, onShowTerminal }: ChoiceCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [stalled, setStalled] = useState(false);
  const { id, kind, toolName, input, source } = choice;
  const held = choice.held !== null;
  // Duck's suggested answer or plan review (step T3).
  const advice = useChoiceAdvice(instanceId, id);

  // What is being asked, drawn by the transcript renderer (which is what makes
  // tool input — untrusted text — safe to show).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || kind === "question") return;
    body.replaceChildren(renderPendingTool(toolName, input));
    return () => body.replaceChildren();
  }, [id, kind, toolName, input]);

  // A permission or plan prompt's options are only on the terminal screen.
  useEffect(() => {
    // A held prompt (T4) has no menu on screen until it is released.
    if (source !== "generic" || held) return;
    const timers = READ_AT_MS.map((ms) =>
      setTimeout(() => {
        const screen = readScreen(instanceId);
        const options = screen && parseOptionRows(screen);
        if (options) setTerminalOptions(instanceId, id, options);
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [instanceId, id, source, held]);

  // Take the keyboard when the prompt arrives — but only from this console's own
  // view, and not while a prompt is being written there.
  useEffect(() => {
    const card = rootRef.current;
    const active = document.activeElement;
    const here = active === document.body || card?.parentElement?.contains(active);
    if (card && here && !getDraft(instanceId).trim()) card.focus({ preventScroll: true });
  }, [instanceId, id]);

  const sentAt = choice.sent?.at ?? null;
  useEffect(() => {
    setStalled(false);
    if (sentAt === null) return;
    const timer = setTimeout(() => setStalled(true), STALLED_MS);
    return () => clearTimeout(timer);
  }, [id, sentAt]);

  const pick = (option: ChoiceOption) => {
    if (choice.sent) return;
    answerChoice(instanceId, { option: option.key });
    markChoiceSent(instanceId, id, option.label);
    // The digit only moved the TUI's cursor into a text field; the rest is typed.
    if (option.typed) onShowTerminal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target !== rootRef.current) return;
    if (e.key === "Escape") {
      answerChoice(instanceId, "deny");
    } else {
      const option = /^[1-9]$/.test(e.key) && choice.options.find((o) => o.key === Number(e.key));
      if (!option) return; // anything else is typing: the view sends it to the composer
      pick(option);
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const question = kind === "question" ? choice.questions[0] : null;
  const canAnswer = !choice.terminalOnly && !choice.sent;

  return (
    <div
      ref={rootRef}
      className={`wb-chc wb-chc-${kind}`}
      tabIndex={0}
      role="group"
      aria-label={`${TITLE[kind]} — the agent is waiting for an answer`}
      onKeyDown={onKeyDown}
    >
      <div className="wb-chc-head">
        <span className="wb-chc-kind">● {TITLE[kind]}</span>
        <span className="wb-chc-tool">
          {kind === "permission" ? toolName : choice.questions.length === 1 ? question?.header : ""}
        </span>
        <span className="wb-chc-keys">
          {canAnswer && (
            <>
              <b>1</b>–<b>{Math.max(1, choice.options.length)}</b> choose · <b>esc</b>{" "}
              {kind === "permission" ? "deny" : "cancel"}
            </>
          )}
        </span>
      </div>

      <div className="wb-chc-content">
        {kind === "question" ? (
          choice.questions.map((q, i) => (
            <div key={i} className="wb-chc-question">
              <div className="wb-chc-question-text">{q.question}</div>
              {/* The one answerable question's options are the buttons below. */}
              {(choice.terminalOnly || choice.sent) && (
                <ul>
                  {q.options.map((o, n) => (
                    <li key={n}>
                      <b>{o.label}</b>
                      {o.description && <span> — {o.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        ) : (
          <div
            ref={bodyRef}
            // The plan's "open plan" (step P1): open it beside the console to read
            // before answering. Its id is the tool call's, as on the transcript card.
            onClick={(e) => {
              if (!(e.target instanceof Element) || !e.target.closest(".wb-tx-open-plan")) return;
              const text = typeof input.plan === "string" ? input.plan : "";
              if (text.trim()) openPlan(instanceId, planRef(choice.toolUseId ?? id, text, null));
            }}
          />
        )}
      </div>

      {advice && <div className={`wb-chc-advice wb-chc-advice-${advice.tone}`}>{advice.text}</div>}

      {choice.sent ? (
        <div className="wb-chc-note">
          sent: {choice.sent.label}
          {stalled && (
            <>
              {" "}
              — no sign it was taken.
              <button type="button" onClick={onShowTerminal}>
                check the terminal
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {choice.terminalOnly ? (
            <div className="wb-chc-note">{choice.terminalOnly}</div>
          ) : (
            <div className="wb-chc-options">
              {choice.options.map((o) => (
                <button key={o.key} type="button" className="wb-chc-option" onClick={() => pick(o)}>
                  <span className="wb-chc-option-key">{o.key}</span>
                  <span className="wb-chc-option-label">
                    {o.label}
                    {o.typed && <span className="wb-chc-option-detail"> — typed in the terminal</span>}
                    {o.detail && <span className="wb-chc-option-detail"> — {o.detail}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="wb-chc-bar">
            <button type="button" onClick={onShowTerminal}>
              answer in terminal
            </button>
            <button
              type="button"
              className="wb-chc-deny"
              onClick={() => answerChoice(instanceId, "deny")}
              title="Esc in the terminal: dismiss the prompt and end the turn"
            >
              {kind === "permission" ? "deny" : "cancel"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default ChoiceCard;
