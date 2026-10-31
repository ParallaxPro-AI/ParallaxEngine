from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("apothecary_shelf: the prefab spawns and its model's controls work")
async def test_apothecary_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.apothecary_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_r1c1", 0.13)
    assert abs(model.joint("drawer_r1c1") - 0.13) < 1e-3
    model.set_option("stock", "empty")
    assert model.option("stock") == "empty"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
