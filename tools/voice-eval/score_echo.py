# /// script
# requires-python = ">=3.12"
# dependencies = ["livekit", "onnxruntime==1.31.0", "onnx-asr[hub]==0.12.0", "numpy", "soundfile", "scipy"]
# ///
"""Score recordings/echo/<name>/ from record_echo.py, offline, for each echo chain.

    uv run score_echo.py                 # every recording under recordings/echo/
    uv run score_echo.py speakers

Chains (all on the same recording):
  raw            the mic as is
  aec3           WebRTC AEC3 (livekit's AudioProcessingModule) fed the exact playback, + high-pass
  aec3+ns        the same, with WebRTC noise suppression
  aec3+gate      aec3, and a barge-in must also be louder than the residual echo expected from
                 the playback level (learned on the first 30 s), for >= 280 ms
  aec3+gate+self also drops a would-be barge-in whose words match what Duck was saying (Parakeet)

Metrics:
  ERLE           echo removed while Duck talks, phase 1 (dB; higher is better)
  false/10min    barge-ins detected while you were silent (phase 1), per 10 minutes
  caught         phase 2 interruptions detected within 5 s of the cue (reaction time included)
  delay          from your speech onset (VAD on the AEC output) to the barge-in firing
"""
import json, re, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly, fftconvolve
from _paths import DATA

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SR, FR = 48000, 480          # 10 ms frames for AEC3
VSR, VCH = 16000, 512        # Silero VAD: 32 ms frames at 16 kHz
MIN_SPEECH_S = 0.28
REFRACTORY_S = 1.5


def align(mic, ref, guess):
    """Return lag such that ref[j] is heard at mic[j + lag], searched near the clock guess."""
    n = min(len(ref), 60 * SR)
    lo, hi = max(0, guess - SR // 10), guess + SR // 2
    seg = mic[lo:lo + n + (hi - lo)]
    c = fftconvolve(seg, ref[:n][::-1], mode="valid")
    k = int(np.argmax(np.abs(c[: hi - lo])))
    return lo + k


def run_apm(mic, ref, ns):
    from livekit import rtc
    apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=ns, high_pass_filter=True, auto_gain_control=False)
    apm.set_stream_delay_ms(20)
    to16 = lambda a: (np.clip(a, -1, 1) * 32767).astype(np.int16)
    m16, r16 = to16(mic), to16(ref)
    out = np.zeros(len(mic), np.int16)
    for i in range(0, len(mic) - FR + 1, FR):
        rf = rtc.AudioFrame(data=r16[i:i + FR].tobytes(), sample_rate=SR, num_channels=1, samples_per_channel=FR)
        apm.process_reverse_stream(rf)
        mf = rtc.AudioFrame(data=m16[i:i + FR].tobytes(), sample_rate=SR, num_channels=1, samples_per_channel=FR)
        apm.process_stream(mf)
        out[i:i + FR] = np.frombuffer(bytes(mf.data), np.int16)
    return out.astype(np.float32) / 32767


def frame_energy(a, hop):
    n = len(a) // hop
    return (a[: n * hop].reshape(n, hop) ** 2).mean(axis=1)


def vad_probs(a48):
    from score_turns import Vad
    a = resample_poly(a48, 1, 3).astype(np.float32)
    v = Vad()
    return np.array([v(a[i:i + VCH]) for i in range(0, len(a) - VCH + 1, VCH)])


def detect(probs, allowed=None, need=MIN_SPEECH_S):
    """Barge-in onsets (s): VAD > 0.5 for `need` seconds in a row, on frames `allowed` permits."""
    fs = VCH / VSR
    need_n = int(np.ceil(need / fs))
    events, run, last = [], 0, -1e9
    for k, p in enumerate(probs):
        ok = p > 0.5 and (allowed is None or allowed[k])
        run = run + 1 if ok else 0
        t = (k + 1) * fs
        if run >= need_n and t - last > REFRACTORY_S:
            events.append(t)
            last = t
            run = 0
    return events


def words(s):
    return set(re.findall(r"\w+", s.lower().replace("ё", "е")))


def main():
    names = sys.argv[1:] or sorted(p.name for p in (DATA / "recordings" / "echo").iterdir() if (p / "meta.json").exists())
    asr = None
    report = {}
    for name in names:
        d = DATA / "recordings" / "echo" / name
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        mic, _ = sf.read(str(d / "mic.wav"), dtype="float32")
        ref, _ = sf.read(str(d / "ref.wav"), dtype="float32")
        lag = align(mic, ref, max(0, meta["ref_offset_in_mic"]))
        pre = int(0.02 * SR)  # keep the playback 20 ms ahead of its echo, as a live AEC sees it
        start = max(0, lag - pre)
        m = mic[start:start + len(ref)]
        if len(m) < len(ref):
            m = np.pad(m, (0, len(ref) - len(m)))
        half, total = meta["half"], len(ref)
        print(f"\n=== {name}: {meta['mic']} -> {meta['speaker']} ({meta['mode']}), "
              f"acoustic+buffer delay {(lag - meta['ref_offset_in_mic']) / SR * 1000:.0f} ms ===")

        chains = {"raw": m, "aec3": run_apm(m, ref, ns=False), "aec3+ns": run_apm(m, ref, ns=True)}

        # Where Duck is "talking": playback active now or in the last 300 ms (between words).
        fs = VCH / VSR
        hop = int(fs * SR)
        ref_e = frame_energy(ref, hop)
        nfr = len(ref_e)
        talking = np.convolve(ref_e > 1e-5, np.ones(int(0.3 / fs) + 1), mode="full")[:nfr] > 0
        p1 = np.arange(nfr) * fs < half / SR
        echo_only = talking & p1

        # ERLE over phase-1 frames with playback.
        e_mic = frame_energy(m, hop)[:nfr]
        res = {}
        for cname, sig in chains.items():
            e = frame_energy(sig, hop)[:nfr]
            erle = 10 * np.log10(e_mic[echo_only].sum() / max(e[echo_only].sum(), 1e-12))
            res[cname] = {"erle_db": round(float(erle), 1), "signal": sig, "energy": e}
        echo_dbfs = 10 * np.log10(e_mic[echo_only].mean() + 1e-12)

        # Gate: the residual expected from the playback level, learned on the first 30 s.
        e_aec = res["aec3"]["energy"]
        # Only frames with real playback teach the ratio; quiet ones would measure the noise
        # floor against nothing. The floor is learned separately from phase-1 silence.
        ref_s = np.convolve(ref_e, np.ones(7) / 7, mode="same")
        cal = echo_only & (np.arange(nfr) * fs < 30)
        cal &= ref_s > np.percentile(ref_s[cal], 50)
        ratio = np.percentile(e_aec[cal] / ref_s[cal], 90)
        floor = np.percentile(e_aec[p1 & ~talking], 90) if (p1 & ~talking).any() else 0.0
        expected = np.maximum(ratio * ref_s, floor)
        gate_ok = ~talking | (e_aec > 4.0 * expected)  # >= 6 dB over the expected residual

        cues = [c / SR for c in meta["cues"]]
        p1_minutes = (half / SR) / 60

        # A reaction to the on-screen cue takes 1-3 s (X0: 1.1-1.5 s, sometimes more), and
        # talking on past the refractory time fires again, so an interruption counts if it
        # fires within CATCH_S of its cue, and phase-2 events within TALK_S are the same one.
        CATCH_S, TALK_S = 5.0, 8.0

        def score(events, onset_probs):
            false1 = [t for t in events if t < half / SR]
            false2 = [t for t in events if t >= half / SR and not any(c <= t <= c + TALK_S for c in cues)]
            caught, delays = 0, []
            for c in cues:
                hit = [t for t in events if c <= t <= c + CATCH_S]
                if hit:
                    caught += 1
                    k0 = int(c / fs)
                    on = next((k for k in range(k0, min(len(onset_probs), k0 + int(CATCH_S / fs))) if onset_probs[k] > 0.5), None)
                    if on is not None:
                        delays.append(hit[0] - on * fs)
            return {"false_per_10min": round(len(false1) / p1_minutes * 10, 1), "false_p1": len(false1),
                    "false_p2": len(false2), "caught": f"{caught}/{len(cues)}",
                    "delay_ms": int(np.median(delays) * 1000) if delays else None, "false_times": [round(t, 1) for t in false1][:20]}

        probs = {c: vad_probs(res[c]["signal"]) for c in chains}
        for c in probs:
            probs[c] = probs[c][:nfr] if len(probs[c]) >= nfr else np.pad(probs[c], (0, nfr - len(probs[c])))
        out = {}
        for c in chains:
            out[c] = {"erle_db": res[c]["erle_db"], **score(detect(probs[c]), probs["aec3"])}
        gate_events = detect(probs["aec3"], allowed=gate_ok)
        out["aec3+gate"] = {"erle_db": res["aec3"]["erle_db"], **score(gate_events, probs["aec3"])}

        # Self-voice check on the gate's events: transcribe 1.5 s of the AEC output and of the
        # playback at the same moment; matching words mean it heard itself.
        if asr is None:
            import onnx_asr
            from huggingface_hub import snapshot_download
            path = snapshot_download("istupakov/parakeet-tdt-0.6b-v3-onnx", local_dir=str(DATA / "models" / "parakeet-tdt-0.6b-v3-onnx"))
            asr = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, quantization="int8", providers=["CPUExecutionProvider"])
        kept = []
        aec_sig = res["aec3"]["signal"]
        for t in gate_events:
            a, b = int(max(0, t - MIN_SPEECH_S - 0.2) * SR), int((t + 1.2) * SR)
            heard = words(asr.recognize(resample_poly(aec_sig[a:b], 1, 3).astype(np.float32)))
            said = words(asr.recognize(resample_poly(ref[max(0, a - SR // 2):b], 1, 3).astype(np.float32)))
            if heard and len(heard & said) / len(heard) >= 0.5:
                continue
            kept.append(t)
        out["aec3+gate+self"] = {"erle_db": res["aec3"]["erle_db"], **score(kept, probs["aec3"])}

        print(f"  echo level at the mic while Duck talks: {echo_dbfs:.0f} dBFS")
        print(f"  {'chain':<16}{'ERLE':>7}{'false/10min':>13}{'false (phase 2)':>17}{'caught':>9}{'delay':>9}")
        for c, r in out.items():
            dl = f"{r['delay_ms']} ms" if r["delay_ms"] is not None else "-"
            print(f"  {c:<16}{r['erle_db']:>6.1f} {r['false_per_10min']:>12} {r['false_p2']:>16} {r['caught']:>8} {dl:>8}")
        for c in ("aec3+gate", "aec3+gate+self"):
            if out[c]["false_times"]:
                print(f"  {c} false barge-ins at (s): {out[c]['false_times']}")
        for c in ("raw", "aec3", "aec3+ns"):
            sf.write(str(d / f"out_{c}.wav"), res[c]["signal"], SR, subtype="PCM_16")
        report[name] = {"meta": {k: meta[k] for k in ("mic", "speaker", "mode")}, "echo_dbfs": round(float(echo_dbfs), 1), "chains": out}
    (DATA / "results" / "echo.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nsaved {DATA / 'results' / 'echo.json'}")


if __name__ == "__main__":
    main()
