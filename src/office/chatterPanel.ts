// The sidebar's chatter section (office plan O4.1): on or off, the model, the budget
// and what's been spent of it, and "try a scene", which asks for one now for a few
// free workers and shows it. Built once, so its controls survive the snapshots that
// rebuild the stats above it.

import { CHAT_PLACES, type ChatSpot, type Scene } from "../remote/chatter";
import { el } from "../pwa/dom";
import { formatTokens } from "../util/format";
import type { Chatter } from "./chatter";
import { ROSTER } from "./roster";

export interface ChatterPanel {
  /** Show the latest settings and usage. */
  update(): void;
}

/** Workers who'd say a scene "try a scene" asks for, and where. */
export type Tryout = () => { ids: string[]; spot: ChatSpot } | null;

const nameOf = (id: string) => ROSTER.find((w) => w.id === id)?.name ?? id;

function numberInput(min: number, max: number, step: number): HTMLInputElement {
  const i = el("input");
  i.type = "number";
  Object.assign(i, { min: String(min), max: String(max), step: String(step) });
  return i;
}

export function createChatterPanel(root: HTMLElement, chatter: Chatter, tryout: Tryout, ask: (ids: string[], spot: ChatSpot) => Promise<Scene | null>): ChatterPanel {
  const on = el("input");
  on.type = "checkbox";
  const onLabel = el("label", "toggle");
  onLabel.append(on, " on");
  const model = el("select");
  model.add(new Option("Haiku", "haiku"));
  model.add(new Option("Sonnet", "sonnet"));
  const perHour = numberInput(1, 120, 1);
  const perDay = numberInput(1000, 2_000_000, 5000);
  const spent = el("p", "muted");
  const tryBtn = el("button", "", "Try a scene");
  tryBtn.type = "button";
  const result = el("div", "scene");

  const line = (...kids: (Node | string)[]) => {
    const d = el("div", "row");
    d.append(...kids);
    return d;
  };
  root.replaceChildren(
    el("h2", "", "Chatter"),
    line(onLabel, model),
    line(el("span", "label", "calls an hour"), perHour),
    line(el("span", "label", "tokens a day"), perDay),
    spent,
    line(tryBtn),
    result,
  );

  on.addEventListener("change", () => void chatter.set({ on: on.checked }));
  model.addEventListener("change", () => void chatter.set({ model: model.value as "haiku" | "sonnet" }));
  perHour.addEventListener("change", () => void chatter.set({ perHour: Number(perHour.value) }));
  perDay.addEventListener("change", () => void chatter.set({ tokensPerDay: Number(perDay.value) }));

  let asking = false;
  const say = (text: string) => result.replaceChildren(el("p", "muted", text));
  tryBtn.addEventListener("click", () => {
    const t = tryout();
    if (!t) return say("Nobody's free to chat.");
    asking = tryBtn.disabled = true;
    say(`Asking for ${t.ids.map(nameOf).join(", ")} at ${CHAT_PLACES[t.spot]}…`);
    void ask(t.ids, t.spot)
      .then((scene) => {
        if (!scene) return say(whyNot());
        const list = el("ul", "lines");
        for (const l of scene.lines) {
          const li = el("li");
          li.append(el("b", "", `${nameOf(l.speaker)}: `), l.text);
          list.append(li);
        }
        result.replaceChildren(list, el("p", "muted", `mood: ${scene.mood ?? "—"}`));
      })
      .finally(() => {
        asking = false;
        tryBtn.disabled = !chatter.state?.settings.on;
      });
  });

  function whyNot(): string {
    const s = chatter.state;
    if (!s?.settings.on) return "Chatter is off: canned lines only.";
    if (s.usage.callsThisHour >= s.usage.perHour) return "This hour's calls are spent: canned lines for now.";
    if (s.usage.tokensToday >= s.usage.tokensPerDay) return "Today's tokens are spent: canned lines till tomorrow.";
    return chatter.lastError ? `No scene: ${chatter.lastError}.` : "No scene this time.";
  }

  return {
    update() {
      const s = chatter.state;
      root.hidden = !s;
      if (!s) return;
      on.checked = s.settings.on;
      model.value = s.settings.model;
      // Not while someone is typing in it.
      if (document.activeElement !== perHour) perHour.value = String(s.settings.perHour);
      if (document.activeElement !== perDay) perDay.value = String(s.settings.tokensPerDay);
      model.disabled = perHour.disabled = perDay.disabled = !s.settings.on;
      tryBtn.disabled = asking || !s.settings.on;
      const u = s.usage;
      const tokens = (n: number) => (n < 1000 ? String(n) : formatTokens(n));
      spent.textContent = `${u.callsThisHour} of ${u.perHour} calls this hour · ${tokens(u.tokensToday)} of ${tokens(u.tokensPerDay)} tokens today`;
    },
  };
}
