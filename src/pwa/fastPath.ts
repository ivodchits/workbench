// The phone's fast path (step H5): a few commands parsed on the phone before any
// model sees them, so they work with the desktop unreachable and cost nothing:
// timers, alarms, the flashlight, and play / pause / skip. Only the whole
// utterance counts ("pause", not "pause the build and tell me why"); anything
// else goes to Duck. English only for now.

/** A command the phone runs itself: one of its tools, and what to say. */
export interface FastCommand {
  tool: string;
  input: Record<string, unknown>;
  /** The line shown (and said) once it's done. */
  said: string;
}

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

const UNITS: [RegExp, number][] = [
  [/^(h|hr|hrs|hour|hours)$/, 3600],
  [/^(m|min|mins|minute|minutes)$/, 60],
  [/^(s|sec|secs|second|seconds)$/, 1],
];

/** "twenty five" → 25, "7" → 7, "1.5" → 1.5. */
function number(words: string): number | null {
  if (/^\d+(\.\d+)?$/.test(words)) return Number(words);
  let total = 0;
  for (const w of words.split(/[\s-]+/)) {
    const n = NUMBERS[w];
    if (n === undefined) return null;
    total += n;
  }
  return total || null;
}

/** A length as said: "10 minutes", "an hour and a half", "1h30m", "half an hour",
 *  "90 seconds". Seconds, or null. */
export function lengthOf(text: string): number | null {
  const t = text.trim().replace(/-/g, " ");
  if (/^half an? hour$/.test(t)) return 1800;
  const compact = /^(?:(\d+)h)?\s*(?:(\d+)m(?:in)?)?\s*(?:(\d+)s)?$/.exec(t.replace(/\s+/g, ""));
  if (compact && (compact[1] || compact[2] || compact[3]))
    return Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0);
  let total = 0;
  let last = 0;
  let rest = t;
  const part = /^(.+?)\s+(h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:\s+(?:and\s+)?|$)/;
  while (rest) {
    // "an hour and a half": half the last unit more.
    if (rest === "a half" && last) return total + last / 2;
    const m = part.exec(rest);
    if (!m) return null;
    const n = number(m[1]);
    const unit = UNITS.find(([re]) => re.test(m[2]))?.[1];
    if (n === null || !unit) return null;
    total += n * unit;
    last = unit;
    rest = rest.slice(m[0].length).trim();
  }
  return total ? Math.round(total) : null;
}

/** "10 min", "1 h 30 min", "45 s". */
function lengthText(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h && `${h} h`, m && `${m} min`, sec && `${sec} s`].filter(Boolean).join(" ");
}

/** A time of day as said: "7", "7:30", "7.30 pm", "6 in the morning", "noon".
 *  `HH:MM` (24-hour), or null. */
export function timeOf(text: string): string | null {
  const t = text.trim().replace(/\./g, ":").replace(/\b([ap])\s*m\b/, "$1m");
  if (t === "noon" || t === "midday") return "12:00";
  if (t === "midnight") return "00:00";
  const m = /^(\d{1,2})(?::?\s?(\d{2}))?\s*(am|pm|in the morning|in the evening|at night|tonight)?$/.exec(t);
  if (!m) {
    // In words: "seven pm", "six o'clock".
    const when = /\s*(am|pm|in the morning|in the evening|at night|tonight|o'?clock)$/.exec(t);
    const n = number(when ? t.slice(0, when.index) : t);
    if (!n || !Number.isInteger(n) || n > 12) return null;
    return timeOf(when && !when[1].startsWith("o") ? `${n} ${when[1]}` : String(n));
  }
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  const pm = m[3] === "pm" || m[3] === "in the evening" || m[3] === "at night" || m[3] === "tonight";
  const am = m[3] === "am" || m[3] === "in the morning";
  if ((pm || am) && (h < 1 || h > 12)) return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The utterance without what doesn't change it: "Duck,", "please", "the", the
 *  end's punctuation. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/^\s*(hey\s+)?duck[,!]?\s+/, "")
    .replace(/[.!?]+\s*$/, "")
    .replace(/^(please|can you|could you)\s+/, "")
    .replace(/,?\s+please$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MEDIA: [RegExp, "play" | "pause" | "next" | "previous"][] = [
  [/^(pause|stop)( (the )?(music|song|track|podcast|playback|it))?$/, "pause"],
  [/^(play|resume|unpause|continue)( (the )?(music|song|track|podcast|playback|it))?$/, "play"],
  [/^(next|skip)( (this |the )?(song|track|one))?$/, "next"],
  [/^(next|skip to the next) (song|track)$/, "next"],
  [/^(previous|go back|back)( (song|track|one))?$/, "previous"],
  [/^(previous|last) (song|track)$/, "previous"],
];

/** A timer as said: its length, and what it's for. */
const TIMER = [
  /^(?:set|start) (?:a |an )?(.+?) timer(?: (?:for|called) (.+))?$/,
  /^(?:(?:set|start) (?:a |an )?)?timer (?:for )?(.+?)(?: (?:for|called) (?!\d)(.+))?$/,
  /^(.+?) timer(?: (?:for|called) (.+))?$/,
];

const MEDIA_SAID = { play: "Playing.", pause: "Paused.", next: "Skipped.", previous: "Back one." };

/** `text` as a command the phone runs itself, or null for Duck. */
export function fastPath(text: string): FastCommand | null {
  const t = plain(text);
  if (!t) return null;

  for (const [re, action] of MEDIA) if (re.test(t)) return { tool: "phone_media_control", input: { action }, said: MEDIA_SAID[action] };

  const torch = /^(?:turn |switch )?(?:the )?(?:flashlight|torch|flash light) (on|off)$|^(?:turn|switch) (on|off) (?:the )?(?:flashlight|torch|flash light)$/.exec(t);
  if (torch) {
    const on = (torch[1] ?? torch[2]) === "on";
    return { tool: "phone_flashlight", input: { on }, said: on ? "Flashlight on." : "Flashlight off." };
  }

  for (const re of TIMER) {
    const m = re.exec(t);
    const seconds = m && lengthOf(m[1]);
    if (!seconds || seconds > 86_400) continue;
    const label = m[2]?.replace(/^the /, "");
    return {
      tool: "phone_set_timer",
      input: { seconds, ...(label && { label }) },
      said: `Timer: ${lengthText(seconds)}${label ? ` for ${label}` : ""}.`,
    };
  }

  const alarm =
    /^(?:set (?:an |the |my )?)?alarm (?:for|at) (.+?)(?: (?:called|for) ([a-z].*))?$/.exec(t) ??
    /^wake me(?: up)? at (.+)$/.exec(t);
  if (alarm) {
    const time = timeOf(alarm[1]);
    if (time) {
      const label = alarm[2];
      return { tool: "phone_set_alarm", input: { time, ...(label && { label }) }, said: `Alarm at ${time}.` };
    }
  }
  return null;
}
