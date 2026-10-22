# /// script
# requires-python = ">=3.12"
# dependencies = ["onnxruntime==1.31.0", "onnx-asr[hub]==0.12.0", "numpy", "soundfile", "scipy"]
# ///
"""Turn X0's laptop-speaker echo recording into two phone recordings (step V7), as the app
saves them, for score_phone.py and the Rust test `barge_in_on_a_phone_recording`:

    uv run phone_from_x0.py     # recordings/phone/x0-speakers-synthetic-{quiet,interrupt}

The worst case for a phone: the mic as it heard the speakers, with no echo cancellation at
all. Each clip X0 played becomes a `said` event where it started playing (as the phone
reports it, before its echo), with its audio; phase 1 is the quiet run, phase 2 the
interruptions, its `cues` kept.
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from _paths import DATA


def main():
    src = DATA / "recordings" / "echo" / "speakers"
    meta = json.loads((src / "meta.json").read_text(encoding="utf-8"))
    nums = json.loads((DATA / "tts" / "numbers-en" / "texts.json").read_text(encoding="utf-8"))
    import onnx_asr
    from huggingface_hub import snapshot_download
    path = snapshot_download("istupakov/parakeet-tdt-0.6b-v3-onnx", local_dir=str(DATA / "models" / "parakeet-tdt-0.6b-v3-onnx"))
    asr = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, quantization="int8", providers=["CPUExecutionProvider"])
    mic, sr = sf.read(str(src / "mic.wav"), dtype="float32")
    assert sr == 48000
    if mic.ndim > 1:
        mic = mic.mean(axis=1)
    half, off = meta["half"], meta["ref_offset_in_mic"]

    def clip(name):
        for p in (DATA / "tts" / name, DATA / "tts" / "silero-voices" / name):
            if p.exists():
                return p
        return None

    for phase, (lo, hi) in (("quiet", (0, half)), ("interrupt", (half, len(mic)))):
        out = DATA / "recordings" / "phone" / f"x0-speakers-synthetic-{phase}"
        out.mkdir(parents=True, exist_ok=True)
        sf.write(str(out / "mic.wav"), resample_poly(mic[lo:hi], 1, 3).astype(np.float32), 16000, subtype="PCM_16")
        events, n = [], 0
        for s in meta["schedule"]:
            a, b = (s["start"] + off - lo) // 3, (s["end"] + off - lo) // 3
            p = clip(s["clip"])
            if a < 0 or b * 3 > hi - lo or p is None:
                continue
            w, r = sf.read(str(p), dtype="float32")
            if w.ndim > 1:
                w = w.mean(axis=1)
            text = s["text"]
            if not text and s["clip"].startswith("numbers-en"):
                text = nums[int(Path(s["clip"]).stem) - 1]
            elif not text:
                g = np.gcd(r, 16000)
                text = asr.recognize(resample_poly(w, 16000 // g, r // g).astype(np.float32))
            n += 1
            sf.write(str(out / f"said-{n}.wav"), w, r)
            events += [
                {"kind": "playing", "on": True, "at": a},
                {"kind": "said", "text": text, "voice": "desktop", "wav": f"said-{n}.wav", "at": a},
                {"kind": "playing", "on": False, "at": b},
            ]
        (out / "events.json").write_text(json.dumps(events, ensure_ascii=False, indent=1), encoding="utf-8")
        m = {"path": "X0's laptop speakers, no echo cancellation", "voice": "desktop", "seconds": (hi - lo) / sr}
        if phase == "interrupt":
            m["cues"] = [(c - lo) // 3 for c in meta["cues"]]
        (out / "meta.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
        print(f"{out}: {n} sentences")


if __name__ == "__main__":
    main()
