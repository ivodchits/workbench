"""Shared recording helper for record_stt.py / record_monologues.py (X0 spike, throwaway)."""
import json, sys, threading, time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

SR = 16000

# --mic N picks a WASAPI input by index (opened in exclusive mode, which skips Windows'
# effects); --list-mics prints them. Without it, the default input (MME) is used.
MIC = None
if "--list-mics" in sys.argv:
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] and "WASAPI" in sd.query_hostapis(d["hostapi"])["name"]:
            print(i, d["name"])
    sys.exit()
if "--mic" in sys.argv:
    MIC = int(sys.argv[sys.argv.index("--mic") + 1])


def device_info():
    d = sd.query_devices(MIC if MIC is not None else sd.default.device[0])
    if MIC is not None:
        return f"{d['name']} (WASAPI exclusive)"
    return f"{d['name']} ({sd.query_hostapis(d['hostapi'])['name']}, default {int(d['default_samplerate'])} Hz)"


def _resample(a: np.ndarray, sr_in: int) -> np.ndarray:
    if sr_in == SR:
        return a
    from scipy.signal import resample_poly
    g = np.gcd(sr_in, SR)
    return resample_poly(a, SR // g, sr_in // g).astype("float32")


def record_until_enter(show_timer=True, max_s=None) -> np.ndarray:
    """Record from the default mic until Enter is pressed. Returns 16 kHz mono float32."""
    dev = sd.query_devices(MIC if MIC is not None else sd.default.device[0])
    sr_in = int(dev["default_samplerate"])
    extra = sd.WasapiSettings(exclusive=True) if MIC is not None else None
    # Exclusive mode only accepts the device's native channel count (4 on the laptop array).
    ch = dev["max_input_channels"] if MIC is not None else 1
    chunks, stop = [], threading.Event()

    def cb(indata, frames, t, status):
        chunks.append(indata.mean(axis=1))

    def ticker():
        t0 = time.time()
        while not stop.is_set():
            el = time.time() - t0
            lvl = float(np.sqrt(np.mean(chunks[-1] ** 2))) if chunks else 0.0
            bar = "#" * min(30, int(lvl * 300))
            over = "  (over max length, wrap up)" if max_s and el > max_s else ""
            sys.stdout.write(f"\r  recording {el:5.1f}s  [{bar:<30}]  Enter = stop{over} ")
            sys.stdout.flush()
            time.sleep(0.1)

    with sd.InputStream(device=MIC, samplerate=sr_in, channels=ch, dtype="float32", callback=cb, extra_settings=extra):
        th = threading.Thread(target=ticker, daemon=True)
        if show_timer:
            th.start()
        input()
        stop.set()
    print()
    a = np.concatenate(chunks) if chunks else np.zeros(0, "float32")
    return _resample(a, sr_in)


def save(path: Path, a: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), a, SR, subtype="PCM_16")


def run_session(items, out_dir: Path, title: str, intro: str, max_s=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    pj = out_dir / "prompts.json"
    if pj.exists():  # keep references the user may have edited
        items = json.loads(pj.read_text(encoding="utf-8"))
    else:
        pj.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== {title} ===\nMic: {device_info()}\nSaving to: {out_dir}\n{intro}\n")
    i = 0
    while i < len(items):
        it = items[i]
        wav = out_dir / f"{it['id']}.wav"
        status = " (already recorded)" if wav.exists() else ""
        print(f"[{i+1}/{len(items)}] {it['id']} [{it['lang']}]{status}")
        print(f"  >> {it['text']}")
        if it.get("hint"):
            print(f"  (hint: {it['hint']})")
        cmd = input("  Enter = start, s = skip, b = back, q = quit: ").strip().lower()
        if cmd == "q":
            break
        if cmd == "s":
            i += 1
            continue
        if cmd == "b":
            i = max(0, i - 1)
            continue
        a = record_until_enter(max_s=max_s)
        dur = len(a) / SR
        peak = float(np.max(np.abs(a))) if len(a) else 0.0
        warn = "  WARNING: very quiet, check the mic" if peak < 0.02 else ("  WARNING: clipping" if peak > 0.99 else "")
        print(f"  got {dur:.1f}s, peak {peak:.2f}{warn}")
        takes = out_dir / "takes"; n = len(list(takes.glob(f"{it['id']}-*.wav"))) if takes.exists() else 0
        save(takes / f"{it['id']}-{n + 1}.wav", a)  # every take, for diagnosing bad ones
        nxt = input("  Enter = keep, r = redo, p = play back: ").strip().lower()
        while nxt == "p":
            sd.play(a, SR); sd.wait()
            nxt = input("  Enter = keep, r = redo, p = play back: ").strip().lower()
        if nxt == "r":
            continue
        save(wav, a)
        i += 1
    done = sum((out_dir / f"{it['id']}.wav").exists() for it in items)
    print(f"\nDone: {done}/{len(items)} recorded in {out_dir}")
