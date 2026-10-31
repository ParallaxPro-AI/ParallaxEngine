from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("car_carrier: the prefab spawns and its model's controls work")
async def test_car_carrier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.car_carrier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_tilt", 26.0)
    assert abs(model.joint("cab_tilt") - 26.0) < 1e-3
    model.set_option("body", "silver")
    assert model.option("body") == "silver"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
