from parallax.test import playtest
from project import Scenes

from game.lib.scene_tags import Playable
from game.main import Ticks


@playtest("a system scoped to Playable runs only in scenes tagged playable")
async def test_scope(game):
    await game.start(scene=Scenes.title)
    await game.advance(frames=10)
    assert game.get(Ticks).frames == 0
    game.ctx.scenes.load(Scenes.level)
    await game.advance(frames=10)
    assert game.get(Ticks).frames > 0
    assert game.ctx.scenes.current_is(Playable)
