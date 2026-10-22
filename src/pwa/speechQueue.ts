// Duck's spoken replies on the phone (step R2): the sentences in order, one after
// another (`duckSpeech.ts` is the browser's side).

import type { Lang } from "../assistant/speakable";

/** One sentence to say: its audio on the way (null: say `text` with the phone's
 *  voice), and its words. */
export interface Part {
  audio: Promise<AudioBuffer | null>;
  text: string;
  lang: Lang;
  /** The desktop's id for its audio. */
  id?: string;
}

export interface Out {
  /** Play a sentence's audio; resolves when it ends or is stopped. */
  play(buffer: AudioBuffer): Promise<void>;
  /** Say it with the phone's voice; resolves when done. */
  say(text: string, lang: Lang): Promise<void>;
  /** Cut what's playing now. */
  cut(): void;
}

/** Sentences played one after another, in the order given. */
export class SpeechQueue {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by `stop`: parts queued before it don't play. */
  private gen = 0;
  private pending = 0;

  constructor(
    private readonly out: Out,
    private readonly changed: () => void = () => {},
    /** A part starts playing: as the audio given, or said with the phone's voice. */
    private readonly started: (part: Part, how: "audio" | "voice") => void = () => {},
  ) {}

  /** Something is queued or playing. */
  get speaking(): boolean {
    return this.pending > 0;
  }

  add(part: Part): void {
    const gen = this.gen;
    this.pending++;
    if (this.pending === 1) this.changed();
    this.chain = this.chain.then(async () => {
      try {
        if (gen !== this.gen) return;
        const buffer = await part.audio.catch(() => null);
        if (gen !== this.gen) return;
        if (buffer) {
          this.started(part, "audio");
          await this.out.play(buffer);
        } else if (part.text.trim()) {
          this.started(part, "voice");
          await this.out.say(part.text, part.lang);
        }
      } catch {
        // a sentence that can't be said is skipped
      } finally {
        if (gen === this.gen) {
          this.pending--;
          if (this.pending === 0) this.changed();
        }
      }
    });
  }

  /** Stop speaking and drop what's queued. */
  stop(): void {
    this.gen++;
    const was = this.pending > 0;
    this.pending = 0;
    this.out.cut();
    if (was) this.changed();
  }
}
