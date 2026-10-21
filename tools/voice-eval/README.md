# voice-eval

The X0 voice spike's test kit (see `documentation/assistant-plan.md`, step X0 → As built).
V1 and V4 use it as their regression set: re-run the scorers after changing the STT engine,
the turn policies or the echo chain, and compare against the X0 numbers.

Each script is a self-contained [uv](https://docs.astral.sh/uv/) script. Run them from this
folder in PowerShell:

| Script | What it does |
|---|---|
| `uv run record_stt.py` | Record the 20 STT utterances (8 EN, 8 RU, 4 mixed). `--list-mics`, `--mic N` (exclusive mode) |
| `uv run score_stt.py` | Parakeet v3 vs Whisper turbo on them. `--cpu` for the int8 CPU path |
| `uv run record_monologues.py` | Record the 10 thinking-aloud monologues |
| `uv run score_turns.py` | Silero VAD + Smart Turn under each end-of-turn policy (fp32 on ONNX Runtime 1.24.2, as the app runs it since V4; `--model int8` for X0's) |
| `uv run record_echo.py` | Play Duck's voice while recording the mic; quiet phase, then 10 interruptions. `--speaker BlackShark --name headphones` |
| `uv run score_echo.py` | Raw mic vs AEC3 vs AEC3 + barge-in gate + self-voice check |

## Data

Recordings are your voice, so they stay out of this repo. Everything the scripts read and
write lives in `~/repos/Duck/voice-eval` (override with `VOICE_EVAL_DATA`):

- `recordings/{stt,monologues,echo/<name>}`: the X0 recordings, and new ones.
- `tts/`: the Kokoro + Silero clips the echo test plays.
- `models/`: Parakeet and the turn models, downloaded on first use.
- `results/`: the scorers' output.

The folder has its own `.gitignore` (`*`), so it never enters Duck's data repo either.

## Notes from X0

- Device numbers change when a Bluetooth device reconnects; `--speaker` and `--mic` also take
  part of the name.
- The laptop mic array opens in exclusive mode only with all 4 of its channels; the
  recorders mix them down.
- The int8 Parakeet model can return empty text on clips with ~1 s of leading silence;
  trimmed clips are fine.
