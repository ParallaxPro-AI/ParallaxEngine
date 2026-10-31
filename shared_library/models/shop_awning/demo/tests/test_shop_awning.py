from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shop_awning: the prefab spawns and its model's controls work")
async def test_shop_awning(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shop_awning, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("canopy", 0.54)
    assert abs(model.joint("canopy") - 0.54) < 1e-3
    model.set_option("stripes", "green")
    assert model.option("stripes") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
