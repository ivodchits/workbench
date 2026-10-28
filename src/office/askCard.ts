// Answering from the bubbles (office plan O3.3): clicking a worker's `!` or `?` opens
// the phone's compact choice card (`pwa/choice.ts`) right by the bubble, so a prompt is
// answered in two clicks without the sidebar. A session that needs you with no card
// (Workbench can't read the prompt) gets approve and deny instead, as in the sidebar.
// It closes once the session stops asking, on ✕, Esc or a click elsewhere; "session"
// opens the whole thing in the sidebar.

import { createChoiceCard } from "../pwa/choice";
import { el } from "../pwa/dom";
import type { Who } from "./describe";
import type { Link } from "./net";

export interface AskCard {
  /** Whose bubble it's open for: a worker's id or `desk:<index>`; null when closed. */
  readonly id: string | null;
  /** Open for `id` (who `who` is), or close for null. */
  show(id: string | null, who: Who | null): void;
  /** Each snapshot: who `id` is now. Closes once they stop asking. */
  update(who: Who | null): void;
  /** Sits above (or, with no room, below) a bubble at `x`, `top`..`bottom` in the
   *  stage's pixels, inside `width` × `height`. */
  place(x: number, top: number, bottom: number, width: number, height: number): void;
}

export interface AskHooks {
  close(): void;
  /** Open the session in the sidebar. */
  open(id: string): void;
}

/** Room left between the card and the bubble, and round the stage's edge. */
const GAP = 6;

export function createAskCard(root: HTMLElement, link: Link, hooks: AskHooks): AskCard {
  const name = el("span", "who");
  const open = el("button", "open", "session ›");
  open.title = "open the session in the sidebar";
  const close = el("button", "close", "✕");
  close.title = "close (Esc)";
  const head = el("header");
  head.append(name, open, close);

  let current: string | null = null;
  let instanceId: string | null = null;
  const card = createChoiceCard(true, {
    choose: (choiceId, option) => void (instanceId && link.send({ type: "choose", instanceId, choiceId, option })),
    // There's no terminal here: an answer that needs one is the session's, in the sidebar.
    terminal: () => current && hooks.open(current),
  });
  const needs = el("div", "needs");
  const approve = el("button", "ok", "✓ approve");
  const deny = el("button", "no", "✗ deny");
  needs.append(approve, deny);
  for (const b of [open, close, approve, deny]) b.type = "button";
  for (const [b, type] of [
    [approve, "approve"],
    [deny, "deny"],
  ] as const) {
    b.onclick = () => void (instanceId && link.send({ type, instanceId }));
  }
  open.onclick = () => current && hooks.open(current);
  close.onclick = () => hooks.close();
  root.replaceChildren(head, card.root, needs);

  function paint(who: Who | null): boolean {
    const i = who?.instance;
    if (!i || i.phase !== "needs_you") return false;
    instanceId = i.id;
    name.textContent = `${who.worker?.name ?? "A contractor"} asks`;
    card.update(i.choice ?? null);
    needs.hidden = !!i.choice;
    return true;
  }

  return {
    get id() {
      return current;
    },
    show(id, who) {
      if (id && id === current) return;
      current = id && paint(who) ? id : null;
      root.hidden = !current;
      if (!current) {
        instanceId = null;
        card.update(null);
      }
    },
    update(who) {
      if (current && !paint(who)) hooks.close();
    },
    place(x, top, bottom, width, height) {
      if (!current) return;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const above = top - GAP - h >= GAP || bottom + GAP + h > height - GAP;
      root.style.left = `${Math.round(Math.min(Math.max(GAP, x - w / 2), width - w - GAP))}px`;
      root.style.top = `${Math.round(Math.max(GAP, above ? top - GAP - h : bottom + GAP))}px`;
    },
  };
}
