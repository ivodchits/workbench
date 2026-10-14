// The phone's choice card (step R5): what a "needs you" session is asking, with a
// button per answer — the desktop card (`panels/ChoiceCard.tsx`) without React.
//
// It decides nothing: the prompt, its options and whether they can be answered here
// all come from the desktop in the snapshot (`RemoteInstance.choice`), and a tap
// sends `choose` with the prompt's id, which the desktop ignores once that prompt
// has closed. Two sizes: compact on a dashboard card, full in the transcript view,
// where the tool's arguments are drawn by the transcript renderer (the path that
// makes untrusted tool input safe to show).

import type { RemoteChoice } from "../remote/protocol";
import { renderPendingTool } from "../transcript/render";
import { el } from "./dom";

/** With no sign of the prompt closing this long after an answer, stop waiting and
 *  point at the terminal (never re-send: the key may have landed). */
const STALLED_MS = 4000;

const TITLE: Record<RemoteChoice["kind"], string> = {
  permission: "permission",
  question: "question",
  plan: "plan ready",
};

export interface ChoiceHandlers {
  /** Send an answer: an option's digit, or `deny` to dismiss the prompt. */
  choose: (choiceId: string, option: number | "deny") => void;
  /** Show the session's terminal, where the prompt itself is. */
  terminal: () => void;
}

export interface ChoiceCardView {
  root: HTMLElement;
  /** Show this prompt, or hide the card for null. Cheap when nothing changed. */
  update: (choice: RemoteChoice | null) => void;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One line on what is asked, for the compact card. */
function summary(c: RemoteChoice): string {
  if (c.kind === "question") return c.questions.length === 1 ? c.questions[0].question : `${c.questions.length} questions`;
  if (c.kind === "plan") return "the plan is ready for review";
  const input = c.input;
  if (c.toolName === "Bash") return str(input.description) || str(input.command).split("\n")[0];
  return str(input.file_path) || str(input.path) || str(input.url) || str(input.pattern) || "";
}

/** A card that redraws only when the prompt or its state changes, so a snapshot
 *  every couple of seconds doesn't reset a long plan's scroll. */
export function createChoiceCard(compact: boolean, on: ChoiceHandlers): ChoiceCardView {
  const root = el("div", `wb-chc pwa-chc hidden${compact ? " compact" : ""}`);
  let drawn = "";
  /** An answer tapped here, shown at once rather than after the next snapshot. */
  let tapped: { id: string; label: string } | null = null;
  /** When this page first saw the current prompt answered (its own clock). */
  let sentSeen: { id: string; at: number } | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let last: RemoteChoice | null = null;

  function sentLabel(c: RemoteChoice): string | null {
    return c.sent ?? (tapped?.id === c.id ? tapped.label : null);
  }

  function draw(c: RemoteChoice): void {
    const sent = sentLabel(c);
    const stalled = sentSeen?.id === c.id && Date.now() - sentSeen.at >= STALLED_MS;
    root.className = `wb-chc pwa-chc wb-chc-${c.kind}${compact ? " compact" : ""}`;

    const head = el("div", "wb-chc-head");
    const tool = c.kind === "permission" ? c.toolName : c.questions.length === 1 ? c.questions[0].header : "";
    head.append(el("span", "wb-chc-kind", `● ${TITLE[c.kind]}`), el("span", "wb-chc-tool", tool));

    const content = el("div", "wb-chc-content");
    if (compact) {
      const line = summary(c);
      if (line) content.append(el("div", "pwa-chc-summary", line));
    } else if (c.kind === "question") {
      for (const q of c.questions) {
        const block = el("div", "wb-chc-question");
        block.append(el("div", "wb-chc-question-text", q.question));
        // The one answerable question's options are the buttons below.
        if (c.terminalOnly || sent) {
          const list = el("ul");
          for (const o of q.options) {
            const li = el("li");
            li.append(el("b", "", o.label));
            if (o.description) li.append(el("span", "", ` — ${o.description}`));
            list.append(li);
          }
          block.append(list);
        }
        content.append(block);
      }
    } else {
      content.append(renderPendingTool(c.toolName, c.input));
    }

    const parts: HTMLElement[] = [head];
    if (content.childElementCount) parts.push(content);

    if (sent) {
      const note = el("div", "wb-chc-note", `sent: ${sent}`);
      if (stalled) {
        note.append(" — no sign it was taken.");
        const check = el("button", "", "check the terminal");
        check.type = "button";
        check.onclick = on.terminal;
        note.append(check);
      }
      parts.push(note);
    } else {
      if (c.terminalOnly) {
        parts.push(el("div", "wb-chc-note", c.terminalOnly));
      } else {
        const options = el("div", "wb-chc-options");
        for (const o of c.options) {
          const b = el("button", "wb-chc-option");
          b.type = "button";
          const label = el("span", "wb-chc-option-label", o.label);
          if (o.typed) label.append(el("span", "wb-chc-option-detail", " — typed in the terminal"));
          if (o.detail && !compact) label.append(el("span", "wb-chc-option-detail", ` — ${o.detail}`));
          b.append(el("span", "wb-chc-option-key", String(o.key)), label);
          b.onclick = () => {
            if (sentLabel(c)) return;
            tapped = { id: c.id, label: o.label };
            on.choose(c.id, o.key);
            refresh();
            // The digit only moved the TUI's cursor into a text field; the rest is typed.
            if (o.typed) on.terminal();
          };
          options.append(b);
        }
        parts.push(options);
      }
      const bar = el("div", "wb-chc-bar");
      const term = el("button", "", compact ? "terminal" : "answer in terminal");
      term.type = "button";
      term.onclick = on.terminal;
      const deny = el("button", "wb-chc-deny", c.kind === "permission" ? "deny" : "cancel");
      deny.type = "button";
      deny.onclick = () => {
        if (sentLabel(c)) return;
        tapped = { id: c.id, label: deny.textContent ?? "deny" };
        on.choose(c.id, "deny");
        refresh();
      };
      bar.append(term, deny);
      parts.push(bar);
    }
    root.replaceChildren(...parts);
  }

  function refresh(): void {
    const c = last;
    if (!c) return;
    const sent = sentLabel(c);
    if (sent && sentSeen?.id !== c.id) {
      sentSeen = { id: c.id, at: Date.now() };
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stallTimer = null;
        drawn = "";
        refresh();
      }, STALLED_MS);
    }
    const stalled = sentSeen?.id === c.id && Date.now() - sentSeen.at >= STALLED_MS;
    const key = JSON.stringify([c.id, c.options, c.terminalOnly, c.questions.length, sent, stalled]);
    if (key === drawn) return;
    drawn = key;
    draw(c);
  }

  function update(choice: RemoteChoice | null): void {
    last = choice;
    if (!choice) {
      if (drawn) root.replaceChildren();
      drawn = "";
      tapped = null;
      sentSeen = null;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
      root.classList.add("hidden");
      return;
    }
    if (tapped && tapped.id !== choice.id) tapped = null;
    refresh();
  }

  return { root, update };
}
