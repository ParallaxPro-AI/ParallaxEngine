from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("truck: the prefab spawns and its model's controls work")
async def test_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.truck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_tilt", 26.0)
    assert abs(model.joint("cab_tilt") - 26.0) < 1e-3
    model.set_option("body", "box")
    assert model.option("body") == "box"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
