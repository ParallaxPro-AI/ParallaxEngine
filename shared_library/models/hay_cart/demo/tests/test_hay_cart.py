from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hay_cart: the prefab spawns and its model's controls work")
async def test_hay_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hay_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tailgate", 50.0)
    assert abs(model.joint("tailgate") - 50.0) < 1e-3
    model.set_option("load", "empty")
    assert model.option("load") == "empty"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
