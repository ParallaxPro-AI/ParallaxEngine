from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("street_corn_cart: the prefab spawns and its model's controls work")
async def test_street_corn_cart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.street_corn_cart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 50.0)
    assert abs(model.joint("lid") - 50.0) < 1e-3
    model.set_option("panel", "red")
    assert model.option("panel") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
