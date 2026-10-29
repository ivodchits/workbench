// The sidebar's standup section (office plan O5.5): a button that calls the standup
// (as clicking the table in Duck's office does), and the latest one's notes — each
// project, who reported it, what got done and what's next — to read at leisure, since
// the bubbles don't stay up. Built once, so the button survives the snapshots that
// rebuild the stats above it.

import { el } from "../pwa/dom";
import type { StandupNotes } from "./liveOffice";
import { ROSTER } from "./roster";

export interface StandupPanel {
  /** Show the latest notes. */
  update(): void;
}

const nameOf = (id: string) => ROSTER.find((w) => w.id === id)?.name ?? id;

/** What the button's click got: started, one already on, or nobody free. */
export type Called = "started" | "on" | "nobody";

export function createStandupPanel(root: HTMLElement, call: (fresh: boolean) => Called, notes: () => StandupNotes | null): StandupPanel {
  const callBtn = el("button", "", "Call a standup");
  callBtn.type = "button";
  const freshBtn = el("button", "", "Read again");
  freshBtn.type = "button";
  freshBtn.title = "Read the transcripts again, not today's kept notes";
  const status = el("p", "muted");
  const body = el("div", "notes");
  const row = el("div", "row");
  row.append(callBtn, freshBtn);
  root.replaceChildren(el("h2", "", "Standup"), row, status, body);
  root.hidden = false;

  let said: string | null = null;
  const click = (fresh: boolean) => {
    const got = call(fresh);
    said = got === "nobody" ? "Everyone's busy: nobody's free for a standup." : got === "on" ? "A standup is under way." : null;
    update();
  };
  callBtn.addEventListener("click", () => click(false));
  freshBtn.addEventListener("click", () => click(true));

  let shown = "";
  let had = "";
  function update(): void {
    const n = notes();
    // What a click said stands till the notes move on.
    const now = JSON.stringify(n);
    if (now !== had) {
      had = now;
      if (n?.on === false) said = null;
    }
    const key = JSON.stringify([n, said]);
    if (key === shown) return;
    shown = key;
    callBtn.disabled = freshBtn.disabled = !!n?.on;
    if (!n) {
      status.textContent = said ?? "The free workers gather in Duck's office, and each says what a project got done the day before (Haiku reads the transcripts).";
      return body.replaceChildren();
    }
    const r = n.result;
    status.textContent =
      said ??
      (n.error
        ? `No notes: ${n.error}.`
        : !r
          ? "Reading the transcripts…"
          : !r.day
            ? "Nothing to report: no sessions in the week before."
            : `${n.on ? "Under way" : "Done"}: what got done ${r.when}.`);
    const by = new Map(n.reported.map((x) => [x.report.projectId, x.by]));
    body.replaceChildren(
      ...(r?.reports ?? []).map((p) => {
        const who = by.get(p.projectId);
        const box = el("div", "report");
        box.append(el("h3", "", `${p.project}${who ? ` · ${nameOf(who)}` : ""}`));
        const list = el("ul", "lines");
        for (const d of p.done) list.append(el("li", "", d));
        if (p.next) list.append(el("li", "next", `Next: ${p.next}`));
        box.append(list);
        return box;
      }),
    );
  }
  return { update };
}
