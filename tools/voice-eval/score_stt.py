# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "onnx-asr[hub]==0.12.0", "onnxruntime-gpu[cuda,cudnn]==1.31.0",
#   "faster-whisper==1.2.1", "soundfile", "numpy", "jiwer",
# ]
# [tool.uv]
# # faster-whisper pulls the CPU onnxruntime, which would shadow onnxruntime-gpu: drop it.
# override-dependencies = ["onnxruntime; sys_platform == 'never'"]
# ///
"""Transcribe recordings/stt/*.wav with Parakeet TDT 0.6B v3 and Whisper large-v3-turbo; print side by side.

    uv run score_stt.py                 # GPU (CUDA) for both
    uv run score_stt.py --cpu           # CPU int8 for both (the battery fallback)
    uv run score_stt.py --dir recordings/stt --whisper-lang ru   # also force Whisper to Russian (helps mixed?)

Each engine runs in its own subprocess (their CUDA/cuDNN DLL sets differ).
"""
import argparse, json, os, re, subprocess, sys, time, unicodedata
from pathlib import Path
from _paths import DATA

HERE = Path(__file__).resolve().parent


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower().replace("ё", "е")
    s = re.sub(r"[^\w\s']", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def worker(engine: str, cpu: bool, files: list[str], lang: str | None):
    import soundfile as sf
    import numpy as np

    def load(f):
        a, sr = sf.read(f, dtype="float32")
        if a.ndim > 1:
            a = a.mean(axis=1)
        if sr != 16000:
            n = int(len(a) * 16000 / sr)
            a = np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a).astype("float32")
        return a

    t = time.perf_counter()
    if engine == "parakeet":
        import onnxruntime as ort, onnx_asr
        from huggingface_hub import snapshot_download
        path = snapshot_download("istupakov/parakeet-tdt-0.6b-v3-onnx", local_dir=str(DATA / "models" / "parakeet-tdt-0.6b-v3-onnx"))
        if cpu:
            m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, quantization="int8", providers=["CPUExecutionProvider"])
        else:
            ort.preload_dlls()
            m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        tr = lambda a: m.recognize(a)
    else:
        from faster_whisper import WhisperModel
        m = WhisperModel("large-v3-turbo", device="cpu" if cpu else "cuda", compute_type="int8" if cpu else "float16")
        def tr(a):
            segs, _ = m.transcribe(a, language=lang, beam_size=1, vad_filter=False, condition_on_previous_text=False)
            return " ".join(s.text.strip() for s in segs)
    load_s = time.perf_counter() - t
    tr(load(files[0]))  # warm-up
    out = {}
    for f in files:
        a = load(f)
        t = time.perf_counter()
        txt = tr(a)
        out[f] = {"text": txt, "s": time.perf_counter() - t, "dur": len(a) / 16000}
    print("@@JSON@@" + json.dumps({"load_s": load_s, "items": out}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(DATA / "recordings" / "stt"))
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--whisper-lang", default=None, help="also run Whisper with this forced language (e.g. ru)")
    ap.add_argument("--worker", default=None)
    ap.add_argument("--lang", default=None)
    ap.add_argument("files", nargs="*")
    a = ap.parse_args()
    if a.worker:
        return worker(a.worker, a.cpu, a.files, a.lang)

    import jiwer
    d = Path(a.dir)
    prompts = json.loads((d / "prompts.json").read_text(encoding="utf-8"))
    items = [p for p in prompts if (d / f"{p['id']}.wav").exists()]
    if not items:
        sys.exit(f"no recordings in {d}; run: uv run record_stt.py")
    files = [str(d / f"{p['id']}.wav") for p in items]
    engines = [("parakeet", None), ("whisper", None)] + ([("whisper", a.whisper_lang)] if a.whisper_lang else [])
    results = {}
    for eng, lang in engines:
        name = eng + (f"[{lang}]" if lang else "")
        print(f"running {name} ({'CPU int8' if a.cpu else 'CUDA'}) on {len(files)} files ...", flush=True)
        cmd = [sys.executable, __file__, "--worker", eng] + (["--cpu"] if a.cpu else []) + (["--lang", lang] if lang else []) + files
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"})
        line = next((l for l in p.stdout.splitlines() if l.startswith("@@JSON@@")), None)
        if not line:
            print(p.stdout[-2000:], p.stderr[-3000:]); sys.exit(f"{name} failed")
        results[name] = json.loads(line[8:])
        print(f"  load {results[name]['load_s']:.1f}s")

    names = list(results)
    agg = {n: {} for n in names}
    report = []
    for p, f in zip(items, files):
        ref = p["text"]
        print(f"\n[{p['id']} {p['lang']}] REF: {ref}")
        row = {"id": p["id"], "lang": p["lang"], "ref": ref}
        for n in names:
            r = results[n]["items"][f]
            m = jiwer.process_words(norm(ref), norm(r["text"]) or "<empty>")
            e, N = m.substitutions + m.deletions + m.insertions, m.substitutions + m.deletions + m.hits
            g = agg[n].setdefault(p["lang"], [0, 0, 0.0, 0.0]); g[0] += e; g[1] += N; g[2] += r["s"]; g[3] += r["dur"]
            print(f"  {n:<13} {e/N:5.0%} {r['s']*1000:5.0f}ms | {r['text']}")
            row[n] = {"text": r["text"], "wer": round(e / N, 3), "ms": round(r["s"] * 1000)}
        report.append(row)
    print("\n=== WER by group (word errors / ref words)  and RTF ===")
    langs = sorted({p["lang"] for p in items})
    print(f"{'engine':<14}" + "".join(f"{l:>10}" for l in langs) + f"{'all':>10}{'RTF':>8}")
    for n in names:
        tot = [sum(v[i] for v in agg[n].values()) for i in range(4)]
        print(f"{n:<14}" + "".join(f"{agg[n][l][0]/agg[n][l][1]:>10.1%}" for l in langs) + f"{tot[0]/tot[1]:>10.1%}{tot[2]/tot[3]:>8.3f}")
    out = d / f"score_{'cpu' if a.cpu else 'gpu'}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nsaved {out}\nNote: WER here ignores case/punctuation; eyeball the lines for misheard project names.")


if __name__ == "__main__":
    main()
