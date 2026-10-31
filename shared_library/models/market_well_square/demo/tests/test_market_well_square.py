from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("market_well_square: the prefab spawns and its model's controls work")
async def test_market_well_square(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.market_well_square, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rope", 0.55)
    assert abs(model.joint("rope") - 0.55) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
