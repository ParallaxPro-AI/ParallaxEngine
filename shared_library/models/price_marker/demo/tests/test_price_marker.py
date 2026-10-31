from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("price_marker: the prefab spawns and its model's controls work")
async def test_price_marker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.price_marker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arrow", 90.0)
    assert abs(model.joint("arrow") - 90.0) < 1e-3
    model.set_option("mood", "rising")
    assert model.option("mood") == "rising"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
