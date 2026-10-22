# /// script
# requires-python = ">=3.12"
# dependencies = ["livekit", "onnxruntime==1.31.0", "onnx-asr[hub]==0.12.0", "numpy", "soundfile", "scipy", "transformers"]
# ///
"""Score the phone's conversation recordings (step V7): how much of Duck's voice the
phone's mic hears, and what the desktop's pipeline makes of it, chain by chain.

    uv run score_phone.py                    # every recording under recordings/phone/
    uv run score_phone.py 20261022-133045    # one

A recording is made by the app: Duck's voice settings, "Save the phone's conversation
audio", then conversation mode on the phone (`src-tauri/src/voice/phone_record.rs`). It's
the phone's mic as the desktop heard it, the sentences the phone played (the desktop
voice's audio for each), and what the app did (playing on/off, cuts, turns, echo dropped).

The runs to make, on the phone's speaker at normal volume, once per echo path (the phone's
Duck settings, "echo path"):
  quiet      ask for a long reply ("read me the plan's V7 step") and say nothing until it
             ends: every cut and every turn is Duck hearing itself.
  interrupt  ask for a long reply and talk over it 10 times ("stop", "wait", a question),
             a few seconds apart: each should cut within ~0.5 s.
End the run's folder name in -quiet or -interrupt. A recording with `cues` in its meta
(the synthetic ones made from X0's) also scores what was caught.

Chains, replayed on the recording (Silero VAD and Parakeet, as the app runs them):
  before V7     ~0.3 s of speech while Duck plays cuts it; whatever's heard is a turn
  words         a cut needs words not mostly Duck's (the last 1.2 s, checked at 0.3 s
                and every 0.26 s after); turns heard while it spoke that are mostly its
                words are dropped (the self-voice check)
  aec3          the desktop cancels the echo itself (WebRTC AEC3), its reference the
                desktop voice's audio placed where the phone said each sentence started,
                delayed to just ahead of its echo; then VAD as before V7, and the
                self-voice check
  aec3+gate     and a cut must be louder than the echo left (aec::Gate)
  aec3+gate+w   and its words not mostly Duck's

Metrics:
  echo level    the mic while Duck plays, dBFS (the room's floor alongside)
  echo return   the mic over the desktop voice's own audio, dB: lower means the phone's
                echo cancellation removes more
  lag           how long after the phone said a sentence started its echo comes
  ERLE          echo the desktop's AEC3 removed while Duck played, dB
  cuts          barge-ins fired while Duck played (quiet runs: all false)
  caught        cued interruptions cut within 5 s of the cue
  turns         turns heard while Duck played (kept after the self-voice check)
"""
import json, re, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly
from _paths import DATA

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SR, FR = 16000, 512          # the app's rate and VAD frame (32 ms)
FS = FR / SR
BARGE = 9                    # conversation.rs BARGE_FRAMES
RECHECK = 8                  # RECHECK_FRAMES
WINDOW = int(1.2 * SR)       # BARGE_WINDOW
SAID_NOW, SAID_WITHIN = 10.0, 30.0
GAP_S = 0.6                  # a pause this long closes a stretch
REFRACTORY_S = 1.5
LEAD = int(0.06 * SR)        # the reference is placed this far ahead of its echo
CATCH_S = 5.0


def words(s):
    return re.findall(r"\w+", s.lower().replace("ё", "е"))


def self_voice(heard, said):
    """aec::self_voice: half the words heard or more are Duck's."""
    h = words(heard)
    if not h:
        return False
    s = set(words(said))
    return 2 * sum(w in s for w in h) >= len(h)


def said_at(said, t, within):
    """What the phone started saying within `within` s of `t`, and the sentence playing then."""
    before = [x for x in said if x[0] <= t]
    if not before:
        return ""
    last = before[-1]
    return " ".join(x[1] for x in before if t - x[0] <= within or x is last)


def load_asr():
    import onnx_asr
    from huggingface_hub import snapshot_download
    path = snapshot_download("istupakov/parakeet-tdt-0.6b-v3-onnx", local_dir=str(DATA / "models" / "parakeet-tdt-0.6b-v3-onnx"))
    return onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, quantization="int8", providers=["CPUExecutionProvider"])


def run_apm(mic, ref):
    """AEC3 at 16 kHz, 10 ms chunks, the reference given before each chunk (aec::Canceller)."""
    from livekit import rtc
    apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=False, high_pass_filter=True, auto_gain_control=False)
    ch = SR // 100
    to16 = lambda a: (np.clip(a, -1, 1) * 32767).astype(np.int16)
    m16, r16 = to16(mic), to16(ref)
    out = np.zeros(len(mic), np.int16)
    for i in range(0, len(mic) - ch + 1, ch):
        rf = rtc.AudioFrame(data=r16[i:i + ch].tobytes(), sample_rate=SR, num_channels=1, samples_per_channel=ch)
        apm.process_reverse_stream(rf)
        mf = rtc.AudioFrame(data=m16[i:i + ch].tobytes(), sample_rate=SR, num_channels=1, samples_per_channel=ch)
        apm.process_stream(mf)
        out[i:i + ch] = np.frombuffer(bytes(mf.data), np.int16)
    return out.astype(np.float32) / 32767


def dbfs(e):
    return float(10 * np.log10(np.mean(e) + 1e-12)) if len(e) else None


def gate_mask(e_raw, e_clean, played, probs):
    """aec::Gate, frame by frame, as it learns: whether speech in each frame can be you."""
    LEARN, LEARNED, TALKING, MARGIN = 600, 30, 1e-6, 4.0
    ratios, levels, floors, ok = [], [], [], np.ones(len(e_raw), bool)
    for k in range(len(e_raw)):
        talking = played[k] > TALKING
        if probs[k] < 0.35:
            if talking:
                levels = (levels + [played[k]])[-LEARN:]
                if played[k] >= np.percentile(levels, 50):
                    ratios = (ratios + [e_clean[k] / played[k]])[-LEARN:]
            else:
                floors = (floors + [e_clean[k]])[-LEARN:]
        if talking and len(ratios) >= LEARNED:
            floor = np.percentile(floors, 90) if len(floors) >= LEARNED else 0.0
            ok[k] = e_clean[k] > MARGIN * max(np.percentile(ratios, 90) * played[k], floor)
    return ok


def score(d, asr):
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    events = json.loads((d / "events.json").read_text(encoding="utf-8"))
    mic, rate = sf.read(str(d / "mic.wav"), dtype="float32")
    assert rate == SR, f"{d}: mic.wav is {rate} Hz"
    n = len(mic) // FR

    # Where Duck played: between playing on and off (or a cut).
    playing = np.zeros(n, bool)
    on_at = None
    for e in events:
        k = e["at"] // FR
        if e["kind"] == "playing" and e.get("on"):
            on_at = k
        elif e["kind"] in ("playing", "cut") and on_at is not None:
            playing[on_at:k] = True
            on_at = None
    if on_at is not None:
        playing[on_at:] = True
    said = [(e["at"] / SR, e.get("text", "")) for e in events if e["kind"] == "said"]

    # The desktop voice's audio where the phone started each sentence.
    ref = np.zeros(len(mic), np.float32)
    for e in events:
        if e["kind"] == "said" and e.get("wav"):
            w, r = sf.read(str(d / e["wav"]), dtype="float32")
            if w.ndim > 1:
                w = w.mean(axis=1)
            if r != SR:
                g = np.gcd(r, SR)
                w = resample_poly(w, SR // g, r // g).astype(np.float32)
            a = e["at"]
            m = min(len(w), len(ref) - a)
            if m > 0:
                ref[a:a + m] += w[:m]

    energy = lambda x: (x[: n * FR].reshape(n, FR) ** 2).mean(axis=1)
    e_mic = energy(mic)

    from score_turns import Vad
    vad = lambda x: (lambda v: np.array([v(x[i * FR:(i + 1) * FR]) for i in range(n)]))(Vad())
    probs_raw = vad(mic)

    out = {"meta": meta, "seconds": round(len(mic) / SR, 1), "played_s": round(playing.sum() * FS, 1)}
    out["echo_dbfs"] = dbfs(e_mic[playing])
    out["floor_dbfs"] = dbfs(e_mic[~playing & (probs_raw < 0.3)])
    signals = {"raw": (mic, probs_raw)}
    if ref.any():
        # The echo comes some 0-800 ms after the phone said it started.
        hi = int(0.8 * SR)
        c = fftconvolve(mic, ref[::-1], mode="full")[len(ref) - 1:len(ref) - 1 + hi]
        lag = int(np.argmax(np.abs(c)))
        shifted = np.concatenate([np.zeros(lag, np.float32), ref])[: len(mic)]
        e_s = energy(shifted)
        talk = (e_s > 1e-5) & playing
        out["lag_ms"] = int(lag / SR * 1000)
        out["echo_return_db"] = round(float(10 * np.log10(e_mic[talk].sum() / max(e_s[talk].sum(), 1e-12))), 1) if talk.any() else None
        lead = np.concatenate([np.zeros(max(0, lag - LEAD), np.float32), ref])[: len(mic)]
        clean = run_apm(mic, lead)
        e_clean = energy(clean)
        out["erle_db"] = round(float(10 * np.log10(e_mic[talk].sum() / max(e_clean[talk].sum(), 1e-12))), 1) if talk.any() else None
        probs_clean = vad(clean)
        signals["aec3"] = (clean, probs_clean)
        played = energy(np.concatenate([np.zeros(LEAD, np.float32), lead])[: len(mic)])
        gate = gate_mask(e_mic, e_clean, played, probs_clean)
        sf.write(str(d / "out_aec3.wav"), clean, SR, subtype="PCM_16")

    def barges(sig, probs, allowed=None, check_words=False):
        """Cuts fired over Duck's voice."""
        cuts, run, last, checked = [], 0, -1e9, None
        for k in range(n):
            ok = probs[k] > 0.5 and (allowed is None or allowed[k])
            run = run + 1 if ok else 0
            t = (k + 1) * FS
            if not playing[k] or run < BARGE or t - last <= REFRACTORY_S:
                if run < BARGE:
                    checked = None
                continue
            if not check_words:
                if run == BARGE or checked is None:
                    cuts.append({"t": round(t, 2)})
                    last, checked = t, None
                continue
            if checked is None or run >= checked + RECHECK:
                checked = run
                to = (k + 1) * FR
                heard = asr.recognize(sig[max((k + 1 - run) * FR, to - WINDOW):to])
                if words(heard) and not self_voice(heard, said_at(said, t, SAID_NOW)):
                    cuts.append({"t": round(t, 2), "heard": heard})
                    last, checked = t, None
        return cuts

    def turns(sig, probs):
        """Stretches heard while Duck played, transcribed; `echo` when mostly its words."""
        speech = probs > 0.5
        found, k = [], 0
        while k < n:
            if not speech[k]:
                k += 1
                continue
            a, quiet = k, 0
            while k < n and quiet < GAP_S / FS:
                quiet = 0 if speech[k] else quiet + 1
                k += 1
            b = k - quiet
            if playing[a:b + 1].any() and (b - a) * FS >= 0.25:
                text = asr.recognize(sig[max(0, a * FR - 3200):b * FR + 3200])
                if words(text):
                    found.append({"t": round(a * FS, 2), "heard": text, "echo": self_voice(text, said_at(said, b * FS, SAID_WITHIN))})
        return found

    cues = [c / SR for c in meta.get("cues", [])]

    def caught(cuts):
        return sum(any(c <= x["t"] <= c + CATCH_S for x in cuts) for c in cues)

    def false(cuts):
        return [x for x in cuts if not any(c <= x["t"] <= c + CATCH_S for c in cues)]

    chains = {}
    t_raw = turns(mic, probs_raw)
    plan = [("before V7", "raw", None, False, False), ("words", "raw", None, True, True)]
    if "aec3" in signals:
        plan += [("aec3", "aec3", None, False, True), ("aec3+gate", "aec3", gate, False, True), ("aec3+gate+w", "aec3", gate, True, True)]
    t_by = {"raw": t_raw}
    for name, sig_name, allowed, check, self_check in plan:
        sig, probs = signals[sig_name]
        if sig_name not in t_by:
            t_by[sig_name] = turns(sig, probs)
        cuts = barges(sig, probs, allowed, check)
        ts = t_by[sig_name]
        kept = [x for x in ts if not (self_check and x["echo"])]
        chains[name] = {"cuts": len(cuts), "false": len(false(cuts)), "caught": f"{caught(cuts)}/{len(cues)}" if cues else None,
                        "turns": len(kept), "false_cuts": [x for x in false(cuts)][:20], "kept_turns": kept[:20]}
    out["chains"] = chains
    out["app"] = {k: sum(e["kind"] == k for e in events) for k in ("cut", "echo", "barge")}
    out["app"]["turns"] = sum(e["kind"] == "turn" and e.get("phase") == "final" for e in events)
    return out


def main():
    root = DATA / "recordings" / "phone"
    names = sys.argv[1:] or sorted(p.name for p in root.iterdir() if (p / "meta.json").exists())
    asr = load_asr()
    report = {}
    for name in names:
        r = score(root / name, asr)
        report[name] = r
        m = r["meta"]
        mins = max(r["played_s"], 1) / 60
        print(f"\n=== {name}: echo path {m.get('path')}, {m.get('voice')} voice, {r['seconds']} s, Duck played {r['played_s']} s ===")
        if r["echo_dbfs"] is None:
            print("  Duck didn't play")
            continue
        print(f"  echo level {r['echo_dbfs']:.0f} dBFS while Duck plays (room {r['floor_dbfs'] or float('nan'):.0f} dBFS)")
        if r.get("echo_return_db") is not None:
            print(f"  echo return {r['echo_return_db']} dB, {r['lag_ms']} ms after the phone said it started; the desktop's AEC3 removes {r['erle_db']} dB")
        print(f"  {'chain':<14}{'false cuts':>11}{'per 10 min':>12}{'caught':>8}{'turns':>7}")
        for c, x in r["chains"].items():
            print(f"  {c:<14}{x['false']:>11}{x['false'] / mins * 10:>12.1f}{x['caught'] or '-':>8}{x['turns']:>7}")
        print(f"  in the app: {r['app']}")
        best = list(r["chains"])[-1]
        for x in r["chains"][best]["false_cuts"][:8]:
            print(f"    {best} false cut at {x['t']} s: {x.get('heard', '')!r}")
        for x in r["chains"][best]["kept_turns"][:8]:
            print(f"    {best} turn at {x['t']} s: {x['heard']!r}")
    out = DATA / "results" / "phone.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nsaved {out}")


if __name__ == "__main__":
    main()
