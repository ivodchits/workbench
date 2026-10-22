// Duck speaks up when there's news (step V5). Background work (a worker task, a
// session Duck was asked to watch, an autopilot) reports into its thread as a
// <workbench_event>; Duck's reply to it is the news, announced here at a level its
// producer set:
//
// - info: nothing beyond the drawer's unread badge (spoken only if the setting
//   says so).
// - report: a short spoken headline when you're around, otherwise a push.
// - needs_you: spoken when you're around, and pushed when you're away; repeated
//   once after a while if it's still unanswered.
//
// Where: this PC when you're at it (input within a couple of minutes, not locked),
// else a phone with Duck open, else a push to the phones.
//
// Etiquette (all settings, `AnnounceSettings`):
// - Nothing is spoken during Do Not Disturb (Duck's own, or Windows Focus when
//   followed), in quiet hours, or over a full-screen app (except needs_you). What
//   was held back is said in one short catch-up when that ends.
// - Speak off (this PC's master switch) is text only while you're at the PC; a
//   phone with Duck open still hears news when you're away from it, by its own
//   setting.
// - It waits for a gap: a second without your input, and Duck not speaking.
// - Updates are batched: one announcement says everything pending, and the next
//   comes no sooner than the batch window after it.

import { sentencesOf } from "./reader";

export type Level = "info" | "report" | "needs_you";

export interface Announcement {
  level: Level;
  /** What's said: a sentence or two. */
  text: string;
  threadId: string;
  /** Dedupes, and answers it (`answered`): the same key replaces the pending one. */
  key: string;
}

export type SpeakWhen = "never" | "around";

export interface AnnounceSettings {
  speak: Record<Level, SpeakWhen>;
  waitForGap: boolean;
  followFocus: boolean;
  /** Minutes after midnight; off unless `on`. A window past midnight wraps. */
  quietHours: { on: boolean; from: number; to: number };
  fullScreenQuiet: boolean;
  batchSeconds: number;
  /** Repeat an unanswered needs_you once after this; 0 never. */
  repeatMinutes: number;
  /** "Around" means input within this. */
  aroundMinutes: number;
  pushWhenAway: boolean;
}

export const DEFAULT_ANNOUNCE: AnnounceSettings = {
  speak: { info: "never", report: "around", needs_you: "around" },
  waitForGap: true,
  followFocus: true,
  quietHours: { on: false, from: 22 * 60, to: 8 * 60 },
  fullScreenQuiet: true,
  batchSeconds: 20,
  repeatMinutes: 10,
  aroundMinutes: 2,
  pushWhenAway: true,
};

export interface Presence {
  idleMs: number;
  locked: boolean;
  fullScreen: boolean;
  /** Windows Focus / Do Not Disturb; null when unknown. */
  focus: boolean | null;
}

export interface AnnounceDeps {
  settings(): AnnounceSettings;
  /** Duck's own Do Not Disturb: until this moment (epoch ms), or null. */
  dndUntil(): number | null;
  presence(): Promise<Presence>;
  /** Speak is on (the master switch). */
  speakOn(): boolean;
  /** Duck is speaking or reading on this PC now. */
  busy(): boolean;
  /** Say it on this PC; false when the voice can't. `threadId` is where a
   *  reply to it goes (the mic turned on soon after, V8). */
  sayHere(text: string, threadId: string): Promise<boolean>;
  /** Phones with Duck open (in front: the page closes its socket when hidden). */
  phones(): number;
  sayOnPhones(text: string, threadId: string): void;
  push(threadId: string, title: string, body: string): void;
  now?(): number;
}

/** A new announcement waits this long, so what arrives together goes together. */
export const SETTLE_MS = 2000;
/** "A gap": no input for this long. */
export const GAP_MS = 1200;
/** Checked this often while something waits (presence changes on its own). */
const TICK_MS = 1000;
/** What a catch-up says at most. */
const CATCH_UP_MAX = 3;

const COUNT = ["", "One", "Two", "Three", "Four", "Five"];

/** One spoken line for several updates. */
export function batchText(items: { text: string }[], lead?: string): string {
  const texts = items.map((i) => i.text.trim()).filter(Boolean);
  if (texts.length === 1 && !lead) return texts[0];
  const n = texts.length;
  const head = lead ?? `${COUNT[n] ?? n} things.`;
  const shown = texts.slice(0, lead ? CATCH_UP_MAX : texts.length);
  const more = texts.length - shown.length;
  return `${head} ${shown.join(" ")}${more > 0 ? ` And ${more} more in the drawer.` : ""}`;
}

/** A reply's headline: its first sentence (two when the first is very short). */
export function headline(reply: string, max = 220): string {
  const s = sentencesOf(reply);
  let out = s[0] ?? "";
  if (out.length < 40 && s[1]) out = `${out} ${s[1]}`;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

function inQuietHours(q: AnnounceSettings["quietHours"], at: number): boolean {
  if (!q.on || q.from === q.to) return false;
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  return q.from < q.to ? m >= q.from && m < q.to : m >= q.from || m < q.to;
}

/** The next 08:00, for "until morning". */
export function nextMorning(at: number, hour = 8): number {
  const d = new Date(at);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= at) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface Pending extends Announcement {
  at: number;
  repeat?: boolean;
}

export class Announcer {
  private pending: Pending[] = [];
  /** Held back by quiet, for the catch-up. */
  private missed: Pending[] = [];
  /** Delivered needs_you, waiting for an answer: key → when to repeat. */
  private repeats = new Map<string, { a: Pending; at: number }>();
  private lastSpoken = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private d: AnnounceDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  add(a: Announcement): void {
    if (!a.text.trim()) return;
    this.pending = [...this.pending.filter((p) => p.key !== a.key), { ...a, at: this.now() }];
    this.schedule(SETTLE_MS);
  }

  /** It was answered (a card decided, you wrote in its thread): no repeat, and
   *  nothing pending about it is said. */
  answered(key: string): void {
    this.repeats.delete(key);
    this.pending = this.pending.filter((p) => p.key !== key);
    this.missed = this.missed.filter((p) => p.key !== key);
  }

  /** Everything about a thread you've just written in. */
  answeredThread(threadId: string): void {
    for (const [k, r] of this.repeats) if (r.a.threadId === threadId) this.repeats.delete(k);
    this.pending = this.pending.filter((p) => p.threadId !== threadId);
    this.missed = this.missed.filter((p) => p.threadId !== threadId);
  }

  /** Something may have changed (Do Not Disturb went off): look again now. */
  poke(): void {
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private waiting(): boolean {
    return this.pending.length > 0 || this.missed.length > 0 || this.repeats.size > 0;
  }

  /** One look: deliver, hold, or wait. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.step();
    } finally {
      this.running = false;
      if (!this.timer && this.waiting()) this.schedule(this.pending.length || this.missed.length ? TICK_MS : 30_000);
    }
  }

  private async step(): Promise<void> {
    const now = this.now();
    const s = this.d.settings();
    for (const [k, r] of this.repeats)
      if (now >= r.at) {
        this.repeats.delete(k);
        this.pending.push({ ...r.a, text: `Still waiting: ${r.a.text}`, at: now, repeat: true });
      }
    if (!this.pending.length && !this.missed.length) return;
    const p = await this.d.presence();
    const dnd = (this.d.dndUntil() ?? 0) > now;
    const quiet = dnd || (s.followFocus && p.focus === true) || inQuietHours(s.quietHours, now);
    const here = !p.locked && p.idleMs < s.aroundMinutes * 60_000;
    const phones = this.d.phones();
    const voice = this.d.speakOn();
    const spoken = (a: Pending) => s.speak[a.level] === "around";
    const fullScreen = (a: Pending) => here && p.fullScreen && s.fullScreenQuiet && a.level !== "needs_you";
    const silenced = (a: Pending) => quiet || (here && !voice) || fullScreen(a);

    // Quiet over: one short catch-up of what was held back.
    if (this.missed.length && !quiet && (here ? voice && !(p.fullScreen && s.fullScreenQuiet) : phones > 0)) {
      const missed = this.missed;
      this.missed = [];
      this.pending.push({
        level: "report",
        threadId: missed[missed.length - 1].threadId,
        key: "catch-up",
        text: batchText(missed, `While it was quiet: ${missed.length === 1 ? "one thing" : `${COUNT[missed.length]?.toLowerCase() ?? missed.length} things`}.`),
        at: now - SETTLE_MS,
      });
    }

    const settled = this.pending.filter((a) => now - a.at >= SETTLE_MS);
    if (!settled.length) return;
    const say = settled.filter((a) => spoken(a) && !silenced(a) && (here || phones > 0));
    const rest = settled.filter((a) => !say.includes(a));

    // Not said: pushed when you're away (needs_you even in quiet), held for the
    // catch-up when quiet kept it, dropped otherwise (the badge has it).
    const away = !here && phones === 0;
    const pushed = rest.filter((a) => s.pushWhenAway && a.level !== "info" && (away || (quiet && a.level === "needs_you" && !here)));
    if (pushed.length) {
      const last = pushed[pushed.length - 1];
      this.d.push(last.threadId, pushed.length === 1 ? "Duck" : `Duck: ${pushed.length} updates`, batchText(pushed));
    }
    for (const a of rest) if (spoken(a) && (quiet || fullScreen(a)) && a.key !== "catch-up" && !a.repeat) this.missed.push(a);
    for (const a of pushed) this.remember(a, now, s);
    this.pending = this.pending.filter((a) => !rest.includes(a));
    if (!say.length) return;

    // Said: when there's a gap, and no sooner than the batch window after the last.
    if (now - this.lastSpoken < s.batchSeconds * 1000) return;
    if (here && s.waitForGap && (p.idleMs < GAP_MS || this.d.busy())) return;
    const text = batchText(say);
    const last = say[say.length - 1];
    let ok = false;
    if (here) ok = await this.d.sayHere(text, last.threadId);
    if (!ok && phones > 0) {
      this.d.sayOnPhones(text, last.threadId);
      ok = true;
    }
    if (!ok && s.pushWhenAway) this.d.push(last.threadId, "Duck", text);
    this.lastSpoken = this.now();
    this.pending = this.pending.filter((a) => !say.includes(a));
    for (const a of say) this.remember(a, now, s);
  }

  private remember(a: Pending, now: number, s: AnnounceSettings): void {
    if (a.level === "needs_you" && !a.repeat && s.repeatMinutes > 0)
      this.repeats.set(a.key, { a, at: now + s.repeatMinutes * 60_000 });
  }
}
