from parallax import Entity, Shape
from parallax.test import GameHarness, playtest
from project import Scenes

from game.actions import Controls
from game.components import Word
from game.config import Rules
from game.events import KeyMissed, WordCleared
from game.resources import Records, Run
from game.rules import accuracy
from game.ui import Hud, PauseMenu, ResultsPanel, TitleScreen


async def first_word(h: GameHarness) -> tuple[Entity, Word]:
    await h.advance_until(lambda: h.world.query(Word).count() > 0)
    return h.world.query(Word).first()


@playtest("typing a falling word purges it and scores")
async def purge_a_word(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, word = await first_word(h)
    await h.type_text(word.text)
    await h.advance(frames=1)

    assert len(h.emitted(WordCleared)) == 1
    assert not entity.alive
    run = h.get(Run)
    assert run.cleared == 1 and run.combo == 1 and run.score > 0
    assert accuracy(run) == 1.0


@playtest("a wrong letter costs accuracy but not the word")
async def wrong_letter(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, word = await first_word(h)
    wrong = next(ch for ch in "qxzjv" if ch != word.text[1])
    await h.type_text(word.text[0] + wrong)
    await h.advance(frames=1)

    assert len(h.emitted(KeyMissed)) == 1
    assert entity.alive and word.typed == 1
    assert h.get(Run).keys_total == 2 and h.get(Run).keys_correct == 1


@playtest("letting every word through ends the run after the last life")
async def firewall_falls(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    await h.advance_until(lambda: h.is_open(ResultsPanel), timeout=120)
    assert h.get(Run).breached == h.config(Rules).lives
    assert h.world.query(Word).count() == 0


@playtest("Menu from the results leads to a clean title screen")
async def back_to_title(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    h.get(Run).breached = h.config(Rules).lives
    await h.advance(frames=1)
    await h.click(ResultsPanel, "quit")
    await h.advance(frames=2)
    assert not h.is_open(ResultsPanel)

    await h.press(Controls.pause)
    assert not h.is_open(PauseMenu)


@playtest("title → Start → a run ends → Jack In Again starts a fresh run; records kept")
async def core_loop(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=4)
    await h.click(TitleScreen, "play")
    await h.advance(frames=2)
    assert h.is_open(Hud)
    entity, word = await first_word(h)
    await h.type_text(word.text)
    await h.advance_until(lambda: h.is_open(ResultsPanel), timeout=120)
    results = h.panel_state(ResultsPanel)
    assert results["cleared"] == 1
    assert results["new_best"]
    assert results["accuracy"] == "100.0"
    best = h.get(Records).best_score
    assert best == h.get(Run).score > 0

    await h.click(ResultsPanel, "retry")
    await h.advance(frames=2)
    assert not h.is_open(ResultsPanel)
    assert h.get(Run).score == 0 and h.get(Run).breached == 0
    assert h.get(Records).best_score == best


@playtest("the 0 key pauses and freezes the falling words")
async def pause_freezes(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, _ = await first_word(h)
    await h.press(Controls.pause)
    assert h.is_open(PauseMenu)
    z = entity.transform.position.z
    await h.advance(seconds=1)
    assert entity.transform.position.z == z
    await h.press(Controls.pause)
    await h.advance(seconds=0.5)
    assert entity.transform.position.z > z


@playtest("every kind of packet takes its template size, and the HUD shows the threat ramp")
async def kinds_and_threat(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, word = await first_word(h)
    assert entity.get(Shape).size == word.kind.data.size
    hud = h.panel_state(Hud)
    assert hud["max_lives"] == 4 and hud["lives"] == 4
    assert 0 <= hud["threat"] < 0.05
    assert not hud["show_combo"]


@playtest("the HUD draws each falling word as a chip; the first letter locks it, a wrong one shakes it")
async def word_chips(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, word = await first_word(h)
    chip = h.panel_state(Hud)["words"][0]
    assert chip["text"] == word.text and not chip["target"]
    assert chip["x"].endswith("%") and chip["y"].endswith("%")

    wrong = next(ch for ch in "qxzjv" if ch != word.text[1])
    await h.type_text(word.text[0] + wrong)
    await h.advance(frames=1)
    chip = h.panel_state(Hud)["words"][0]
    assert chip["target"] and chip["error"]
    assert (chip["done"], chip["next"], chip["rest"]) == (word.text[0], word.text[1], word.text[2:])

    await h.type_text(word.text[1:])
    await h.advance(frames=1)
    hud = h.panel_state(Hud)
    assert hud["words"] == [] or all(not w["target"] for w in hud["words"])
    assert len(hud["pops"]) == 1 and hud["pops"][0]["on"]
    assert hud["pops"][0]["points"] == f"+{h.get(Run).score:,}"


@playtest("the HUD keyboard (touch) types like the keyboard and lights the next letter")
async def touch_keyboard(h: GameHarness) -> None:
    await h.start(scene=Scenes.grid, seed=4)
    entity, word = await first_word(h)
    keys = {k["key"]: k for row in ("keys_1", "keys_2", "keys_3") for k in h.panel_state(Hud)[row]}
    assert len(keys) == 26 and keys[word.text[0]]["start"]

    await h.click(Hud, "press", key=word.text[0])
    await h.advance(frames=1)
    assert h.get(Run).target == entity and word.typed == 1
    keys = {k["key"]: k for row in ("keys_1", "keys_2", "keys_3") for k in h.panel_state(Hud)[row]}
    assert keys[word.text[1]]["next"]

    for letter in word.text[1:]:
        await h.click(Hud, "press", key=letter)
    await h.advance(frames=1)
    assert not entity.alive and h.get(Run).cleared == 1
