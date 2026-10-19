# /// script
# requires-python = ">=3.12"
# dependencies = ["sounddevice", "soundfile", "numpy", "scipy"]
# ///
"""X0 end-of-turn test: 10 "thinking aloud" monologues, 30-90 s each (RU / EN / mixed).

    uv run record_monologues.py     # records into recordings/monologues/

IMPORTANT: this tests whether the assistant cuts you off mid-thought. So, in every monologue:
  * pause deliberately 2-4 times MID-THOUGHT for 2-6 seconds (e.g. after "and so..." / "и вот..." /
    "the problem is..." / "потому что..."), like when you are actually thinking;
  * at least once, pause after a complete-sounding sentence but keep going afterwards;
  * finish with a clear ending (a concluding sentence), then stay silent ~2 s and press Enter.
The only real end of turn is the end of each file; every earlier "end of turn" the detector fires is a false one.
"""
from pathlib import Path
from _rec import run_session
from _paths import DATA

PROMPTS = [
    ("mo01", "en", "Think aloud about how you'd structure the assistant's tool permissions: what should it do on its own, what should it ask first.",
     "~45 s, pause mid-sentence twice"),
    ("mo02", "ru", "Порассуждай вслух, почему у тебя падает какой-нибудь тест, который падает только иногда, и как бы ты это искал.",
     "~60 s, 3 паузы посреди мысли"),
    ("mo03", "mixed", "Расскажи, что ты сегодня хочешь сделать в Workbench: какие сессии запустить, что в backend, что во frontend, когда открыть pull request.",
     "~60 s, паузы после 'и потом...' / 'а ещё...'"),
    ("mo04", "en", "Explain a bug you fixed recently to a rubber duck: what you saw, what you suspected, what it actually was.",
     "~75 s, one long 5-6 s pause in the middle"),
    ("mo05", "ru", "Подумай вслух, как бы ты организовал свой день, если бы ассистент мог следить за агентами вместо тебя.",
     "~45 s, пауза после законченного предложения, потом продолжи"),
    ("mo06", "mixed", "Опиши, как ты хочешь, чтобы работал code review: кто смотрит diff, когда запускать npm test, что делать, если CI красный.",
     "~60 s, 3 паузы"),
    ("mo07", "en", "Compare two ways to do something you're deciding on right now (a library, an architecture, a purchase), thinking as you go.",
     "~90 s, hesitations: 'so...', 'hmm, the thing is...'"),
    ("mo08", "ru", "Расскажи, как прошла неделя, с паузами, как будто вспоминаешь.",
     "~40 s, паузы посреди фразы"),
    ("mo09", "mixed", "Продиктуй план для агента: сначала рефакторинг в backend, потом тесты, потом обновить README, и объясни почему в таком порядке.",
     "~75 s, паузы после 'потому что...'"),
    ("mo10", "en", "Think aloud about what the voice assistant should say when a session fails while you're away from the PC.",
     "~30 s, one pause mid-thought, then a clear ending"),
]

if __name__ == "__main__":
    items = [{"id": i, "lang": l, "text": t, "hint": h} for i, l, t, h in PROMPTS]
    out = DATA / "recordings" / "monologues"
    run_session(items, out, "Thinking-aloud monologues (10)", __doc__.split("IMPORTANT:")[1].strip(), max_s=95)
