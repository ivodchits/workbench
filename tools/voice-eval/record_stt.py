# /// script
# requires-python = ">=3.12"
# dependencies = ["sounddevice", "soundfile", "numpy", "scipy"]
# ///
"""X0 STT recordings: 20 assistant commands (8 EN, 8 RU, 4 mixed RU+EN).

    uv run record_stt.py            # records into recordings/stt/
Speak naturally, at your normal distance from the laptop mic (or the mic you will use).
Re-running skips nothing automatically, but shows which items already exist; press s to skip them.
"""
from pathlib import Path
from _rec import run_session
from _paths import DATA

PROMPTS = [
    # English
    ("en01", "en", "What is the backend session doing right now?"),
    ("en02", "en", "Tell the game agent to run the tests and report back when they pass."),
    ("en03", "en", "Approve that, and then summarize the last hour for me."),
    ("en04", "en", "Pause the frontend session until I've reviewed the diff."),
    ("en05", "en", "Which sessions are waiting for my approval?"),
    ("en06", "en", "Read me the last response from the docs session, but skip the code."),
    ("en07", "en", "Remind me in twenty minutes to check the build on main."),
    ("en08", "en", "Start a new session in the Workbench repo and ask it to fix the flaky login test."),
    # Russian
    ("ru01", "ru", "Что сейчас делает вторая сессия?"),
    ("ru02", "ru", "Скажи агенту, чтобы запустил тесты и сообщил, когда они пройдут."),
    ("ru03", "ru", "Одобри это и коротко перескажи, что было за последний час."),
    ("ru04", "ru", "Останови третью сессию, я хочу сначала посмотреть изменения."),
    ("ru05", "ru", "Сколько сессий сейчас ждут моего подтверждения?"),
    ("ru06", "ru", "Прочитай мне последний ответ, только без кода."),
    ("ru07", "ru", "Напомни мне через двадцать минут проверить сборку."),
    ("ru08", "ru", "Перенеси созвон на четырнадцать тридцать и предупреди всех в общем чате."),
    # Mixed Russian + English terms
    ("mx01", "mixed", "Запусти npm test в backend-сессии и скажи, если что-то упадёт."),
    ("mx02", "mixed", "Открой pull request для Workbench и попроси ревью."),
    ("mx03", "mixed", "Что там с билдом на main? Последний commit прошёл CI?"),
    ("mx04", "mixed", "Скажи Claude Code во frontend-сессии сделать рефакторинг хука useSession и закоммитить."),
]

if __name__ == "__main__":
    items = [{"id": i, "lang": l, "text": t} for i, l, t in PROMPTS]
    out = DATA / "recordings" / "stt"
    run_session(items, out, "STT utterances (20)",
                "Read each line as you would say it to the assistant (paraphrasing slightly is fine,\n"
                "but then edit recordings/stt/prompts.json so the reference matches what you said).")
