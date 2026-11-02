// Fernando's Spanish lessons: what opens over the dimmed office when you click him.
// It opens on a menu: New Lesson (the default) starts a session in the Spanish lessons'
// project with its lesson prompt, Open Session starts one with no prompt, and while a
// lesson is going a third line goes back to it. Under them, the word of the day, at the
// learner's level (`remote/spanish.ts`). A session started here opens right in the
// window, on the sidebar's session panel (`panel.ts`): its transcript, a prompt box,
// interrupt and stop; ← goes back to the menu, and the session goes on.
//
// Everything acts through the ordinary actions (`create`, then the panel's); the Spanish
// lessons' sessions sit with Fernando, not at a desk (`liveOffice.ts`).

import type { RemoteInstance, RemoteSnapshot } from "../remote/protocol";
import { LESSON_PROMPT, SPANISH_FOLDER, type SpanishInfo, type WordOfDay } from "../remote/spanish";
import { el } from "../pwa/dom";
import { createStatus, newRequestId } from "../pwa/format";
import { phaseText, titleOf } from "./describe";
import type { Link } from "./net";
import { createPanel } from "./panel";

/** With no word from Workbench this long after asking for a session, say so. */
const SLOW_MS = 8000;

export interface SpanishOverlay {
  readonly open: boolean;
  show(): void;
  close(): void;
  /** Each snapshot: the session being made, and the one open. */
  update(snapshot: RemoteSnapshot): void;
}

export interface SpanishHooks {
  /** The lessons closed. */
  closed(): void;
  /** What the lessons found out: the project (for the office) and the level. */
  found(info: SpanishInfo): void;
  /** The lesson going now, if any. */
  current(): RemoteInstance | null;
}

/** Today, local, `YYYY-MM-DD`. */
export function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The word of the day's card. */
function wordCard(w: WordOfDay): HTMLElement[] {
  const head = el("p", "word");
  head.append(el("b", "", w.word), el("span", "kind", w.kind));
  const parts = [head, el("p", "meaning", w.meaning)];
  if (w.example) {
    const ex = el("p", "example");
    ex.append(el("span", "es", w.example), el("span", "en", w.exampleEn));
    parts.push(ex);
  }
  if (w.note) parts.push(el("p", "note", w.note));
  return parts;
}

export function createSpanishOverlay(root: HTMLElement, link: Link, hooks: SpanishHooks): SpanishOverlay {
  const close = el("button", "close", "✕");
  close.title = "close (Esc)";
  const back = el("button", "back", "← lessons");
  back.title = "back to the lessons; the session goes on";
  const title = el("h2", "", "Spanish Lessons");
  const sub = el("span", "sub", "con Fernando");
  const head = el("header");
  head.append(back, title, sub, close);

  // The menu.
  const lesson = el("button", "option main");
  lesson.append(el("b", "", "New Lesson"), el("span", "", "Fernando starts today's lesson"));
  const blank = el("button", "option");
  blank.append(el("b", "", "Open Session"), el("span", "", `an empty session in ${SPANISH_FOLDER}`));
  const resume = el("button", "option resume");
  const msg = el("p", "msg");
  const options = el("div", "options");
  options.append(resume, lesson, blank);
  const wordTitle = el("h3", "", "Palabra del día");
  const wordBody = el("div", "body");
  const again = el("button", "again", "try again");
  const word = el("section", "wotd");
  word.append(wordTitle, wordBody);
  const menu = el("div", "menu");
  menu.append(options, msg, word);

  // A session.
  const status = el("p", "status");
  const lessonRoot = el("section");
  lessonRoot.id = "lesson";
  const session = el("div", "session");
  session.append(status, lessonRoot);
  const panel = createPanel(lessonRoot, link, () => toMenu(), () => "Fernando");

  const box = el("div", "window");
  box.append(head, menu, session);
  root.replaceChildren(box);
  for (const b of [close, back, lesson, blank, resume, again]) b.type = "button";

  let isOpen = false;
  let snap: RemoteSnapshot | null = null;
  let info: SpanishInfo | null = null;
  /** The word's day, and whether it's being asked for. */
  let wordDay = "";
  let asking = false;
  /** The session request on its way. */
  let pending: { requestId: string; at: number } | null = null;
  /** The session open in the window. */
  let openId: string | null = null;

  function say(text: string, error = false): void {
    msg.textContent = text;
    msg.classList.toggle("error", error);
  }

  function paintWord(): void {
    if (asking && !info?.word) {
      wordBody.replaceChildren(el("p", "muted", "Fernando is thinking of a word…"));
    } else if (info?.word) {
      wordBody.replaceChildren(...wordCard(info.word));
    } else {
      const why = info?.wordError ?? "Workbench can't be reached";
      wordBody.replaceChildren(el("p", "muted", `No word today: ${why}.`), again);
    }
  }

  async function askWord(): Promise<void> {
    if (asking) return;
    asking = true;
    wordDay = today();
    paintWord();
    const a = await link.spanish({ today: wordDay, word: true });
    asking = false;
    if (a?.status === "ok") {
      info = a.result;
      hooks.found(a.result);
    } else {
      info = { ...(info ?? { projectId: null, projectName: null, level: null }), word: null, wordError: a?.status === "error" ? a.message : null };
    }
    paintMenu();
  }

  function paintMenu(): void {
    sub.textContent = info?.level ? `con Fernando · ${info.level}` : "con Fernando";
    const going = hooks.current();
    resume.hidden = !going;
    if (going) {
      resume.replaceChildren(el("b", "", "↩ Back to your lesson"), el("span", "", `${titleOf(going)} · ${phaseText(going)}`));
    }
    const none = !!info && !info.projectId;
    lesson.disabled = none || !!pending;
    blank.disabled = none || !!pending;
    if (none) say(`Add your ${SPANISH_FOLDER} folder to Workbench as a project first.`, true);
    paintWord();
  }

  function paintSession(): void {
    const it = openId ? (snap?.instances.find((i) => i.id === openId) ?? null) : null;
    panel.show(isOpen && it ? { worker: null, instance: it, since: null } : null);
    if (pending) {
      const rec = snap?.created.find((c) => c.requestId === pending!.requestId);
      status.textContent = rec ? createStatus(rec) : Date.now() - pending.at > SLOW_MS ? "No answer from Workbench yet…" : "Fernando is opening a session…";
    } else status.textContent = it ? "" : openId ? "The session isn't here any more." : "";
    status.hidden = !status.textContent;
  }

  function showView(which: "menu" | "session"): void {
    menu.hidden = which !== "menu";
    session.hidden = which !== "session";
    back.hidden = which !== "session";
    root.classList.toggle("in-session", which === "session");
    if (which === "menu") {
      panel.show(null);
      paintMenu();
      if (!lesson.disabled) lesson.focus();
    } else paintSession();
  }

  function toMenu(): void {
    openId = null;
    pending = null;
    showView("menu");
  }

  function start(withPrompt: boolean): void {
    if (!info) return say("Fernando is still looking for the lessons: a moment…");
    const projectId = info.projectId;
    if (!projectId) return say(`Add your ${SPANISH_FOLDER} folder to Workbench as a project first.`, true);
    const requestId = newRequestId();
    if (!link.send({ type: "create", requestId, projectId, ...(withPrompt && { text: LESSON_PROMPT }) })) return say("Not connected to Workbench.", true);
    say("");
    pending = { requestId, at: Date.now() };
    openId = null;
    showView("session");
    // Says so if Workbench is slow to answer.
    setTimeout(() => isOpen && pending?.requestId === requestId && paintSession(), SLOW_MS + 100);
  }

  /** How the request is getting on: once it has its session, that opens. */
  function follow(): void {
    if (!pending || !snap) return;
    const rec = snap.created.find((c) => c.requestId === pending!.requestId);
    if (!rec) return;
    if (rec.state === "failed") {
      pending = null;
      showView("menu");
      return say(createStatus(rec), true);
    }
    if (rec.instanceId && snap.instances.some((i) => i.id === rec.instanceId)) {
      openId = rec.instanceId;
      pending = null;
    }
  }

  lesson.onclick = () => start(true);
  blank.onclick = () => start(false);
  resume.onclick = () => {
    const going = hooks.current();
    if (!going) return paintMenu();
    openId = going.id;
    showView("session");
  };
  back.onclick = toMenu;
  close.onclick = () => overlay.close();
  again.onclick = () => void askWord();
  // A click on the dimmed office round the window closes it.
  root.addEventListener("click", (e) => {
    if (e.target === root) overlay.close();
  });

  const overlay: SpanishOverlay = {
    get open() {
      return isOpen;
    },
    show() {
      isOpen = true;
      root.hidden = false;
      say("");
      // Back to the session that was open, while it goes on; else the menu.
      const it = openId ? snap?.instances.find((i) => i.id === openId) : undefined;
      if (!pending && !it?.live) openId = null;
      showView(pending || openId ? "session" : "menu");
      if (wordDay !== today() || (!info?.word && !asking)) void askWord();
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      root.hidden = true;
      panel.show(null);
      hooks.closed();
    },
    update(s) {
      snap = s;
      if (!isOpen) return;
      follow();
      if (!session.hidden) paintSession();
      else paintMenu();
    },
  };
  root.hidden = true;
  return overlay;
}
