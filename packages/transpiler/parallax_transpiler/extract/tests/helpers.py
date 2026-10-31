"""Build a throwaway project on disk and extract it."""

import tempfile
import textwrap
from pathlib import Path

from parallax_transpiler.extract import extract_project

MAIN = '''
from parallax import Game
from project import Scenes

game = Game(id="t", title="T", sdk="1.0", mode="2d", start_scene=Scenes.main)
'''


def extract(files: dict[str, str], with_main: bool = True) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        all_files = {"game/__init__.py": "", **({"game/main.py": MAIN} if with_main else {}), **files}
        for path, text in all_files.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(textwrap.dedent(text), encoding="utf-8")
        return extract_project(root)


def codes(document: dict) -> list[str]:
    return [d["code"] for d in document["diagnostics"]]


def diagnostic(document: dict, code: str) -> dict:
    for d in document["diagnostics"]:
        if d["code"] == code:
            return d
    raise AssertionError(f"no {code} in {[(d['code'], d['message']) for d in document['diagnostics']]}")
