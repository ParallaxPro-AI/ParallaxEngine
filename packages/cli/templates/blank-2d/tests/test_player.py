"""Playtests run headless and deterministic: `parallax test .`"""

from parallax import vec2
from parallax.test import GameHarness, playtest
from project import Placed, Scenes

from game.actions import Controls
from game.ui import Hud


@playtest("the player moves right while the stick is pushed right")
async def test_player_moves(h: GameHarness):
    await h.start(scene=Scenes.main)
    player = h.world.placed(Placed.player)
    start_x = player.transform.position.x
    await h.move(Controls.move, vec2(1, 0), seconds=0.5)
    assert player.transform.position.x > start_x + 1


@playtest("the player stops at the edge of the play area")
async def test_player_stays_inside(h: GameHarness):
    await h.start(scene=Scenes.main)
    await h.move(Controls.move, vec2(0, 1), seconds=5)
    y = h.world.placed(Placed.player).transform.position.y
    assert 4.4 < y <= 4.5


@playtest("the HUD is up")
async def test_hud(h: GameHarness):
    await h.start(scene=Scenes.main)
    assert h.is_open(Hud)
