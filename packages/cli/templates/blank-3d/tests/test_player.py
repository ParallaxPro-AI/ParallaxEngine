"""Playtests run headless and deterministic: `parallax test .`"""

from parallax import vec2
from parallax.test import GameHarness, playtest
from project import Placed, Scenes

from game.actions import Controls
from game.ui import Hud


@playtest("pushing the stick up moves the player forward (+z) along the ground")
async def test_player_moves(h: GameHarness):
    await h.start(scene=Scenes.main)
    player = h.world.placed(Placed.player)
    start = player.transform.position
    await h.move(Controls.move, vec2(0, 1), seconds=0.5)
    now = player.transform.position
    assert now.z > start.z + 1
    assert now.y == start.y


@playtest("the player stops at the edge of the ground")
async def test_player_stays_inside(h: GameHarness):
    await h.start(scene=Scenes.main)
    await h.move(Controls.move, vec2(1, 0), seconds=5)
    x = h.world.placed(Placed.player).transform.position.x
    assert 8.9 < x <= 9


@playtest("the HUD is up")
async def test_hud(h: GameHarness):
    await h.start(scene=Scenes.main)
    assert h.is_open(Hud)
