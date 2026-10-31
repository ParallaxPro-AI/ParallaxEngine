"""The whole shift: all 50 template levels, the intro card, the last level solved with
real key presses, the result card, the record and a new shift."""

from parallax.test import GameHarness, playtest
from project import Scenes

from game.actions import Controls
from game.events import LevelSolved, ShiftCompleted
from game.resources import Attempt, Records, Shift
from game.ui import Hud, ResultPanel, TitleScreen

KEYS = {"u": Controls.up, "d": Controls.down, "l": Controls.left, "r": Controls.right}
LAST_CALL = "ddlldRurrddlUUdllllUU"
"""A shortest solution of level 50 (21 moves, 7 pushes), found by breadth-first search."""


async def play(h: GameHarness, moves: str) -> None:
    for letter in moves:
        await h.press(KEYS[letter.lower()])
        await h.advance(frames=1)


@playtest("the shift is the template's 50 levels, and level 1 introduces itself")
async def fifty_levels(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    await h.advance(frames=1)
    hud = h.panel_state(Hud)
    assert hud["levels"] == 50
    assert hud["level_name"] == "First Haul"
    assert hud["intro"]
    assert hud["crates"] == "0/1"


@playtest("the level card sweeps in for a new level but not after a reset")
async def intro_card(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    await h.press(Controls.left)
    await h.press(Controls.reset)
    await h.advance(frames=2)
    assert not h.get(Attempt).intro

    await h.press(Controls.right)
    await h.advance(seconds=1)
    assert h.get(Shift).level_index == 1
    assert h.get(Attempt).intro


@playtest("solving the last level of a full shift sets the record; New Shift starts over")
async def full_shift_record(h: GameHarness) -> None:
    await h.start(scene=Scenes.yard, seed=1)
    h.get(Shift).level_index = 49
    await h.press(Controls.reset)
    await h.advance(frames=2)
    assert h.panel_state(Hud)["level_name"] == "Last Call"

    await play(h, LAST_CALL)
    assert len(h.emitted(LevelSolved)) == 1
    assert h.panel_state(Hud)["all_docked"]
    await h.until(ShiftCompleted)
    await h.advance(frames=2)
    assert h.is_open(ResultPanel)
    result = h.panel_state(ResultPanel)
    assert result["moves"] == 21
    assert result["new_best"]
    assert h.get(Records).best_moves == 21
    assert h.get(Records).best_levels == 50
    assert h.get(Records).resume_level == 0

    await h.click(ResultPanel, "retry")
    await h.advance(frames=2)
    assert not h.is_open(ResultPanel)
    assert h.get(Shift).level_index == 0
    assert h.get(Shift).total_moves == 0


@playtest("a resumed shift finishes without touching the record")
async def resumed_shift(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=1)
    await h.advance(frames=1)
    assert h.panel_state(TitleScreen)["play_label"] == "Play"
    h.get(Records).resume_level = 49
    await h.advance(frames=1)
    assert h.panel_state(TitleScreen)["play_label"] == "Continue"
    await h.click(TitleScreen, "play")
    await h.advance(frames=2)
    await play(h, LAST_CALL)
    await h.until(ShiftCompleted)
    await h.advance(frames=2)
    assert h.panel_state(ResultPanel)["resumed"]
    assert not h.panel_state(ResultPanel)["new_best"]
    assert h.get(Records).best_moves == 0


@playtest("New Game forgets the resume point")
async def new_game(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=1)
    h.get(Records).resume_level = 12
    await h.click(TitleScreen, "new_game")
    await h.advance(frames=2)
    assert h.get(Shift).level_index == 0
    assert h.get(Shift).started_at == 0
