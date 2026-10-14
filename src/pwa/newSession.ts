// Starting a new session from the phone (step R7): the sheet that asks for the
// project, an optional title and first prompt, and the follow-up — open the new
// instance's console as soon as the desktop reports it, and say what became of the
// first prompt.
//
// The desktop does the work (`state/remoteActions` → `createSession`); a request
// carries an id, so sending it again (a retry, or the HTTP fallback after a
// dropped socket) never makes a second session.

import type { RemoteCreated, RemoteSnapshot } from "../remote/protocol";
import { $, el } from "./dom";
import { createStatus, newRequestId, projectLabel } from "./format";
import { action } from "./net";

/** With no word from the desktop this long after a tap, offer to send it again. */
const RETRY_AFTER_MS = 6000;

interface Pending {
  requestId: string;
  send: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let lastSnap: RemoteSnapshot | null = null;
/** The request the open sheet is waiting on. */
let pending: Pending | null = null;
/** The project the sheet was opened for, or null for the picker. */
let fixedProject: string | null = null;
/** Requests made from this page, and the notice last dismissed for each. */
const mine = new Map<string, string | null>();
let openConsole: (id: string) => void = () => {};

function sheetOpen(): boolean {
  return !$("new-overlay").classList.contains("hidden");
}

function setMsg(text: string, error = false): void {
  const msg = $("new-msg");
  msg.textContent = text;
  msg.classList.toggle("err", error);
}

function setBusy(busy: boolean, label = "start session"): void {
  const btn = $<HTMLButtonElement>("new-create");
  btn.disabled = busy;
  btn.textContent = label;
}

function fillProjects(): void {
  const select = $<HTMLSelectElement>("new-project");
  const keep = select.value;
  const projects = lastSnap?.projects ?? [];
  select.replaceChildren(
    ...projects.map((p) => {
      const opt = el("option", "", projectLabel(p));
      opt.value = p.id;
      return opt;
    }),
  );
  if (projects.some((p) => p.id === keep)) select.value = keep;
}

/** Open the sheet, for one project (no picker) or for any. */
export function openNewSession(projectId: string | null = null): void {
  const project = projectId ? lastSnap?.projects.find((p) => p.id === projectId) : undefined;
  fixedProject = project ? project.id : null;
  fillProjects();
  $("new-project-row").classList.toggle("hidden", fixedProject !== null);
  const fixed = $("new-project-fixed");
  fixed.classList.toggle("hidden", fixedProject === null);
  fixed.textContent = project ? projectLabel(project) : "";
  $<HTMLInputElement>("new-worktree").checked = false;
  pending = null;
  setMsg("");
  setBusy(false);
  $("new-overlay").classList.remove("hidden");
}

function closeSheet(): void {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
  $("new-overlay").classList.add("hidden");
}

function armRetry(p: Pending): void {
  p.timer = setTimeout(() => {
    if (pending !== p) return;
    setMsg("No answer from Workbench yet.");
    setBusy(false, "send again"); // same request id: the desktop ignores a duplicate
  }, RETRY_AFTER_MS);
}

function submit(): void {
  if (pending) {
    // "send again": the very same request.
    const p = pending;
    setBusy(true, "starting…");
    setMsg("");
    p.send();
    armRetry(p);
    return;
  }
  const projectId = fixedProject ?? $<HTMLSelectElement>("new-project").value;
  if (!projectId) {
    setMsg("Pick a project.", true);
    return;
  }
  const requestId = newRequestId();
  const title = $<HTMLInputElement>("new-title").value.trim();
  const text = $<HTMLTextAreaElement>("new-text").value.trim();
  const worktree = $<HTMLInputElement>("new-worktree").checked;
  const send = () =>
    action({
      type: "create",
      requestId,
      projectId,
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
      ...(worktree ? { worktree } : {}),
    });
  const p: Pending = { requestId, send, timer: null };
  pending = p;
  mine.set(requestId, null);
  setBusy(true, "starting…");
  setMsg("");
  send();
  armRetry(p);
}

/** Follow the open sheet's request: open the console once the instance exists. */
function follow(snap: RemoteSnapshot): void {
  if (!pending || !sheetOpen()) return;
  const requestId = pending.requestId;
  const rec = (snap.created ?? []).find((c) => c.requestId === requestId);
  if (!rec) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  if (rec.state === "failed") {
    pending = null; // a new tap is a new request
    setMsg(createStatus(rec), true);
    setBusy(false);
    return;
  }
  setMsg(createStatus(rec));
  if (rec.instanceId && (snap.instances ?? []).some((it) => it.id === rec.instanceId)) {
    $<HTMLInputElement>("new-title").value = "";
    $<HTMLTextAreaElement>("new-text").value = "";
    closeSheet();
    openConsole(rec.instanceId);
  }
}

/** The banner for a request made here that has something to say after the sheet
 *  closed (the first prompt was queued, the SSH login wants a password, …). */
function renderNotice(snap: RemoteSnapshot): void {
  const rec = (snap.created ?? []).find(
    (c): c is RemoteCreated & { message: string } =>
      mine.has(c.requestId) && c.state !== "failed" && c.message !== null,
  );
  const show = rec && mine.get(rec.requestId) !== rec.message;
  $("notice").classList.toggle("hidden", !show);
  if (!show) return;
  const title = (snap.instances ?? []).find((it) => it.id === rec.instanceId)?.title;
  $("notice-text").textContent = (title ? `${title}: ` : "") + rec.message;
  $("notice-close").onclick = () => {
    mine.set(rec.requestId, rec.message);
    $("notice").classList.add("hidden");
  };
}

/** Wire the sheet; returns what to call with each snapshot. */
export function initNewSession(open: (id: string) => void): (snap: RemoteSnapshot) => void {
  openConsole = open;
  $("newBtn").onclick = () => openNewSession();
  $("new-close").onclick = closeSheet;
  $("new-create").onclick = submit;
  return (snap) => {
    lastSnap = snap;
    $("newBtn").classList.toggle("hidden", !snap.projects?.length);
    if (sheetOpen() && !pending) fillProjects();
    follow(snap);
    renderNotice(snap);
  };
}
