// The dashboard: the attention banner, the usage meter and a card per instance.

import type { RateLimits } from "../ipc/usageLimits";
import type { RemoteInstance, RemoteSnapshot } from "../remote/protocol";
import { $, el } from "./dom";
import {
  attentionLine,
  byAttention,
  cardStatus,
  countdown,
  glyphOf,
  metaLine,
  phaseOf,
  projectLabel,
  sinceText,
  unusedProjects,
  waitMins,
} from "./format";

/** The pencil on a card's notes button; fixed markup, never data. */
const PENCIL =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/>' +
  '<path d="M13.5 6.5l4 4"/></svg>';

interface Card {
  card: HTMLElement;
  open: HTMLButtonElement;
  dot: HTMLElement;
  phase: HTMLElement;
  when: HTMLElement;
  body: HTMLElement;
  note: HTMLElement;
  stuck: HTMLElement;
  meta: HTMLElement;
  // The last snapshot's cues, so the ticker can repaint the time between them.
  attn: boolean;
  needsSince: number | null;
  at: number | null;
  /** What the body last drew, so an unchanged snapshot leaves it alone. */
  drawn: string;
}

// Cards are reconciled in place, never rebuilt, so a snapshot every couple of
// seconds (token ticks) doesn't redraw the list under a finger. Moving a live
// element with appendChild keeps it, so reordering is safe.
const cards = new Map<string, Card>();

/** What a card can open: an instance's console, the new-session sheet, or a
 *  project's notes. */
export interface Openers {
  console: (id: string) => void;
  newSession: (projectId: string) => void;
  notes: (projectId: string) => void;
}

let lastSnap: RemoteSnapshot | null = null;
let needsYouOnly = false;

const nowSecs = () => Date.now() / 1000;

/** The instance with this id in the latest snapshot. */
export function instance(id: string): RemoteInstance | undefined {
  return lastSnap?.instances.find((it) => it.id === id);
}

/** A small corner button on a card that acts on its project, not its session. */
function cornerButton(cls: string, label: string, run: (projectId: string) => void, id: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.title = b.ariaLabel = label;
  b.onclick = (e) => {
    // Above the card's own tap target; never let it open the console too.
    e.stopPropagation();
    const projectId = instance(id)?.projectId;
    if (projectId) run(projectId);
  };
  return b;
}

function buildCard(id: string, open: Openers): Card {
  // The title is the card's button: stretched over the whole card (`::after` in the
  // stylesheet), so a tap anywhere opens the console, and a screen reader meets one
  // plain button named by the session rather than a clickable div.
  const title = el("button", "title");
  title.type = "button";
  title.onclick = () => open.console(id);
  const notes = cornerButton("corner", "notes for this project", open.notes, id);
  notes.innerHTML = PENCIL;
  // Another session in this card's project (step R7), with no project to pick.
  const here = cornerButton("corner", "new session in this project", open.newSession, id);
  here.textContent = "+";
  const h2 = el("h2");
  h2.append(title, notes, here);

  // The phase in colour, and how long since it last did anything.
  const dot = el("span", "dot");
  const phase = el("span", "phase");
  const when = el("span", "when");
  const state = el("div", "state");
  state.append(dot, phase, when);
  const body = el("div", "status");

  const note = el("div", "note");
  // Possibly-stuck flag (step 4.6): a working card past the desktop threshold.
  const stuck = el("div", "stuck note hidden", "⚠ possibly stuck — working longer than usual");
  const meta = el("div", "meta");

  const card = el("div", "card");
  card.append(h2, state, body, note, stuck, meta);
  return {
    card, open: title, dot, phase, when, body, note, stuck, meta,
    attn: false, needsSince: null, at: null, drawn: "",
  };
}

/** Paint the live time: how long a needs-you has waited, else how long since the
 *  session last did anything. Apart from `updateCard` so the ticker can refresh it
 *  between snapshots. */
function paintWhen(c: Card): void {
  const now = nowSecs();
  const m = c.attn ? waitMins(c.needsSince, now) : null;
  const since = sinceText(c.at, now);
  c.when.textContent = m != null ? `waiting ${m}m` : since === "now" ? "just now" : since ? `${since} ago` : "";
}

function updateCard(c: Card, it: RemoteInstance): void {
  const [glyph] = glyphOf(it);
  const st = cardStatus(it);
  const attn = phaseOf(it) === "needs_you";
  const escalated = attn && !!it.escalated;
  c.card.className = `card ${st.cls}` + (attn ? " attn" : "") + (escalated ? " escalated" : "");
  c.open.textContent = it.title || "(untitled)";
  c.dot.className = "dot " + st.cls;
  c.dot.textContent = glyph;
  c.phase.className = "phase " + st.cls + (escalated ? " hot" : "");
  c.phase.textContent = st.label;
  c.attn = attn;
  c.needsSince = it.needsSince || null;
  c.at = it.latest?.at ?? null;
  paintWhen(c);

  const key = [st.kind, st.name, st.text].join("\n");
  if (key !== c.drawn) {
    c.drawn = key;
    c.body.className = `status ${st.kind}`;
    const parts: (string | HTMLElement)[] = [];
    if ((st.kind === "tool" || st.kind === "ask") && st.name) parts.push(el("span", "tname", st.name), " ");
    if (st.kind === "prompt") parts.push(el("span", "tname", "›"), " ");
    parts.push(st.text);
    c.body.replaceChildren(...parts);
  }

  c.note.textContent = it.taskNote || "";
  c.stuck.classList.toggle("hidden", !it.stuck);
  c.meta.textContent = metaLine(it);
}

function renderAttention(all: RemoteInstance[]): void {
  const banner = $("attention");
  const line = attentionLine(all);
  if (line) {
    banner.className = "attention alert";
    banner.replaceChildren(el("span", "big", "●"), ` ${line}`);
  } else {
    banner.className = "attention calm";
    banner.textContent = all.length ? "all quiet" : "no instances yet";
  }
  // The needs-you filter is offered only when there is something to filter.
  $("filter").classList.toggle("hidden", all.length === 0);
}

function renderUsage(limits: RateLimits | null | undefined): void {
  const rows: HTMLElement[] = [];
  for (const [label, w] of [["5h", limits?.fiveHour], ["wk", limits?.sevenDay]] as const) {
    if (!w) continue;
    const pct = Math.max(0, Math.min(100, w.usedPercentage || 0));
    const fill = el("span");
    fill.style.width = `${pct}%`;
    const bar = el("span", "bar" + (pct >= 90 ? " hot" : pct >= 70 ? " warn" : ""));
    bar.append(fill);
    const row = el("div", "meter");
    row.append(
      el("span", "lbl", label),
      bar,
      el("span", "pct", `${Math.round(pct)}%`),
      el("span", "reset", w.resetsAt ? "· " + countdown(w.resetsAt, nowSecs()) : ""),
    );
    rows.push(row);
  }
  $("usage").replaceChildren(...rows);
}

/** A button per project with no session yet, so a new one can start there too. */
function renderUnused(snap: RemoteSnapshot, open: Openers): void {
  const unused = needsYouOnly ? [] : unusedProjects(snap);
  $("unused").classList.toggle("hidden", unused.length === 0);
  $("unused-list").replaceChildren(
    ...unused.map((p) => {
      const b = el("button", "", `+ ${projectLabel(p)}`);
      b.type = "button";
      b.onclick = () => open.newSession(p.id);
      return b;
    }),
  );
}

function render(snap: RemoteSnapshot, open: Openers): void {
  const all = snap.instances || [];
  const sorted = byAttention(all);
  const visible = needsYouOnly ? sorted.filter((it) => phaseOf(it) === "needs_you") : sorted;

  renderAttention(all);
  renderUsage(snap.usageLimits);
  renderUnused(snap, open);

  const list = $("list");
  const seen = new Set<string>();
  for (const it of visible) {
    seen.add(it.id);
    let c = cards.get(it.id);
    if (!c) {
      c = buildCard(it.id, open);
      cards.set(it.id, c);
    }
    updateCard(c, it);
    list.appendChild(c.card); // append or move into order; keeps focus and text
  }
  // Drop cards no longer visible (gone, or filtered out). With none left the banner
  // above already says so ("all quiet" / "no instances yet").
  for (const [id, c] of cards) {
    if (!seen.has(id)) {
      c.card.remove();
      cards.delete(id);
    }
  }
}

/** Wire the dashboard; returns what to call with each snapshot. */
export function initDashboard(open: Openers): (snap: RemoteSnapshot) => void {
  const filterBtn = $("filterBtn");
  filterBtn.onclick = () => {
    needsYouOnly = !needsYouOnly;
    filterBtn.classList.toggle("on", needsYouOnly);
    filterBtn.textContent = needsYouOnly ? "show all" : "show only needs-you";
    if (lastSnap) render(lastSnap, open);
  };

  // Keep the usage countdowns and the cards' "waiting Nm" (step 4.6) and "ago" ticking
  // between snapshots: a held prompt emits no new state to push.
  setInterval(() => {
    if (!lastSnap) return;
    renderUsage(lastSnap.usageLimits);
    for (const c of cards.values()) paintWhen(c);
  }, 1000);

  return (snap) => {
    lastSnap = snap;
    render(snap, open);
  };
}
