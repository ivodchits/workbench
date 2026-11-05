// A voice message's transcript into a prompt being written: shared by the
// desktop composer (`panels/voiceNote`) and the phone's (`pwa/transcript`).

/** `text` added to `draft`: after a space, or straight on after a line break or
 *  a space already there. Nothing heard leaves the draft as it was. */
export function joinDictation(draft: string, text: string): string {
  const t = text.trim();
  if (!t) return draft;
  if (!draft || /\s$/.test(draft)) return draft + t;
  return `${draft} ${t}`;
}

/** Seconds as m:ss, for a recording's timer. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
