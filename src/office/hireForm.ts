// The sidebar's new-session form (office plan O3.2): what opens when you drag a free
// worker onto a free desk, or click a free desk. It asks for the project (one that sits
// in the desk's room first), the first prompt, the model and whether to isolate it in a
// worktree, and sends the phone's `create` action (`pwa/newSession.ts` is the phone's
// sheet). Once it's off, the worker walks to the desk; when the session shows up, the
// sidebar turns to it. The request carries an id, so sending it again never makes a
// second session.

import type { RemoteSnapshot } from "../remote/protocol";
import { el } from "../pwa/dom";
import { createStatus, newRequestId, projectLabel } from "../pwa/format";
import type { Link } from "./net";
import { TEAM_NAMES, type Team } from "./roster";

/** With no word from Workbench this long after starting, offer to send it again. */
const RETRY_AFTER_MS = 6000;
const MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Where the session goes. */
export interface HireTarget {
  desk: number;
  /** Who'll take it: a worker's name, or null for a contractor. */
  worker: { id: string; name: string } | null;
  room: Team;
}

export interface HireForm {
  /** Open for `target`, or close for null. */
  show(target: HireTarget | null): void;
  /** Each snapshot: the projects, and how the request is getting on. */
  update(snapshot: RemoteSnapshot): void;
}

export interface HireHooks {
  close(): void;
  /** The request is off: hold the desk and walk the worker over. */
  sent(requestId: string, target: HireTarget): void;
  /** Who is on the session `requestId` started (as the office names them), once seated. */
  seated(requestId: string): string | null;
  /** The session is seated: show it. */
  started(who: string): void;
  roomOf(projectId: string): Team;
}

/** The form in `root`. */
export function createHireForm(root: HTMLElement, link: Link, hooks: HireHooks): HireForm {
  const close = el("button", "close", "✕");
  close.title = "close (Esc)";
  const title = el("h2", "", "New session");
  const what = el("p", "what");
  const head = el("header");
  head.append(close, title, what);

  const project = el("select", "project");
  const text = el("textarea");
  text.rows = 5;
  text.placeholder = "the first prompt (optional; Ctrl+Enter starts)";
  const model = el("select", "model");
  model.append(new Option("project default", ""), ...MODELS.map((m) => new Option(m, m)));
  const worktree = el("input");
  worktree.type = "checkbox";
  const tree = el("label", "check");
  tree.append(worktree, " isolate in a worktree");
  const msg = el("p", "msg");
  const start = el("button", "send", "start session");
  const buttons = el("div", "buttons");
  buttons.append(start);
  for (const b of [close, start]) b.type = "button";
  const field = (label: string, input: HTMLElement) => {
    const l = el("label", "field");
    l.append(el("span", "muted", label), input);
    return l;
  };

  root.replaceChildren(head, field("project", project), field("prompt", text), field("model", model), tree, msg, buttons);

  let target: HireTarget | null = null;
  let snap: RemoteSnapshot | null = null;
  /** The request on its way. */
  let pending: { requestId: string; send: () => boolean; timer?: ReturnType<typeof setTimeout> } | null = null;

  function say(text: string, error = false): void {
    msg.textContent = text;
    msg.classList.toggle("error", error);
  }

  function busy(on: boolean, label = "start session"): void {
    start.disabled = on;
    start.textContent = label;
    for (const input of [project, text, model, worktree]) input.disabled = on;
  }

  /** The projects, those in the desk's room first, keeping the one picked. */
  function fillProjects(keep: string): void {
    const projects = snap?.projects ?? [];
    const here = projects.filter((p) => target && hooks.roomOf(p.id) === target.room);
    const rest = projects.filter((p) => !here.includes(p));
    const group = (label: string, list: typeof projects) => {
      const g = document.createElement("optgroup");
      g.label = label;
      g.append(...list.map((p) => new Option(projectLabel(p), p.id)));
      return g;
    };
    const key = JSON.stringify([target?.room, projects.map((p) => [p.id, projectLabel(p), hooks.roomOf(p.id)])]);
    if (project.dataset.key === key) return;
    project.dataset.key = key;
    project.replaceChildren(...(here.length && rest.length ? [group(TEAM_NAMES[target!.room], here), group("elsewhere", rest)] : [group("projects", projects)]));
    // The project in this room that was busiest lately, else whatever was picked.
    const latest = [...here].sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0))[0];
    project.value = projects.some((p) => p.id === keep) ? keep : (latest?.id ?? projects[0]?.id ?? "");
  }

  function arm(): void {
    const p = pending;
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (pending !== p) return;
      say("No answer from Workbench yet.");
      busy(true, "send again");
      start.disabled = false;
    }, RETRY_AFTER_MS);
  }

  function submit(): void {
    if (!target) return;
    if (pending) {
      // "send again": the very same request.
      busy(true, "starting…");
      say("");
      if (!pending.send()) say("Not connected to Workbench.", true);
      return arm();
    }
    const projectId = project.value;
    if (!projectId) return say("Pick a project.", true);
    const requestId = newRequestId();
    const body = text.value.trim();
    const m = model.value;
    const send = () =>
      link.send({ type: "create", requestId, projectId, ...(body && { text: body }), ...(worktree.checked && { worktree: true }), ...(m && { model: m }) });
    if (!send()) return say("Not connected to Workbench.", true);
    pending = { requestId, send };
    hooks.sent(requestId, target);
    busy(true, "starting…");
    say(`${target.worker?.name ?? "A contractor"} is on the way to the desk…`);
    arm();
  }

  /** How the request is getting on. */
  function follow(): void {
    if (!pending || !snap) return;
    const rec = snap.created.find((c) => c.requestId === pending!.requestId);
    if (!rec) return;
    clearTimeout(pending.timer);
    if (rec.state === "failed") {
      pending = null; // a new start is a new request
      busy(false);
      return say(createStatus(rec), true);
    }
    say(createStatus(rec));
    const who = hooks.seated(rec.requestId);
    if (who) {
      pending = null;
      text.value = "";
      hooks.started(who);
    }
  }

  close.onclick = () => hooks.close();
  start.onclick = submit;
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });

  return {
    show(next) {
      root.hidden = !next;
      const same = next && target && next.desk === target.desk && next.worker?.id === target.worker?.id;
      target = next;
      if (!next || same) return;
      // A new desk (or worker) is a new form; one already sent goes on regardless.
      if (pending) clearTimeout(pending.timer);
      pending = null;
      busy(false);
      say("");
      const room = TEAM_NAMES[next.room];
      what.textContent = next.worker ? `${next.worker.name}, at a desk in ${room}` : `No one's free: a contractor, at a desk in ${room}`;
      worktree.checked = false;
      model.value = "";
      fillProjects(project.value);
      text.focus();
    },
    update(s) {
      snap = s;
      if (!target) return;
      fillProjects(project.value);
      follow();
    },
  };
}
