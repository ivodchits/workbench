"""Where the voice-eval data lives: recordings, TTS clips, downloaded models, results.

Your recordings are personal, so they stay out of this repo. Set VOICE_EVAL_DATA to move them.
"""
import os
from pathlib import Path

DATA = Path(os.environ.get("VOICE_EVAL_DATA") or Path.home() / "repos" / "Duck" / "voice-eval")
