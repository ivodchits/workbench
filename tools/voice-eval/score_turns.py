# /// script
# requires-python = ">=3.12"
# dependencies = ["onnxruntime==1.24.2", "numpy", "soundfile", "scipy", "transformers==4.57.3", "psutil"]
# ///
"""X0 end-of-turn test: Silero VAD + Smart Turn v3.2 (ONNX, CPU, 1 thread) over monologue recordings.

    uv run score_turns.py                          # all recordings/monologues/*.wav
    uv run score_turns.py some.wav other.wav       # specific files
    uv run score_turns.py --realtime long.wav      # stream in real time, measure CPU while listening
    uv run score_turns.py --model int8             # X0's int8 model (default: fp32, what the app runs)

V4 (2026-10-21): the app runs the fp32 model (`smart-turn-v3.2-gpu.onnx`) on the CPU, on ONNX
Runtime 1.24.2, the version it ships. The int8 model's probabilities move with the runtime's
version and graph optimizations (0.27 / 0.57 / 0.68 for the same pause); fp32's agree to 1e-5.

Each monologue has exactly ONE real end of turn (the end of the file). Every end-of-turn the
detector fires earlier is a false one (it would have cut you off). We report, per policy:
  false_eot          false end-of-turns (would interrupt you)
  merged_by_grace    of those, how many you resumed within 2 s (the plan's grace window cancels them)
  final_latency_s    how long after your last word the real end was detected
Optional labels file <wav>.labels.json: {"pauses": [{"t": seconds, "kind": "mid"|"sentence"}]} adds per-pause detail.
"""
import argparse, json, os, sys, time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from _paths import DATA

HERE = Path(__file__).resolve().parent
MODELS = DATA / "models" / "turn"
SR, CHUNK = 16000, 512  # Silero: 32 ms frames
URLS = {
    "silero_vad.onnx": "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    "smart-turn-v3.2-cpu.onnx": "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx",
    "smart-turn-v3.2-gpu.onnx": "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-gpu.onnx",
}
TURN_MODELS = {"int8": "smart-turn-v3.2-cpu.onnx", "fp32": "smart-turn-v3.2-gpu.onnx"}

# Policies. checks = silence lengths (s) at which Smart Turn is asked; ends the turn at the first check with
# P(complete) >= thr, else at `ceiling` seconds of silence.
POLICIES = {
    "pipecat-default": {"checks": [0.2], "thr": 0.5, "ceiling": 3.0},
    "assistant(plan)": {"checks": [0.25], "thr": 0.5, "ceiling": 1.5},
    "chat(plan)": {"checks": [0.25, 1.0], "thr": 0.5, "ceiling": 3.0},
    "patient(duck)": {"checks": [1.5, 3.0, 5.0], "thr": 0.7, "ceiling": 8.0},
    "duck-strict": {"checks": [3.0, 5.0], "thr": 0.8, "ceiling": 8.0},
}


def ensure(name):
    p = MODELS / name
    if not p.exists():
        import urllib.request
        MODELS.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name} ...")
        urllib.request.urlretrieve(URLS[name], p)
    return str(p)


def session(path):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])


class Vad:
    def __init__(self):
        self.s = session(ensure("silero_vad.onnx"))
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), np.float32)
        self.ctx = np.zeros((1, 64), np.float32)

    def __call__(self, chunk):
        x = np.concatenate([self.ctx, chunk.reshape(1, -1)], axis=1).astype(np.float32)
        out, self.state = self.s.run(None, {"input": x, "state": self.state, "sr": np.array(SR, np.int64)})
        self.ctx = x[:, -64:]
        return float(out[0][0])


class SmartTurn:
    def __init__(self, model="fp32"):
        from transformers import WhisperFeatureExtractor
        self.fe = WhisperFeatureExtractor(chunk_length=8)
        self.s = session(ensure(TURN_MODELS[model]))

    def __call__(self, audio):
        n = 8 * SR
        audio = audio[-n:] if len(audio) > n else np.pad(audio, (n - len(audio), 0))
        f = self.fe(audio, sampling_rate=SR, return_tensors="np", padding="max_length", max_length=n,
                    truncation=True, do_normalize=True).input_features.astype(np.float32)
        return float(self.s.run(None, {"input_features": f})[0][0].item())


def load(path):
    a, sr = sf.read(str(path), dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != SR:
        from scipy.signal import resample_poly
        g = np.gcd(sr, SR)
        a = resample_poly(a, SR // g, sr // g).astype(np.float32)
    return a


def vad_probs(vad, a):
    vad.reset()
    n = len(a) // CHUNK
    return np.array([vad(a[i * CHUNK:(i + 1) * CHUNK]) for i in range(n)])


def speech_mask(p, on=0.5, off=0.35, min_speech_frames=3):
    """Hysteresis + ignore blips shorter than ~100 ms."""
    m, cur = np.zeros(len(p), bool), False
    for i, v in enumerate(p):
        cur = v >= on if not cur else v >= off
        m[i] = cur
    # drop short speech blips
    i = 0
    while i < len(m):
        if m[i]:
            j = i
            while j < len(m) and m[j]:
                j += 1
            if j - i < min_speech_frames:
                m[i:j] = False
            i = j
        else:
            i += 1
    return m


def simulate(a, mask, st, policy, cache):
    """Walk frames; return list of end-of-turn events (time_s, reason, prob)."""
    fs = CHUNK / SR
    events, in_turn, turn_start, sil, checks_done = [], False, 0, 0, set()
    for i, sp in enumerate(mask):
        t = (i + 1) * fs
        if sp:
            if not in_turn:
                in_turn, turn_start = True, i * CHUNK
            sil, checks_done = 0, set()
            continue
        if not in_turn:
            continue
        sil += fs
        for c in policy["checks"]:
            if c not in checks_done and sil >= c:
                checks_done.add(c)
                end = (i + 1) * CHUNK
                key = (turn_start, end)
                if key not in cache:
                    cache[key] = st(a[max(turn_start, end - 8 * SR):end])
                p = cache[key]
                if p >= policy["thr"]:
                    events.append((t, f"smart-turn@{c}s", p)); in_turn = False
                    break
        if in_turn and sil >= policy["ceiling"]:
            events.append((t, f"ceiling@{policy['ceiling']}s", None)); in_turn = False
    if in_turn:  # file ended before any decision: treat end of file + remaining ceiling as the decision
        events.append((len(mask) * fs + max(0, policy["ceiling"] - sil), "eof", None))
    return events


def pause_table(a, mask, st):
    """Every pause >= 200 ms: start, length, P(complete) at 200 ms into it (what pipecat asks)."""
    fs = CHUNK / SR
    rows, i, turn_start = [], 0, None
    while i < len(mask):
        if mask[i]:
            if turn_start is None:
                turn_start = i * CHUNK
            i += 1
            continue
        j = i
        while j < len(mask) and not mask[j]:
            j += 1
        if turn_start is not None and (j - i) * fs >= 0.2:
            end = int(i * CHUNK + 0.2 * SR)
            rows.append({"t": round(i * fs, 2), "len": round((j - i) * fs, 2),
                         "p200ms": round(st(a[max(0, end - 8 * SR):end]), 3), "final": j >= len(mask)})
        i = j
    return rows


def score_file(path, vad, st):
    a = load(path)
    p = vad_probs(vad, a)
    mask = speech_mask(p)
    fs = CHUNK / SR
    idx = np.nonzero(mask)[0]
    if not len(idx):
        return {"file": Path(path).name, "error": "no speech"}
    last_speech = (idx[-1] + 1) * fs
    speech_starts = [(k) * fs for k in range(1, len(mask)) if mask[k] and not mask[k - 1]]
    out = {"file": Path(path).name, "dur": round(len(a) / SR, 1), "last_speech_s": round(last_speech, 2), "policies": {}}
    cache = {}
    for name, pol in POLICIES.items():
        ev = simulate(a, mask, st, pol, cache)
        false = [e for e in ev if e[0] < last_speech]
        merged = sum(1 for e in false if any(0 <= s - e[0] <= 2.0 for s in speech_starts))
        final = [e for e in ev if e[0] >= last_speech]
        out["policies"][name] = {
            "false_eot": len(false), "merged_by_grace": merged,
            "final_latency_s": round(final[0][0] - last_speech, 2) if final else None,
            "final_reason": final[0][1] if final else None,
            "false_at": [(round(e[0], 1), e[1], None if e[2] is None else round(e[2], 2)) for e in false],
        }
    out["pauses"] = pause_table(a, mask, st)
    lab = Path(str(path) + ".labels.json")
    if not lab.exists():
        lab = Path(path).with_suffix(".labels.json")
    if lab.exists():
        L = json.loads(lab.read_text(encoding="utf-8"))
        for pz in out["pauses"]:
            near = [l for l in L["pauses"] if abs(l["t"] - pz["t"]) < 0.6]
            pz["kind"] = near[0]["kind"] if near else ("final" if pz["final"] else "natural")
    return out


def realtime(path, vad, st, speed=1.0):
    """Stream the file in 32 ms chunks paced at real time; VAD every chunk, Smart Turn at each 200 ms pause."""
    import psutil
    a = load(path)
    proc = psutil.Process()
    vad.reset()
    fs = CHUNK / SR
    n = len(a) // CHUNK
    buf, in_turn, sil, asked = [], False, 0.0, False
    vad_ms, st_ms = [], []
    on = False
    c0, w0 = proc.cpu_times(), time.perf_counter()
    for i in range(n):
        target = w0 + i * fs / speed
        d = target - time.perf_counter()
        if d > 0:
            time.sleep(d)
        ch = a[i * CHUNK:(i + 1) * CHUNK]
        t = time.perf_counter(); pv = vad(ch); vad_ms.append((time.perf_counter() - t) * 1000)
        on = pv >= 0.5 if not on else pv >= 0.35
        if on:
            if not in_turn:
                in_turn, buf = True, []
            sil, asked = 0.0, False
        if in_turn:
            buf.append(ch)
            if not on:
                sil += fs
                if sil >= 0.2 and not asked:
                    asked = True
                    t = time.perf_counter(); pr = st(np.concatenate(buf[-250:])); st_ms.append((time.perf_counter() - t) * 1000)
                    if pr >= 0.5 or sil >= 3.0:
                        in_turn = False
            if len(buf) > 300:
                buf = buf[-250:]
    wall = time.perf_counter() - w0
    c1 = proc.cpu_times()
    cpu = (c1.user - c0.user) + (c1.system - c0.system)
    return {"file": Path(path).name, "audio_s": round(len(a) / SR, 1), "wall_s": round(wall, 1), "speed": speed,
            "cpu_s": round(cpu, 2), "cpu_pct_of_one_core": round(100 * cpu / wall, 2),
            "vad_ms_median": round(float(np.median(vad_ms)), 3), "vad_ms_p99": round(float(np.percentile(vad_ms, 99)), 3),
            "st_calls": len(st_ms), "st_ms_median": round(float(np.median(st_ms)), 1) if st_ms else None,
            "st_ms_max": round(float(np.max(st_ms)), 1) if st_ms else None,
            "rss_mib": proc.memory_info().rss // 2**20}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--realtime", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--model", choices=sorted(TURN_MODELS), default="fp32")
    a = ap.parse_args()
    files = a.files or sorted(str(p) for p in (DATA / "recordings" / "monologues").glob("*.wav"))
    if not files:
        sys.exit("no monologues found; run: uv run record_monologues.py")
    vad, st = Vad(), SmartTurn(a.model)
    st(np.zeros(SR, np.float32))  # warm-up
    if a.realtime:
        for f in files:
            r = realtime(f, vad, st, a.speed)
            print(json.dumps(r))
        return
    results = []
    for f in files:
        r = score_file(f, vad, st)
        results.append(r)
        print(f"\n== {r['file']}  {r.get('dur')}s  (last word at {r.get('last_speech_s')}s)")
        if "error" in r:
            print("  ", r["error"]); continue
        for name, v in r["policies"].items():
            print(f"  {name:<17} false EOT {v['false_eot']:>2} (grace-merged {v['merged_by_grace']})  "
                  f"final after {v['final_latency_s']}s via {v['final_reason']}  {v['false_at'][:6]}")
        lows = [p for p in r["pauses"] if not p["final"]]
        print(f"   pauses>=200ms: {len(lows)} mid-turn; P(complete) at 200 ms into each: "
              + ", ".join(f"{p['t']:.0f}s/{p['len']:.1f}s:{p['p200ms']:.2f}{'['+p['kind']+']' if 'kind' in p else ''}" for p in lows[:25]))
    print("\n=== totals over", len([r for r in results if 'policies' in r]), "files ===")
    for name in POLICIES:
        rs = [r["policies"][name] for r in results if "policies" in r]
        lat = [x["final_latency_s"] for x in rs if x["final_latency_s"] is not None]
        print(f"  {name:<17} false EOT {sum(x['false_eot'] for x in rs):>3}  grace-merged {sum(x['merged_by_grace'] for x in rs):>3}  "
              f"median final latency {np.median(lat) if lat else float('nan'):.2f}s")
    out = Path(a.out) if a.out else DATA / "results" / "turns.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved", out)


if __name__ == "__main__":
    main()
