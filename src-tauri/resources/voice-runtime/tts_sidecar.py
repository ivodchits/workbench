"""Duck's speech sidecar (step V2): Kokoro for English, Silero for Russian, on the CPU.

Workbench runs this with the `.venv` that `uv sync` built in `<app local
data>/voice-runtime/`, and talks to it over stdin/stdout:

- **Request**, one JSON line on stdin:
  `{"id": 7, "engine": "kokoro"|"silero", "text": "...", "voice": "af_heart", "speed": 1.0}`
  or `{"id": 0, "op": "ping"}`, or `{"id": 0, "op": "warm", "ru": false}` (load Kokoro
  now, and Silero with `ru`).
- **Reply** on stdout: one JSON line, `{"id": 7, "rate": 24000, "samples": N}`, then
  N little-endian int16 samples (mono); or `{"id": 7, "error": "..."}` with nothing after.

Silero is loaded only when the first Russian sentence arrives. Nothing here decides when
to quit: Workbench kills the process after it has been idle.
"""

import json
import os
import sys
import time

import numpy as np

RATE = 24_000
MODELS = os.environ.get("WB_TTS_MODELS", os.path.join(os.path.dirname(__file__), "models"))

_kokoro = None
_silero = None


def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro(os.path.join(MODELS, "kokoro-v1.0.int8.onnx"), os.path.join(MODELS, "voices-v1.0.bin"))
    return _kokoro


def silero():
    global _silero
    if _silero is None:
        import torch

        torch.set_num_threads(4)
        importer = torch.package.PackageImporter(os.path.join(MODELS, "v5_6_ru.pt"))
        model = importer.load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        _silero = model
    return _silero


def synth(req):
    text = req["text"]
    speed = float(req.get("speed") or 1.0)
    if req["engine"] == "silero":
        audio = silero().apply_tts(
            text=text,
            speaker=req.get("voice") or "kseniya",
            sample_rate=RATE,
            put_accent=True,
            put_yo=True,
            put_stress_homo=True,
        )
        samples = audio.numpy()
        if abs(speed - 1.0) > 0.01:
            samples = stretch(samples, speed)
        return samples
    samples, rate = kokoro().create(text, voice=req.get("voice") or "af_heart", speed=speed, lang="en-us")
    if rate != RATE:
        raise RuntimeError(f"kokoro gave {rate} Hz")
    return samples


def stretch(samples, speed):
    """Silero has no speed knob: resample, which shifts pitch a little; fine within ±15%."""
    n = max(1, int(len(samples) / speed))
    return np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples)


def send(header, pcm=b""):
    out = sys.stdout.buffer
    out.write((json.dumps(header) + "\n").encode())
    if pcm:
        out.write(pcm)
    out.flush()


def main():
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            if req.get("op") == "ping":
                send({"id": req.get("id", 0), "ok": True})
                continue
            if req.get("op") == "warm":
                # Load Kokoro and run it once (the first call is slow), while the
                # user is still speaking.
                kokoro().create("Hi.", voice="af_heart", speed=1.0, lang="en-us")
                if req.get("ru"):  # ~10-20 s cold: started as soon as Russian is heard
                    silero().apply_tts(text="Да.", speaker="kseniya", sample_rate=RATE)
                send({"id": req.get("id", 0), "ok": True})
                continue
            t = time.perf_counter()
            samples = np.clip(np.asarray(synth(req), dtype=np.float32), -1.0, 1.0)
            pcm = (samples * 32767).astype("<i2").tobytes()
            send({"id": req["id"], "rate": RATE, "samples": len(samples), "ms": int((time.perf_counter() - t) * 1000)}, pcm)
        except Exception as e:  # one bad sentence never ends the process
            send({"id": req.get("id", 0), "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
