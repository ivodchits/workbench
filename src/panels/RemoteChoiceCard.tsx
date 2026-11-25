// The card for a prompt another machine's session waits on (fleet plan F9.2), over
// its transcript in a remote console tab: from that machine's snapshot, answered
// with `choose`. The remote counterpart of `ChoiceCard`.

import { useEffect, useRef, useState } from "react";

import type { RemoteChoice } from "../remote/protocol";
import { renderPendingTool } from "../transcript/render";
import { sendRemote } from "./remoteSession";

const KIND_TITLE: Record<RemoteChoice["kind"], string> = { permission: "permission", question: "question", plan: "plan ready" };

export default function RemoteChoiceCard({
  machine,
  instance,
  choice,
  onShowTerminal,
}: {
  machine: string;
  instance: string;
  choice: RemoteChoice;
  onShowTerminal: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => setSent(null), [choice.id]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || choice.kind === "question") return;
    body.replaceChildren(renderPendingTool(choice.toolName, choice.input));
    return () => body.replaceChildren();
  }, [choice.id, choice.kind, choice.toolName, choice.input]);

  const choose = (option: number | "deny", label: string) => {
    sendRemote(machine, { type: "choose", instanceId: instance, choiceId: choice.id, option });
    setSent(label);
  };
  const shownSent = choice.sent ?? sent;

  return (
    <div className={`wb-chc wb-chc-${choice.kind}`} role="group" aria-label={`${KIND_TITLE[choice.kind]} — waiting for an answer`}>
      <div className="wb-chc-head">
        <span className="wb-chc-kind">● {KIND_TITLE[choice.kind]}</span>
        <span className="wb-chc-tool">{choice.kind === "permission" ? choice.toolName : choice.questions[0]?.header ?? ""}</span>
      </div>
      <div className="wb-chc-content">
        {choice.kind === "question" ? (
          choice.questions.map((q, i) => (
            <div key={i} className="wb-chc-question">
              <div className="wb-chc-question-text">{q.question}</div>
            </div>
          ))
        ) : (
          <div ref={bodyRef} />
        )}
      </div>
      {shownSent ? (
        <div className="wb-chc-note">sent: {shownSent}</div>
      ) : (
        <>
          {choice.terminalOnly ? (
            <div className="wb-chc-note">{choice.terminalOnly}</div>
          ) : (
            <div className="wb-chc-options">
              {choice.options.map((o) => (
                <button key={o.key} type="button" className="wb-chc-option" onClick={() => choose(o.key, o.label)}>
                  <span className="wb-chc-option-key">{o.key}</span>
                  <span className="wb-chc-option-label">
                    {o.label}
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
            <button type="button" className="wb-chc-deny" onClick={() => choose("deny", choice.kind === "permission" ? "deny" : "cancel")}>
              {choice.kind === "permission" ? "deny" : "cancel"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
