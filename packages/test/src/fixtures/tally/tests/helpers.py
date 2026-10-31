"""Shared steps (not a test module: no test_ prefix)."""

from parallax import Game
from parallax.test import GameHarness
from project import Scenes

from game.actions import Controls


async def into_arena(game: GameHarness, seed: int = 1) -> None:
    await game.start(scene=Scenes.arena, seed=seed)


async def bump_times(game: GameHarness, count: int) -> None:
    for _ in range(count):
        await game.press(Controls.bump)
