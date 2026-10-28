// The sidebar's session panel (office plan O1.5): what opens when you click a worker.
// The header says who they are and what their session is doing; under it the pending
// choice, the tail of the transcript, and a prompt box with interrupt and stop.
//
// The phone's pieces do the work: its choice card (`pwa/choice.ts`) answers with
// `choose`, and the transcript is the desktop's feed and renderer over the office's
// transcript socket (`pwa/transcriptSource.ts`), which takes the same query as the
// phone's. Everything acts through the ordinary actions (`prompt`, `choose`,
// `approve` / `deny`, `interrupt`, `stop`, `start`); Workbench decides what they do.

import type { RemoteInstance } from "../remote/protocol";
import { createChoiceCard } from "../pwa/choice";
import { el } from "../pwa/dom";
import { transcriptSource } from "../pwa/transcriptSource";
import { createFeed, type Feed } from "../transcript/feed";
import { createRenderer, type TranscriptRenderer } from "../transcript/render";
import { phaseText, titleOf, whoText, type Who } from "./describe";
import type { Link } from "./net";

/** Closer than this to the end counts as "at the bottom". */
const STICK_PX = 48;
/** The second click on stop has to come within this. */
const CONFIRM_MS = 3000;

/** The rail's glyphs. */
const GLYPH: Record<string, string> = { working: "◐", needs_you: "●", done: "○", idle: "·", ended: "–" };

export interface Panel {
  /** Show `who`, or close for null. Cheap to call on every snapshot. */
  show(who: Who | null): void;
}

/** The panel in `root`; ✕ calls `onClose`. */
export function createPanel(root: HTMLElement, link: Link, onClose: () => void): Panel {
  const close = el("button", "close", "✕");
  close.type = "button";
  close.title = "close (Esc)";
  const name = el("h2");
  const what = el("p", "what");
  const state = el("p", "state");
  const head = el("header");
  head.append(close, name, what, state);

  const card = createChoiceCard(false, {
    choose: (choiceId, option) => void (current && link.send({ type: "choose", instanceId: current, choiceId, option })),
    // There's no terminal here: an answer that needs one is Workbench's.
    terminal: () => {},
  });
  const needs = el("div", "needs hidden");
  const approve = el("button", "ok", "✓ approve");
  const deny = el("button", "no", "✗ deny");
  needs.append(el("span", "", "needs you"), approve, deny);

  const scroll = el("div", "scroll");
  const empty = el("p", "muted empty");
  const list = el("div");
  scroll.append(empty, list);
  const jump = el("button", "jump hidden", "↓ latest");

  const text = el("textarea");
  text.rows = 3;
  const interrupt = el("button", "interrupt", "interrupt");
  const stop = el("button", "stop", "stop");
  const send = el("button", "send", "send");
  for (const b of [close, approve, deny, jump, interrupt, stop, send]) b.type = "button";
  interrupt.title = "Esc in the session: stop what it's doing";
  const buttons = el("div", "buttons");
  buttons.append(stop, interrupt, send);
  const composer = el("div", "composer");
  composer.append(text, buttons);
  const free = el("p", "muted free", "No session: drag them onto a free desk to give them one.");

  root.replaceChildren(head, card.root, needs, scroll, jump, composer, free);

  let current: string | null = null;
  let live: RemoteInstance | null = null;
  let feed: Feed | null = null;
  let renderer: TranscriptRenderer | null = null;
  /** The reader was at the end as of their last scroll. */
  let stuck = true;
  let stopAsked = 0;
  const drafts = new Map<string, string>();

  const toEnd = () => void (scroll.scrollTop = scroll.scrollHeight);

  function changed(why: string): void {
    if (!feed || !renderer) return;
    const follow = why === "reset" || stuck;
    renderer.update(feed.items);
    empty.hidden = feed.items.length > 0;
    empty.textContent = feed.ready ? "Nothing in this session yet." : "Loading…";
    if (follow) toEnd();
    stuck = follow;
    jump.classList.toggle("hidden", follow);
  }

  function follow(id: string | null): void {
    if (id === current) return;
    if (current) {
      if (text.value.trim()) drafts.set(current, text.value);
      else drafts.delete(current);
    }
    feed?.stop();
    renderer?.clear();
    feed = null;
    renderer = null;
    current = id;
    stopAsked = 0;
    text.value = id ? (drafts.get(id) ?? "") : "";
    if (!id) return;
    stuck = true;
    renderer = createRenderer(list);
    const source = transcriptSource(id, {
      open: (params) => link.socket("transcript", params)!,
    });
    feed = createFeed(source, changed);
    changed("reset");
  }

  function paint(who: Who): void {
    const i = who.instance;
    name.textContent = whoText(who);
    what.textContent = i ? [i.projectName, titleOf(i), i.branch].filter(Boolean).join(" · ") : "";
    const phase = i ? (i.phase ?? "idle") : null;
    state.className = `state phase-${phase ?? "none"}`;
    state.textContent = i ? `${GLYPH[phase!] ?? "·"} ${i.live ? phaseText(i) : "not running"}` : "";
    const choice = phase === "needs_you" ? (i?.choice ?? null) : null;
    card.update(choice);
    needs.classList.toggle("hidden", phase !== "needs_you" || choice !== null);
    for (const part of [scroll, composer]) part.hidden = !i;
    free.hidden = !!i;
    if (!i) jump.classList.add("hidden");
    interrupt.hidden = phase !== "working";
    stop.hidden = !i?.live;
    stop.textContent = stopAsked ? "really stop?" : "stop";
    send.textContent = i?.live ? "send" : "start";
    text.placeholder = i?.live ? "message Claude… (Enter sends, Shift+Enter a new line)" : "session not running";
    if (stuck) toEnd();
  }

  function submit(): void {
    if (!current) return;
    if (!live?.live) {
      link.send({ type: "start", instanceId: current });
      return;
    }
    const body = text.value.trim();
    if (!body || !link.send({ type: "prompt", instanceId: current, text: body })) return;
    text.value = "";
    drafts.delete(current);
    stuck = true;
    toEnd();
  }

  scroll.addEventListener(
    "scroll",
    () => {
      stuck = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX;
      jump.classList.toggle("hidden", stuck);
    },
    { passive: true },
  );
  // Rendered links are untrusted text: web and mail links open in a new tab, as the
  // renderer marked them; nothing else goes anywhere.
  scroll.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a && !/^(https?:|mailto:)/i.test(a.getAttribute("href") ?? "")) e.preventDefault();
  });
  jump.onclick = () => {
    stuck = true;
    jump.classList.add("hidden");
    toEnd();
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  send.onclick = submit;
  close.onclick = onClose;
  interrupt.onclick = () => void (current && link.send({ type: "interrupt", instanceId: current }));
  // Stop closes the console: ask once more first.
  stop.onclick = () => {
    if (!current) return;
    if (Date.now() - stopAsked > CONFIRM_MS) {
      stopAsked = Date.now();
      stop.textContent = "really stop?";
      setTimeout(() => {
        if (Date.now() - stopAsked < CONFIRM_MS) return;
        stopAsked = 0;
        stop.textContent = "stop";
      }, CONFIRM_MS);
      return;
    }
    stopAsked = 0;
    stop.textContent = "stop";
    link.send({ type: "stop", instanceId: current });
  };
  for (const [b, type] of [
    [approve, "approve"],
    [deny, "deny"],
  ] as const) {
    b.onclick = () => void (current && link.send({ type, instanceId: current }));
  }

  return {
    show(who) {
      root.hidden = !who;
      live = who?.instance ?? null;
      follow(live?.id ?? null);
      if (who) paint(who);
    },
  };
}

