# /// script
# requires-python = ">=3.12"
# dependencies = ["sounddevice", "soundfile", "numpy", "scipy"]
# ///
"""X0 echo test: play Duck's voice (Kokoro + Silero clips) out loud while recording the mic.

    uv run record_echo.py                                   # laptop mic + laptop speakers
    uv run record_echo.py --speaker BlackShark --name headphones --minutes 4
    uv run record_echo.py --list                            # mics and speakers (WASAPI indexes)

Phase 1 (half the time): stay quiet; normal room noise is fine. It measures how much of
Duck's voice reaches the mic, and how often echo would be mistaken for you.
Phase 2: when the screen says INTERRUPT, talk over Duck for a second or two ("wait",
"stop", "hold on", "подожди", anything). It measures how fast a real interruption is caught.

The mic and speaker streams share one clock, so the recording and what was played line up
(the scorer refines the offset by cross-correlation). Everything is saved to
recordings/echo/<name>/ and scored offline by score_echo.py: raw mic, WebRTC AEC3, and
AEC3 + the barge-in gate.
"""
import argparse, json, random, sys, time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
from scipy.signal import resample_poly
from _paths import DATA

HERE = Path(__file__).resolve().parent
SR = 48000


def wasapi(d):
    return "WASAPI" in sd.query_hostapis(d["hostapi"])["name"]


def wasapi_devices(kind):
    return [(i, d["name"]) for i, d in enumerate(sd.query_devices()) if wasapi(d) and d[f"max_{kind}_channels"]]


def find(kind, sel, name_part):
    """`sel` is an index or part of a device name (indexes shift when Bluetooth reconnects)."""
    if sel is not None and sel.isdigit():
        return int(sel)
    name_part = sel or name_part
    for i, n in wasapi_devices(kind):
        if name_part in n:
            return i
    sys.exit(f"no {kind} device matching {name_part!r}; run with --list and pass an index")


def load_clips():
    replies = {r["id"]: r for r in json.loads((DATA / "tts" / "replies.json").read_text(encoding="utf-8"))}
    files = [(f, replies.get(f.stem, {}).get("text", "")) for f in sorted((DATA / "tts" / "kokoro+silero-translit").glob("*.wav"))]
    files += [(f, "") for f in sorted((DATA / "tts" / "silero-voices" / "kseniya").glob("*.wav"))]
    files += [(f, "") for f in sorted((DATA / "tts" / "numbers-en").glob("*.wav"))]
    out = []
    for f, text in files:
        a, sr = sf.read(str(f), dtype="float32")
        if a.ndim > 1:
            a = a.mean(axis=1)
        if sr != SR:
            g = np.gcd(sr, SR)
            a = resample_poly(a, SR // g, sr // g).astype("float32")
        a = a / (np.max(np.abs(a)) + 1e-9) * 0.7  # even loudness across engines
        out.append((f"{f.parent.name}/{f.name}", text, a))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--mic", help="index or part of the name; default: the laptop Microphone Array")
    ap.add_argument("--speaker", help="index or part of the name; default: the laptop speakers")
    ap.add_argument("--name", default="speakers")
    ap.add_argument("--minutes", type=float, default=6.0)
    ap.add_argument("--cues", type=int, default=10)
    args = ap.parse_args()

    if args.list:
        print("Mics:");     [print(f"  {i}  {n}") for i, n in wasapi_devices("input")]
        print("Speakers:"); [print(f"  {i}  {n}") for i, n in wasapi_devices("output")]
        return

    out_dir = DATA / "recordings" / "echo" / args.name
    out_dir.mkdir(parents=True, exist_ok=True)

    # The playlist: clips in random order with natural gaps, repeated to fill the time.
    clips = load_clips()
    rng = random.Random(7)
    total = int(args.minutes * 60 * SR)
    ref = np.zeros(total, "float32")
    schedule, pos, full = [], int(1.0 * SR), False
    while not full:
        order = clips[:]
        rng.shuffle(order)
        for name, text, a in order:
            if pos + len(a) >= total:
                full = True
                break
            ref[pos:pos + len(a)] = a
            schedule.append({"start": pos, "end": pos + len(a), "clip": name, "text": text})
            pos += len(a) + int(rng.uniform(0.4, 1.2) * SR)

    half = total // 2
    # Cues in phase 2, spread out, each inside a clip so it is a real talk-over.
    talking = [s for s in schedule if s["start"] > half + 3 * SR and s["end"] < total - 3 * SR and s["end"] - s["start"] > 2 * SR]
    step = max(1, len(talking) // args.cues)
    cues = [int(s["start"] + 0.4 * SR) for s in talking[::step][:args.cues]]

    mic = np.zeros(total + 2 * SR, "float32")
    st = {"out": 0, "in": 0, "t_out": None, "t_in": None, "status": []}

    def out_cb(outdata, frames, t, status):
        p = st["out"]
        if st["t_out"] is None:
            st["t_out"] = t.outputBufferDacTime
        n = max(0, min(frames, total - p))
        outdata[:] = 0
        for c in range(outdata.shape[1]):
            outdata[:n, c] = ref[p:p + n]
        if status:
            st["status"].append(f"out {status} @{p}")
        st["out"] = p + frames

    def in_cb(indata, frames, t, status):
        p = st["in"]
        if st["t_in"] is None:
            st["t_in"] = t.inputBufferAdcTime
        n = max(0, min(frames, len(mic) - p))
        mic[p:p + n] = indata[:n].mean(axis=1)  # an array mic opens with all its channels
        if status:
            st["status"].append(f"in {status} @{p}")
        st["in"] = p + frames

    mic_dev = find("input", args.mic, "Microphone Array")
    spk_dev = find("output", args.speaker, "Speakers (Realtek")
    mic_name = sd.query_devices(mic_dev)["name"]
    spk = sd.query_devices(spk_dev)
    print(f"\nMic:     {mic_name}\nSpeaker: {spk['name']}\nLength:  {args.minutes:g} min, {len(cues)} interruptions\n")

    mode = "exclusive mic"
    try:
        # Exclusive mode only accepts the device's native channel count (4 on the laptop array).
        istream = sd.InputStream(device=mic_dev, samplerate=SR, channels=sd.query_devices(mic_dev)["max_input_channels"],
                                 dtype="float32", callback=in_cb, extra_settings=sd.WasapiSettings(exclusive=True), latency="low")
    except Exception:
        print("The mic can't be opened in exclusive mode, another app may be using it;\n"
              "or it needs another format). Shared mode would include the Realtek driver's effects.")
        if input("Continue in shared mode anyway? [y/N] ").strip().lower() != "y":
            return
        istream = sd.InputStream(device=mic_dev, samplerate=SR, channels=1, dtype="float32", callback=in_cb,
                                 extra_settings=sd.WasapiSettings(auto_convert=True), latency="low")
        mode = "shared mic"
    ostream = sd.OutputStream(device=spk_dev, samplerate=SR, channels=min(2, spk["max_output_channels"]), dtype="float32",
                              callback=out_cb, extra_settings=sd.WasapiSettings(auto_convert=True), latency="low")
    input("Set the volume to where you'd normally listen to Duck, then press Enter to start. ")

    print("\nPhase 1: stay quiet and let Duck talk.\n")
    shown = set()
    with istream, ostream:
        while st["out"] < total + SR // 2:
            p = st["out"]
            if p >= half and "p2" not in shown:
                shown.add("p2")
                print("\n\nPhase 2: talk over Duck each time you see INTERRUPT.\n")
            for k, c in enumerate(cues):
                if c <= p < c + 2 * SR and k not in shown:
                    shown.add(k)
                    print(f"\n   >>>>>>  INTERRUPT NOW ({k + 1}/{len(cues)})  <<<<<<\n")
            sys.stdout.write(f"\r  {min(p, total) / SR:6.1f} / {total / SR:.0f} s ")
            sys.stdout.flush()
            time.sleep(0.05)
    print("\n")

    sf.write(str(out_dir / "mic.wav"), mic[:st["in"]], SR, subtype="PCM_16")
    sf.write(str(out_dir / "ref.wav"), ref, SR, subtype="PCM_16")
    # Mic sample k was captured at t_in + k/SR; ref sample j was played at t_out + j/SR (one clock).
    meta = {"mic": mic_name, "speaker": spk["name"], "mode": mode, "sr": SR, "half": half,
            "cues": cues, "schedule": schedule, "stream_status": st["status"][:50],
            "t_in": st["t_in"], "t_out": st["t_out"],
            "ref_offset_in_mic": round((st["t_out"] - st["t_in"]) * SR),
            "latency": {"in": istream.latency, "out": ostream.latency}}
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    peak = float(np.max(np.abs(mic)))
    print(f"Saved to {out_dir}  ({mode}, mic peak {peak:.2f}{', clipping' if peak > 0.99 else ''})")


if __name__ == "__main__":
    main()
