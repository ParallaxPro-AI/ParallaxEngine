from parallax.grid import GridCell
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Scenes

from game.actions import Controls
from game.components import Bot
from game.events import LevelSolved
from game.resources import Attempt, Records, Shift
from game.ui import Hud, PauseMenu, ResultPanel, TitleScreen


def bot_cell(h: GameHarness) -> Cell:
    return h.world.query(tagged=Bot).single().get(GridCell).cell


@playtest("one push docks First Haul's crate and the shift moves on")
async def first_haul(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    await h.press(Controls.right)
    assert len(h.emitted(LevelSolved)) == 1

    await h.advance(seconds=1)
    assert h.get(Shift).level_index == 1
    assert h.get(Shift).total_moves == 1
    assert h.get(Records).resume_level == 1


@playtest("undo walks the bot back and takes the move off the count")
async def undo_walk(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    start = bot_cell(h)
    await h.press(Controls.left)
    assert bot_cell(h) == start + Cell.LEFT
    assert h.get(Attempt).moves == 1

    await h.click(Hud, "undo")
    assert bot_cell(h) == start
    assert h.get(Attempt).moves == 0
    assert h.get(Attempt).redo == ["l"]


@playtest("a solved level ignores the HUD's Reset while it lingers")
async def solved_level_is_locked(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    await h.press(Controls.right)
    await h.click(Hud, "reset")
    await h.advance(seconds=1)
    assert h.get(Shift).level_index == 1
    assert h.get(Shift).total_moves == 1


@playtest("Continue resumes the shift at the saved level")
async def continue_shift(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=1)
    h.get(Records).resume_level = 3
    await h.click(TitleScreen, "play")
    await h.advance(frames=2)
    assert h.get(Shift).level_index == 3
    assert h.get(Shift).started_at == 3


@playtest("Menu from the shift result leads to a clean title screen")
async def back_to_title(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    h.get(Shift).complete = True
    await h.advance(frames=1)
    await h.click(ResultPanel, "quit")
    await h.advance(frames=2)
    assert not h.is_open(ResultPanel)

    await h.press(Controls.pause)
    assert not h.is_open(PauseMenu)
