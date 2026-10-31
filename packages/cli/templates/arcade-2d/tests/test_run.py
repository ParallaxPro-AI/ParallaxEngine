"""Playtests run headless and deterministic: `parallax test .`"""

from parallax import vec2
from parallax.test import GameHarness, playtest
from project import Placed, Prefabs, Scenes

from game.actions import Controls
from game.components import Rock
from game.resources import Best, Run
from game.ui import GameOver, Hud


async def drop_rock_on_player(h: GameHarness) -> None:
    """Spawn a rock just above the player and wait for the game over card."""
    player = h.world.placed(Placed.player).transform.position
    h.world.spawn(Prefabs.rock, at=vec2(player.x, player.y + 1.5))
    await h.advance_until(lambda: h.is_open(GameOver), timeout=2)


@playtest("the score counts up while you survive, and rocks start falling")
async def test_score_counts(h: GameHarness):
    await h.start(scene=Scenes.main)
    await h.advance(seconds=1.5)
    assert h.panel_state(Hud)["score"] == 1
    assert h.world.query(tagged=Rock).count() >= 1


@playtest("the player slides left and right")
async def test_player_moves(h: GameHarness):
    await h.start(scene=Scenes.main)
    player = h.world.placed(Placed.player)
    await h.set_axis(Controls.move, -1, seconds=0.25)
    assert player.transform.position.x < -1


@playtest("a rock hitting the player ends the run and keeps the best score")
async def test_hit_ends_run(h: GameHarness):
    await h.start(scene=Scenes.main)
    await h.advance(seconds=0.1)
    h.get(Run).time = 12
    await drop_rock_on_player(h)
    assert h.get(Run).over
    assert h.get(Best).score == 12
    assert h.panel_state(GameOver)["score"] == 12


@playtest("Retry starts a fresh run and keeps the best score")
async def test_retry(h: GameHarness):
    await h.start(scene=Scenes.main)
    await h.advance(seconds=0.1)
    h.get(Run).time = 7
    await drop_rock_on_player(h)
    await h.click(GameOver, "retry")
    await h.advance(frames=2)
    assert not h.is_open(GameOver)
    assert not h.get(Run).over and h.get(Run).time < 1
    assert h.get(Best).score == 7
