// Where the phone stands with the desktop, said in the header instead of a
// spinner: connecting, live or offline, how old what's on screen is, and how
// much is waiting to go (`outbox.ts`). The page renders from what it kept
// (`store.ts`) while this says so; nothing waits for the link to show.
//
// Tapping it while not live tries again at once.
//
// Offline, a strip across the top of every screen (the dashboard and each
// overlay) says so and how old the data is, for as long as it lasts: "Offline —
// cached data from 14:32". In Duck's app it also leads to the phone brain (the
// app's own page), one tap away.

import { inApp, LOADER_URL } from "./native";
import { createOutbox } from "./outbox";
import { load, save } from "./store";

export type LinkState = "connecting" | "live" | "offline";

const SYNCED_KEY = "synced-at";
const OUTBOX_KEY = "outbox";

let state: LinkState = "connecting";
/** When the desktop's state last came (epoch ms); null if never on this phone. */
let syncedAt: number | null = null;
let flashText = "";
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let retry: () => void = () => {};
/** A newer page took over in the service worker: offer a reload. */
let update = false;
const listeners = new Set<(s: LinkState) => void>();

/** The phone's outbox: one for the page, kept on the device. */
export const outbox = createOutbox((items) => void save(OUTBOX_KEY, items));

/** How long ago `at` was, shortly. */
export function age(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The header's words for a state. */
export function linkText(s: LinkState, synced: number | null, pending: number, now = Date.now()): string {
  // Short: it shares the header with the buttons; the banner and the title say more.
  const head = s === "live" ? "● live" : s === "connecting" ? "◌ connecting" : "○ offline";
  const parts = [head];
  if (s !== "live" && synced !== null) parts.push(age(synced, now));
  if (pending > 0) parts.push(`${pending} to send`);
  return parts.join(" · ");
}

/** When `at` was, as a clock time (with the day, if not today). */
export function clockTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** The offline strip's words. */
export function stripText(synced: number | null, now = Date.now()): string {
  return synced === null
    ? "Offline — Workbench can’t be reached, nothing cached yet"
    : `Offline — showing cached data from ${clockTime(synced, now)}`;
}

function waiting(): number {
  return outbox.list().filter((it) => it.state !== "sent").length;
}

function paint(): void {
  const conn = document.getElementById("conn");
  if (!conn) return;
  const text = linkText(state, syncedAt, waiting());
  conn.textContent = flashText || (update ? `${text} · ↻ update` : text);
  conn.className = flashText ? "off" : state === "live" ? "live" : state === "offline" ? "off" : "wait";
  conn.title = update
    ? "a newer version is ready: tap to reload"
    : state === "live"
      ? ""
      : `${syncedAt !== null ? `last synced ${age(syncedAt)}; ` : ""}tap to try again now`;
  // Everywhere, for as long as it lasts: the strip, with room made for it.
  const off = state === "offline";
  document.body.classList.toggle("offline", off);
  const strip = document.getElementById("offline-strip");
  if (strip) {
    strip.classList.toggle("hidden", !off);
    $text("offline-strip-text", stripText(syncedAt));
    const n = waiting();
    const title = `Workbench (your PC) can’t be reached${syncedAt !== null ? `; last synced ${age(syncedAt)}` : ""}${n ? `; ${n} to send when it’s back` : ""}. Tap to try again now.`;
    document.getElementById("offline-strip-text")?.setAttribute("title", title);
  }
  const banner = document.getElementById("offline");
  if (banner) {
    banner.classList.toggle("hidden", state !== "offline");
    const said = banner.querySelector("span");
    if (said)
      said.textContent =
        (syncedAt !== null ? `Showing cached data from ${clockTime(syncedAt)} (${age(syncedAt)})` : "Nothing cached yet") +
        " — still trying. What you write (prompts, notes, messages to Duck) waits on this phone and syncs when it’s back.";
  }
}

function $text(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node && node.textContent !== text) node.textContent = text;
}

export function linkState(): LinkState {
  return state;
}

export function isLive(): boolean {
  return state === "live";
}

export function setLink(next: LinkState): void {
  if (next === state) return;
  state = next;
  paint();
  for (const cb of [...listeners]) cb(next);
  if (next === "live") void outbox.flush();
}

export function onLink(cb: (s: LinkState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The desktop's state just came. */
export function synced(at = Date.now()): void {
  syncedAt = at;
  void save(SYNCED_KEY, at);
  paint();
}

/** Say something in the indicator for a moment ("offline — not sent"). */
export function flash(text: string, ms = 3000): void {
  flashText = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashText = "";
    flashTimer = null;
    paint();
  }, ms);
  paint();
}

/** A newer version of the page is ready (the service worker updated). */
export function offerUpdate(): void {
  update = true;
  paint();
}

/** What a tap on the indicator does while not live. */
export function onRetry(cb: () => void): void {
  retry = cb;
}

/** Read what was kept (the last sync, the outbox) and start painting. */
export async function initLink(): Promise<void> {
  const [at, items] = await Promise.all([load<number>(SYNCED_KEY), load<unknown>(OUTBOX_KEY)]);
  if (typeof at === "number") syncedAt = at;
  outbox.restore(items ?? []);
  outbox.subscribe(paint);
  document.getElementById("conn")?.addEventListener("click", () => {
    if (update) location.reload();
    else if (state !== "live") retry();
  });
  document.getElementById("offline-strip-text")?.addEventListener("click", () => {
    if (state !== "live") retry();
  });
  // In Duck's app, the phone brain is the app's own page.
  const brain = document.getElementById("offline-brain");
  if (brain) {
    brain.classList.toggle("hidden", !inApp());
    brain.onclick = () => location.replace(`${LOADER_URL}?brain=1`);
  }
  // The ages move on with nothing new arriving.
  setInterval(paint, 30_000);
  paint();
}

/** For the pairing view: drop the indicator's memory with the rest. */
export function resetLink(): void {
  syncedAt = null;
  state = "connecting";
}

