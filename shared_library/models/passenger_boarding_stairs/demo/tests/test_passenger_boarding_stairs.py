from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("passenger_boarding_stairs: the prefab spawns and its model's controls work")
async def test_passenger_boarding_stairs(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.passenger_boarding_stairs, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("body_colour", "white")
    assert model.option("body_colour") == "white"
    assert model.socket_position("tow_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
