from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stocks: the prefab spawns and its model's controls work")
async def test_stocks(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stocks, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("upper_board", 47.5)
    assert abs(model.joint("upper_board") - 47.5) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
