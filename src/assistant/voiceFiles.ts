// Talking about what you drop (step G2): files dropped, pasted or shared while you
// speak, or just before or after, go with that voice turn rather than waiting in
// the composer. Shared by the desktop (`voiceState.ts`) and the phone (`duck.ts`).
//
// - A turn opens when you start talking (push-to-talk listening, conversation mode
//   hearing you) and ends when you stop. Files staged up to `BEFORE_MS` before it
//   opens join it; so does a drop while it's open, or within `AFTER_MS` of its end.
// - The turn's words go out with every file it has (`turn`). When they count files
//   ("these two", "три файла") and fewer are there, they wait up to
//   `COUNT_WAIT_MS` for the rest; a drop or the timeout releases them.
// - A drop after the words went, still within `AFTER_MS`, is late (`Sent.late`):
//   the engine resends a turn that hasn't stood yet with it, or sends it as a
//   follow-up (`engine.lateFiles`).
// - Files a turn never took (nothing was heard) go back to the composer.

import type { AttachmentRef } from "./attachments";

/** Files staged this soon before you start talking go with what you say. */
export const BEFORE_MS = 10_000;
/** A drop this soon after a voice turn ends belongs to it. */
export const AFTER_MS = 10_000;
/** How long words that count files wait for the rest. */
export const COUNT_WAIT_MS = 6_000;

const NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  "два": 2, "две": 2, "двух": 2, "три": 3, "трёх": 3, "трех": 3, "четыре": 4, "пять": 5,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  zwei: 2, drei: 3, vier: 4, "fünf": 5,
  deux: 2, trois: 3, quatre: 4, cinq: 5,
};
const BOTH = new Set(["both", "оба", "обе", "обоих", "ambos", "ambas", "beide", "beiden"]);
/** Words that point at the files: "these two", "эти три", "estos dos", "les deux". */
const POINTERS = new Set([
  "these", "those", "the", "all", "my",
  "эти", "этих", "те", "все", "мои",
  "estos", "estas", "esos", "esas", "los", "las", "mis",
  "diese", "die", "alle", "meine",
  "ces", "les", "mes",
]);
const FILE_WORD =
  /^(files?|pictures?|images?|screenshots?|photos?|pdfs?|documents?|docs?|logs?|файл\p{L}*|картин\p{L}*|скрин\p{L}*|фот\p{L}*|документ\p{L}*|archivos?|ficheros?|im[aá]gen(es)?|fotos?|capturas?|documentos?|dateien|datei|bilder?|fichiers?)$/u;

/** How many files the words count: `explicit` when they name files ("two
 *  files", "both pictures"), not just "these two". Null when they don't count. */
export function spokenCount(text: string): { count: number; explicit: boolean } | null {
  const words = text.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  let count = 0;
  let explicit = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const named = FILE_WORD.test(words[i + 1] ?? "");
    let n = 0;
    if (BOTH.has(w)) n = 2;
    else if (/^\d{1,2}$/.test(w) && named) n = Number(w);
    else if (NUMBERS[w] && (named || POINTERS.has(words[i - 1] ?? ""))) n = NUMBERS[w];
    if (n < 2) continue;
    // The biggest count wins: "both … these three files" is three.
    count = Math.max(count, n);
    explicit ||= named;
  }
  return count ? { count, explicit } : null;
}

/** The line the model sees ahead of a spoken turn's files. */
export function manifestLine(files: readonly Pick<AttachmentRef, "name">[]): string {
  const n = files.length;
  return `${n} ${n === 1 ? "file" : "files"}: ${files.map((f) => f.name).join(", ")}`;
}

const MANIFEST = /^\[\d+ files?: [^\n]*\]$/;

/** A message's blocks without the manifest (the chips show the files). */
export function withoutManifest<T extends { type?: string; text?: string }>(blocks: readonly T[]): T[] {
  return blocks.filter(
    (b, i) => !(i === 0 && b.type === "text" && MANIFEST.test(b.text ?? "") && blocks[1]?.type === "attachment"),
  );
}

/** What the voice pill shows: "🎤 + 2 files", or the wait. */
export function pillText(files: number, missing: number, coming = 0): string {
  if (missing > 0) return `waiting for ${missing} more ${missing === 1 ? "file" : "files"}…`;
  const all = files + coming;
  return `🎤 + ${all} ${all === 1 ? "file" : "files"}${coming ? " (adding…)" : ""}`;
}

/** A turn's words that went out: where late files go. */
export interface Sent {
  /** Files dropped after the words went (within `AFTER_MS`). */
  late(files: AttachmentRef[]): void;
}

/** Sends a turn's words with its files. */
export type Go = (files: AttachmentRef[]) => Sent | false | void;

export interface VoiceFilesDeps {
  now(): number;
  /** Run `fn` after `ms`; the result cancels it. */
  later(ms: number, fn: () => void): () => void;
  /** Something the pill shows changed. */
  changed(): void;
  /** Files no turn took, back to the composer. */
  back(files: AttachmentRef[]): void;
}

export interface VoiceFiles {
  /** Staged for the turn (the pill's chips). */
  files(): AttachmentRef[];
  /** Files on their way (being stored or uploaded) for it. */
  coming(): number;
  /** Files the words counted that aren't here yet (the turn waits). */
  missing(): number;
  /** A voice turn opened; `recent` (staged just before) join it. */
  opened(recent?: AttachmentRef[]): void;
  /** You stopped talking. */
  closed(): void;
  /** A drop now belongs to the voice turn. */
  claims(): boolean;
  /** `n` files were dropped while `claims()` and are being stored. */
  expect(n: number): void;
  /** Files stored: `settled` of the expected ones are done (stored or failed). */
  arrive(files: AttachmentRef[], settled?: number): void;
  /** The turn's words are ready: `go` sends them with the files, now or once the
   *  counted ones are here. Its result takes late files; `false` says they didn't
   *  go, and the files wait. */
  turn(text: string, go: Go): void;
  /** The words were taken back (you went on talking, or nothing went): their
   *  files wait for the turn's next words. */
  unsend(): void;
  /** Forget a turn waiting for files. */
  cancel(): void;
  /** A turn whose words went at `at`, from before a reload (the phone opened
   *  afresh by a share): drops within the window are late to it. */
  resume(at: number, to: Sent): void;
}

export function createVoiceFiles(deps: VoiceFilesDeps): VoiceFiles {
  let files: AttachmentRef[] = [];
  let coming = 0;
  let open = false;
  let endedAt = -Infinity;
  let held: { need: number; go: Go; stop: () => void } | null = null;
  let sent: { files: AttachmentRef[]; at: number; to: Sent } | null = null;
  let expire: (() => void) | null = null;

  const changed = () => deps.changed();
  const merge = (to: AttachmentRef[], more: readonly AttachmentRef[]) => {
    for (const f of more) if (!to.some((t) => t.id === f.id && t.name === f.name)) to.push(f);
    return to;
  };
  const recentEnd = () => deps.now() - endedAt <= AFTER_MS;
  const recentSend = () => !!sent && deps.now() - sent.at <= AFTER_MS;

  /** After the window, files nothing took go back to the composer. */
  function arm() {
    expire?.();
    expire = deps.later(AFTER_MS, () => {
      expire = null;
      if (open || held || coming || !files.length) return;
      const back = files;
      files = [];
      changed();
      deps.back(back);
    });
  }

  function release() {
    const h = held;
    if (!h) return;
    held = null;
    h.stop();
    const take = files;
    files = [];
    const to = h.go(take);
    // Refused (the words can't go yet): the files wait for the next try.
    if (to === false) files = merge(take, files);
    sent = to ? { files: take, at: deps.now(), to } : null;
    changed();
  }

  const ready = () => !!held && coming === 0 && files.length >= held.need;

  return {
    files: () => files,
    coming: () => coming,
    missing: () => (held ? Math.max(0, held.need - files.length - coming) : 0),

    opened(recent = []) {
      open = true;
      // A new turn: drops are its own now, not the last one's.
      sent = null;
      expire?.();
      expire = null;
      if (recent.length) files = merge([...files], recent);
      changed();
    },

    closed() {
      if (!open) return;
      open = false;
      endedAt = deps.now();
      arm();
      changed();
    },

    claims: () => open || !!held || recentEnd() || recentSend(),

    expect(n) {
      coming += n;
      changed();
    },

    arrive(stored, settled = stored.length) {
      coming = Math.max(0, coming - settled);
      if (held || open || (!sent && recentEnd())) {
        files = merge([...files], stored);
        if (!open && !held) arm();
        if (ready()) release();
        else changed();
        return;
      }
      if (sent && recentSend()) {
        const fresh = stored.filter((f) => !sent!.files.some((s) => s.id === f.id && s.name === f.name));
        if (fresh.length) {
          sent.files.push(...fresh);
          sent.to.late(fresh);
        }
        changed();
        return;
      }
      changed();
      if (stored.length) deps.back(stored);
    },

    turn(text, go) {
      expire?.();
      expire = null;
      const counted = spokenCount(text);
      // "These two" waits only when files are coming in: with none, it's about
      // something else. "Two files" always does.
      const need = counted && (counted.explicit || files.length || coming) ? counted.count : 0;
      if (held) {
        held.go = go;
        held.need = need;
      } else if (need > files.length || coming) {
        held = { need, go, stop: deps.later(COUNT_WAIT_MS, release) };
      } else {
        held = { need, go, stop: () => {} };
      }
      if (ready() || !need && !coming) release();
      else changed();
    },

    unsend() {
      if (!sent) return;
      files = merge([...sent.files], files);
      sent = null;
      changed();
    },

    resume(at, to) {
      sent = { files: [], at, to };
    },

    cancel() {
      if (!held) return;
      held.stop();
      held = null;
      if (!open) arm();
      changed();
    },
  };
}
