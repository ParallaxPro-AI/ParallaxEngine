from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("warehouse: the prefab spawns and its model's controls work")
async def test_warehouse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.warehouse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("curtain_0", 2.15)
    assert abs(model.joint("curtain_0") - 2.15) < 1e-3
    model.set_option("cladding_colour", "green")
    assert model.option("cladding_colour") == "green"
    assert model.socket_position("socket_dock_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
