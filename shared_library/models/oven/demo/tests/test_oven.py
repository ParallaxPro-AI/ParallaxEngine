from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("oven: the prefab spawns and its model's controls work")
async def test_oven(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.oven, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_single", 44.0)
    assert abs(model.joint("door_single") - 44.0) < 1e-3
    model.set_option("config", "double")
    assert model.option("config") == "double"
    assert model.socket_position("socket_rack_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
