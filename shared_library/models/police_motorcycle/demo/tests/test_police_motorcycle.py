from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("police_motorcycle: the prefab spawns and its model's controls work")
async def test_police_motorcycle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.police_motorcycle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steer", 0.0)
    assert abs(model.joint("steer") - 0.0) < 1e-3
    model.set_option("livery", "black")
    assert model.option("livery") == "black"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
