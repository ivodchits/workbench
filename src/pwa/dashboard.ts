// The dashboard: the attention banner, the usage meter and a card per instance.

import type { RateLimits } from "../ipc/usageLimits";
import type { RemoteInstance, RemoteSnapshot } from "../remote/protocol";
import { createChoiceCard, type ChoiceCardView } from "./choice";
import { $, el } from "./dom";
import {
  attentionLine,
  byAttention,
  countdown,
  glyphOf,
  metaLine,
  phaseOf,
  projectLabel,
  unusedProjects,
  waitMins,
} from "./format";
import { action } from "./net";

interface Card {
  card: HTMLElement;
  dot: HTMLElement;
  title: HTMLElement;
  badge: HTMLElement;
  note: HTMLElement;
  stuck: HTMLElement;
  meta: HTMLElement;
  approve: HTMLElement;
  /** What it asks, when the desktop knows (step R5); else `approve` is shown. */
  choice: ChoiceCardView;
  // The attention cues of the last snapshot, so the ticker can repaint the badge.
  attn: boolean;
  needsSince: number | null;
  escalated: boolean;
}

// Cards are reconciled in place, never rebuilt. Snapshots arrive every couple of
// seconds (token ticks); replacing the DOM would blur a textarea mid-prompt and
// close the on-screen keyboard. Moving a live element with appendChild keeps focus,
// so reordering is safe.
const cards = new Map<string, Card>();

/** What a card can open: an instance's console (on its terminal, to answer a
 *  prompt there), or the new-session sheet. */
export interface Openers {
  console: (id: string) => void;
  terminal: (id: string) => void;
  newSession: (projectId: string) => void;
}

let lastSnap: RemoteSnapshot | null = null;
let needsYouOnly = false;

const nowSecs = () => Date.now() / 1000;

/** The instance with this id in the latest snapshot. */
export function instance(id: string): RemoteInstance | undefined {
  return lastSnap?.instances.find((it) => it.id === id);
}

function buildCard(id: string, open: Openers): Card {
  const dot = el("span");
  const title = el("span", "title");
  const badge = el("span", "badge hidden", "needs you");
  // Another session in this card's project (step R7), with no project to pick.
  const here = el("button", "here", "+");
  here.type = "button";
  here.title = here.ariaLabel = "new session in this project";
  here.onclick = () => {
    const projectId = instance(id)?.projectId;
    if (projectId) open.newSession(projectId);
  };
  const h2 = el("h2");
  h2.append(dot, title, badge, here);

  const note = el("div", "note");
  // Possibly-stuck flag (step 4.6): a working card past the desktop threshold.
  const stuck = el("div", "stuck note hidden", "⚠ possibly stuck — working longer than usual");
  const meta = el("div", "meta");

  // What it is waiting on, with its real answers (step R5).
  const choice = createChoiceCard(true, {
    choose: (choiceId, option) => action({ type: "choose", instanceId: id, choiceId, option }),
    terminal: () => open.terminal(id),
  });

  // Prominent approve / deny — the one thing a phone is really for. Shown only
  // when this instance is waiting on you and the desktop can't say on what.
  const approve = el("div", "approve hidden");
  const ok = el("button", "ok", "✓ approve");
  ok.onclick = () => action({ type: "approve", instanceId: id });
  const no = el("button", "no", "✗ deny");
  no.onclick = () => action({ type: "deny", instanceId: id });
  approve.append(ok, no);

  const prompt = el("div", "prompt");
  const text = el("textarea");
  text.placeholder = "send a prompt…";
  text.rows = 1;
  const send = el("button", "", "send");
  send.onclick = () => {
    const body = text.value.trim();
    if (!body) return;
    action({ type: "prompt", instanceId: id, text: body });
    text.value = "";
  };
  prompt.append(text, send);

  const secondary = el("div", "secondary");
  // Open the mirrored live console for this instance (step 4.5).
  const consoleBtn = el("button", "", "console");
  consoleBtn.onclick = () => open.console(id);
  secondary.append(consoleBtn);
  for (const type of ["interrupt", "start", "stop"] as const) {
    const b = el("button", "", type);
    b.onclick = () => action({ type, instanceId: id });
    secondary.append(b);
  }

  const card = el("div", "card");
  card.append(h2, note, stuck, meta, choice.root, approve, prompt, secondary);
  return {
    card, dot, title, badge, note, stuck, meta, approve, choice,
    attn: false, needsSince: null, escalated: false,
  };
}

/** Paint the needs-you badge with its live "waiting Nm" and escalation emphasis.
 *  Apart from `updateCard` so the ticker can refresh the time between snapshots. */
function paintBadge(c: Card): void {
  if (!c.attn) return;
  const m = waitMins(c.needsSince, nowSecs());
  c.badge.textContent = m != null ? `needs you · ${m}m` : "needs you";
  c.badge.classList.toggle("hot", c.escalated);
}

function updateCard(c: Card, it: RemoteInstance): void {
  const [glyph, cls] = glyphOf(it);
  const attn = phaseOf(it) === "needs_you";
  c.dot.className = "dot " + cls;
  c.dot.textContent = glyph;
  c.title.textContent = it.title || "(untitled)";
  c.attn = attn;
  c.needsSince = it.needsSince || null;
  c.escalated = !!it.escalated;
  c.badge.classList.toggle("hidden", !attn);
  c.card.classList.toggle("attn", attn);
  // Escalated (step 4.6): waited past the desktop threshold.
  c.card.classList.toggle("escalated", attn && c.escalated);
  const choice = attn ? (it.choice ?? null) : null;
  c.choice.update(choice);
  c.approve.classList.toggle("hidden", !attn || choice !== null);
  paintBadge(c);
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

  // Keep the usage countdowns and the "waiting Nm" badges (step 4.6) ticking
  // between snapshots: a held prompt emits no new state to push.
  setInterval(() => {
    if (!lastSnap) return;
    renderUsage(lastSnap.usageLimits);
    for (const c of cards.values()) paintBadge(c);
  }, 1000);

  return (snap) => {
    lastSnap = snap;
    render(snap, open);
  };
}
