// Text-to-speech for terminal selections — reads the currently selected text
// aloud (the "Speak selection" context-menu item / Ctrl+Shift+L in a console).
//
// Backed by the Web Speech API's *synthesis* half (`window.speechSynthesis`),
// which WebView2 supports out of the box using the Windows OneCore/SAPI voices
// installed on the machine. No dependency, no Rust, works offline. Recognition
// (speech-to-text) is a separate API WebView2 does *not* ship — we only speak.
//
// Multilingual: any language reads correctly as long as a matching voice is
// installed in Windows (Settings → Time & Language → Speech → Manage voices).
// We lightly auto-detect Spanish and pick an installed `es-*` voice for it, so
// Spanish output isn't mangled by an English voice's phonetics; everything else
// falls back to the system default voice.

/** Installed voices, refreshed from the engine (see the `voiceschanged` wiring). */
let voices: SpeechSynthesisVoice[] = [];

const supported = typeof window !== "undefined" && "speechSynthesis" in window;

function loadVoices(): void {
  voices = window.speechSynthesis.getVoices();
}

// `getVoices()` is empty until the engine finishes enumerating (it populates
// asynchronously on first use), so read it now *and* on the `voiceschanged`
// event that fires once the list is ready.
if (supported) {
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

/**
 * Cheap Spanish guess. Terminal output is overwhelmingly English/code, so we only
 * branch to Spanish on a *positive* signal — inverted punctuation (¿ ¡), ñ / an
 * accented vowel, or a couple of common Spanish function words — and otherwise
 * return null to let the default voice read it. Returns a BCP-47 language prefix.
 */
function detectLang(text: string): string | null {
  if (/[¿¡ñ]/i.test(text) || /[áéíóú]/i.test(text)) return "es";
  const hits = text
    .toLowerCase()
    .match(/\b(el|la|los|las|un|una|que|de|del|por|para|con|pero|más|como|está|están|hola|gracias|también)\b/g);
  if (hits && hits.length >= 2) return "es";
  return null;
}

/** The best installed voice whose language matches `lang` (e.g. "es" → es-ES / es-MX), or null. */
function pickVoice(lang: string | null): SpeechSynthesisVoice | null {
  if (!lang) return null;
  return voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? null;
}

/**
 * Split `text` into short chunks at sentence / line boundaries. Chromium (and thus
 * WebView2) silently cuts off a *single* utterance after ~15s of speech; queuing
 * several shorter utterances instead sidesteps that, so a long selection reads to
 * the end. Chunks stay whole words and cap around `MAX` characters.
 */
function chunk(text: string): string[] {
  const MAX = 200;
  const pieces = text.split(/(?<=[.!?…\n])\s+/); // keep the terminator with its sentence
  const out: string[] = [];
  let buf = "";
  for (const piece of pieces) {
    for (const part of piece.length > MAX ? splitLong(piece, MAX) : [piece]) {
      if (buf && buf.length + part.length + 1 > MAX) {
        out.push(buf);
        buf = "";
      }
      buf = buf ? `${buf} ${part}` : part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Hard-wrap an over-long run (e.g. a URL or a wall of code) on word boundaries. */
function splitLong(s: string, max: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let buf = "";
  for (const w of words) {
    if (buf && buf.length + w.length + 1 > max) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf} ${w}` : w;
  }
  if (buf) out.push(buf);
  return out;
}

/** True while an utterance is speaking or queued. */
export function isSpeaking(): boolean {
  return supported && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}

/** Stop and clear everything currently speaking / queued. */
export function stopSpeaking(): void {
  if (supported) window.speechSynthesis.cancel();
}

/**
 * Speak `text` aloud, interrupting anything already speaking. No-op on an empty
 * selection or where the API is unavailable. Auto-detects Spanish and uses an
 * installed Spanish voice when present; otherwise the system default reads it.
 */
export function speak(text: string): void {
  if (!supported) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  window.speechSynthesis.cancel(); // interrupt any in-flight / queued speech

  const lang = detectLang(trimmed);
  const voice = pickVoice(lang);

  for (const part of chunk(trimmed)) {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else if (lang) {
      // No installed voice for the detected language, but hint the engine anyway
      // so a matching OneCore voice is used if one exists under the hood.
      u.lang = lang;
    }
    window.speechSynthesis.speak(u);
  }
}
