// Read-aloud (step V3): Duck reads a source to you a section at a time, on the
// desktop's speakers or on the phone that asked.
//
// - A source (a session's reply, a note, a summary, some text) is cut into
//   sections (`sections`): paragraphs merged up to a size, a long one cut at its
//   sentences. Each section is made only when its turn comes (narrated by Haiku
//   first in `narrate` mode, the next one while this one plays), so stopping early
//   spends nothing on the rest.
// - It starts once the reply that asked for it is over (`quiet`), so Duck's "here
//   it is" isn't read over.
// - Pause, resume, next, previous and stop come from the drawer's and the phone's
//   reader bar. A cut from outside (Esc, the push-to-talk key, a new message of
//   yours) pauses it.
// - The position is kept per source (`ReadPosition`), so reading the same source
//   again, or "continue reading", picks up at the section it stopped in. A source
//   read to the end starts over next time; one that changed starts over too.

import { Sentences, type Lang } from "./speakable";

/** A sentence ready for the voice. */
export interface Spoken {
  text: string;
  lang: Lang;
}

/** Where a read is heard. */
export interface Voice {
  where: "desktop" | "phone";
  /** Say one section's sentences, in order; true when it was heard to the end,
   *  false when it was cut. Throws when the voice can't speak. */
  play(sentences: Promise<Spoken | null>[]): Promise<boolean>;
  /** Cut what's playing. */
  cut(): void;
}

/** What `read_aloud` was asked to read, kept so "continue reading" can read it
 *  again (`source` and its fields as the tool takes them). */
export type SourceRef = Record<string, unknown>;

export interface ReadJob {
  /** Where its position is kept ("note:<project>/<name>", "session:<id>"). */
  key: string;
  title: string;
  /** The source, cut by `sections`. */
  sections: string[];
  /** Rewrite each section for listening before it's read. */
  narrate: boolean;
  /** The thread that asked: its reply plays first. */
  threadId: string;
  /** Stop after about this many characters have been read. */
  maxChars: number;
  source: SourceRef;
}

export interface ReadPosition {
  key: string;
  title: string;
  /** The section to read next, 0-based. */
  section: number;
  sections: number;
  /** The source's text as it was (`hashText`): a changed source starts over. */
  hash: string;
  source: SourceRef;
  /** Epoch ms. */
  at: number;
}

export interface ReaderView {
  threadId: string;
  key: string;
  title: string;
  /** 0-based. */
  section: number;
  sections: number;
  state: "reading" | "paused";
  where: "desktop" | "phone";
}

export interface ReaderDeps {
  /** A section rewritten for listening (the Haiku primitive `narrate`). */
  narrate(text: string, signal: AbortSignal): Promise<string>;
  /** A sentence made speakable (`prepareSentence`); null when nothing in it can be said. */
  prepare(sentence: string): Promise<Spoken | null>;
  /** Kept positions: `set(key, null)` forgets one. */
  load(key: string): ReadPosition | undefined;
  save(key: string, p: ReadPosition | null): void;
  /** Resolves when nothing else is speaking for `threadId` (its reply is over). */
  quiet(threadId: string): Promise<void>;
  /** The view changed (null: nothing is being read). */
  changed(v: ReaderView | null): void;
  /** Reading stopped on its own: the end, the length cap, or a failure. */
  ended?(threadId: string, why: string): void;
  now?(): number;
}

/** About how many characters a minute of speech is. */
export const CHARS_PER_MINUTE = 900;
/** The longest section, read word for word / before narration. */
export const VERBATIM_SECTION = 700;
export const NARRATE_SECTION = 2500;

/** FNV-1a over the text, as hex. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** `text` cut at sentence ends into pieces of at most about `max` characters. */
function cutLong(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The source cut into sections of about `max` characters: paragraphs (a code
 * block stays whole, with the paragraph before it) merged while they fit, a long
 * paragraph cut at its sentences.
 */
export function sections(text: string, max: number): string[] {
  const blocks: string[] = [];
  let fence = false;
  let cur: string[] = [];
  const flush = () => {
    const b = cur.join("\n").trim();
    if (b) blocks.push(b);
    cur = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) flush();
    else cur.push(line);
  }
  flush();
  const out: string[] = [];
  let acc = "";
  for (const b of blocks) {
    const pieces = b.length > max && !/^\s*(```|~~~)/m.test(b) ? cutLong(b, max) : [b];
    for (const p of pieces) {
      if (acc && acc.length + p.length + 2 > max) {
        out.push(acc);
        acc = "";
      }
      acc = acc ? `${acc}\n\n${p}` : p;
    }
  }
  if (acc) out.push(acc);
  return out;
}

/** A section's sentences, as `Sentences` cuts a reply. */
export function sentencesOf(text: string): string[] {
  const s = new Sentences();
  return [...s.push(`${text}\n`), ...s.end()];
}

interface Current {
  job: ReadJob;
  voice: Voice;
  hash: string;
  section: number;
  state: "reading" | "paused";
  /** Characters read so far. */
  read: number;
  /** Narrated sections, made ahead by one. */
  made: Map<number, Promise<string>>;
  ctl: AbortController;
}

export class Reader {
  private cur: Current | null = null;
  /** Bumped by everything that ends a playing loop. */
  private gen = 0;

  constructor(private deps: ReaderDeps) {}

  view(): ReaderView | null {
    const c = this.cur;
    if (!c) return null;
    return {
      threadId: c.job.threadId,
      key: c.job.key,
      title: c.job.title,
      section: c.section,
      sections: c.job.sections.length,
      state: c.state,
      where: c.voice.where,
    };
  }

  /** The kept position for `job`'s source, if reading it again would pick up there. */
  resumable(job: Pick<ReadJob, "key" | "sections">): number {
    const p = this.deps.load(job.key);
    const hash = hashText(job.sections.join("\n\n"));
    return p && p.hash === hash && p.section > 0 && p.section < job.sections.length ? p.section : 0;
  }

  /** Start reading `job` from `from` (0-based). Whatever was reading stops, its
   *  place kept. */
  start(job: ReadJob, voice: Voice, from: number): void {
    this.stop();
    const hash = hashText(job.sections.join("\n\n"));
    this.cur = {
      job,
      voice,
      hash,
      section: Math.min(Math.max(0, from), Math.max(0, job.sections.length - 1)),
      state: "reading",
      read: 0,
      made: new Map(),
      ctl: new AbortController(),
    };
    this.keep();
    this.changed();
    void this.loop(++this.gen, true);
  }

  pause(): void {
    const c = this.cur;
    if (!c || c.state !== "reading") return;
    this.gen++;
    c.state = "paused";
    c.voice.cut();
    this.keep();
    this.changed();
  }

  resume(): void {
    const c = this.cur;
    if (!c || c.state !== "paused") return;
    c.state = "reading";
    this.changed();
    void this.loop(++this.gen, false);
  }

  /** Move by `by` sections and read from there. */
  skip(by: number): void {
    const c = this.cur;
    if (!c) return;
    const to = Math.min(Math.max(0, c.section + by), c.job.sections.length - 1);
    this.gen++;
    if (c.state === "reading") c.voice.cut();
    c.section = to;
    c.state = "reading";
    this.keep();
    this.changed();
    void this.loop(++this.gen, false);
  }

  /** Stop reading; the place is kept for next time. */
  stop(): void {
    const c = this.cur;
    if (!c) return;
    this.gen++;
    if (c.state === "reading") c.voice.cut();
    c.ctl.abort();
    this.keep();
    this.cur = null;
    this.changed();
  }

  private changed(): void {
    this.deps.changed(this.view());
  }

  private keep(): void {
    const c = this.cur;
    if (!c) return;
    this.deps.save(c.job.key, {
      key: c.job.key,
      title: c.job.title,
      section: c.section,
      sections: c.job.sections.length,
      hash: c.hash,
      source: c.job.source,
      at: this.deps.now?.() ?? Date.now(),
    });
  }

  private text(c: Current, i: number): Promise<string> {
    let p = c.made.get(i);
    if (!p) {
      const raw = c.job.sections[i];
      p = c.job.narrate ? this.deps.narrate(raw, c.ctl.signal) : Promise.resolve(raw);
      // A failed narration is retried when the section comes round again.
      p.catch(() => c.made.delete(i));
      c.made.set(i, p);
    }
    return p;
  }

  private finish(c: Current, why: string, done: boolean): void {
    if (done) this.deps.save(c.job.key, null);
    else this.keep();
    c.ctl.abort();
    this.cur = null;
    this.changed();
    this.deps.ended?.(c.job.threadId, why);
  }

  private async loop(g: number, first: boolean): Promise<void> {
    const c = this.cur;
    if (!c) return;
    const live = () => g === this.gen && this.cur === c;
    if (first) await this.deps.quiet(c.job.threadId);
    while (live()) {
      const i = c.section;
      if (i >= c.job.sections.length) return this.finish(c, "the end", true);
      let text: string;
      try {
        text = await this.text(c, i);
      } catch (e) {
        if (live()) this.finish(c, `couldn't narrate section ${i + 1}: ${e instanceof Error ? e.message : String(e)}`, false);
        return;
      }
      if (!live()) return;
      // The next section is narrated while this one plays.
      if (c.job.narrate && i + 1 < c.job.sections.length) void this.text(c, i + 1).catch(() => {});
      let heard: boolean;
      try {
        heard = await c.voice.play(sentencesOf(text).map((s) => this.deps.prepare(s)));
      } catch (e) {
        if (live()) this.finish(c, `the voice failed: ${e instanceof Error ? e.message : String(e)}`, false);
        return;
      }
      if (!live()) return;
      if (!heard) {
        // Cut from outside: hold here.
        this.gen++;
        c.state = "paused";
        this.keep();
        this.changed();
        return;
      }
      c.read += text.length;
      c.section = i + 1;
      if (c.section >= c.job.sections.length) return this.finish(c, "the end", true);
      if (c.read >= c.job.maxChars) return this.finish(c, "the length you asked for", false);
      this.keep();
      this.changed();
    }
  }
}
